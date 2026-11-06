import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { kubeconfigFor, clientsFor, namespaceOf } from '../config.js'
import type { Config as ConfigType } from '../types.js'

type Op = Record<string, any>
type Clients = ReturnType<typeof clientsFor>

const MAX_ERRORS = 20
const CONCURRENCY = 5

/** 把 LabelSelector（matchLabels + matchExpressions）转成 API 的 selector 字符串。 */
function selectorString(selector: Op | undefined): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(selector?.matchLabels ?? {})) {
    parts.push(`${key}=${value}`)
  }
  for (const expr of selector?.matchExpressions ?? []) {
    const values = (expr.values ?? []).join(',')
    switch (expr.operator) {
      case 'In': parts.push(`${expr.key} in (${values})`); break
      case 'NotIn': parts.push(`${expr.key} notin (${values})`); break
      case 'Exists': parts.push(text(expr.key)); break
      case 'DoesNotExist': parts.push(`!${text(expr.key)}`); break
    }
  }
  return parts.join(',')
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

/** 根据工作负载类型取 spec.selector；与 kubectl logs -l 的语义一致。 */
async function selectorOfWorkload(
  clients: Clients,
  kind: string,
  name: string,
  namespace: string,
): Promise<string> {
  const k = kind.toLowerCase()
  switch (k) {
    case 'deployment':
    case 'deploy': {
      const obj = await clients.apps.readNamespacedDeployment({ name, namespace }) as unknown as Op
      return selectorString(obj.spec?.selector)
    }
    case 'statefulset':
    case 'sts': {
      const obj = await clients.apps.readNamespacedStatefulSet({ name, namespace }) as unknown as Op
      return selectorString(obj.spec?.selector)
    }
    case 'daemonset':
    case 'ds': {
      const obj = await clients.apps.readNamespacedDaemonSet({ name, namespace }) as unknown as Op
      return selectorString(obj.spec?.selector)
    }
    case 'replicaset':
    case 'rs': {
      const obj = await clients.apps.readNamespacedReplicaSet({ name, namespace }) as unknown as Op
      return selectorString(obj.spec?.selector)
    }
    case 'job': {
      const obj = await clients.batch.readNamespacedJob({ name, namespace }) as unknown as Op
      return selectorString(obj.spec?.selector)
    }
    default:
      throw new Error(`不支持的工作负载类型 "${kind}"，可用：deployment, statefulset, daemonset, replicaset, job`)
  }
}

/** 按顺序分批并发，避免大集群一次打满 API Server。 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit)
    results.push(...await Promise.all(chunk.map(fn)))
  }
  return results
}

export function registerMultiLogTools(ctx: Context, config: ConfigType): void {
  ctx.tools.register(defineTool({
    name: 'k8s_read_pod_logs_multi',
    description: '按工作负载或 labelSelector 批量读取多个 Pod 的日志（只读，等价于 stern / kubectl logs -l，但不需要外部命令）。'
      + '不指定 container 时读取每个 Pod 的所有容器；单次默认最多 20 个 Pod。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
      namespace: { type: 'string', description: '命名空间，缺省为 default。' },
      kind: { type: 'string', description: '工作负载类型：deployment | statefulset | daemonset | replicaset | job。' },
      name: { type: 'string', description: '工作负载名称；与 labelSelector 二选一，kind 需要 name。' },
      labelSelector: { type: 'string', description: '直接指定标签选择器，例如 app=api,tier=backend。' },
      container: { type: 'string', description: '只读取指定容器；不填则读取每个 Pod 的所有容器。' },
      sinceSeconds: { type: 'integer', description: '只读取最近 N 秒的日志。' },
      tailLines: { type: 'integer', description: '每个容器读取的尾部行数，缺省 100。' },
      timestamps: { type: 'boolean', description: '是否在每行前附带时间戳，缺省 false。' },
      maxPods: { type: 'integer', description: '最多读取多少个 Pod，缺省 20。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          logs: { type: 'string', required: true },
          pods: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          errors: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const parts: string[] = []
        if (value.logs) parts.push(value.logs)
        if (value.errors && value.errors.length > 0) {
          parts.push(`[读取失败的容器]\n${value.errors.map(e => `- ${e}`).join('\n')}`)
        }
        if (!value.logs && (!value.errors || value.errors.length === 0)) {
          parts.push('（未读取到日志）')
        }
        return [{ type: 'text', text: parts.join('\n\n') }]
      },
    },
    execute: async (args) => {
      const clients = clientsFor(kubeconfigFor(config, args.cluster))
      const namespace = namespaceOf(args.namespace)
      const maxPods = args.maxPods ?? 20
      const errors: string[] = []

      let selector = (args.labelSelector ?? '').trim()
      if (!selector) {
        if (!args.kind || !args.name) {
          throw new Error('请提供 labelSelector，或同时提供 kind 与 name。')
        }
        selector = await selectorOfWorkload(clients, args.kind, args.name, namespace)
        if (!selector) {
          throw new Error(`${args.kind}/${args.name} 的 spec.selector 为空，无法定位 Pod。`)
        }
      }

      const podRes = await clients.core.listNamespacedPod({ namespace, labelSelector: selector }) as unknown as Op
      let pods: Op[] = (podRes.items ?? []).filter((p: Op) => p.status?.phase !== 'Succeeded')
      pods.sort((a, b) => text(a.metadata?.name).localeCompare(text(b.metadata?.name)))
      const total = pods.length
      const truncated = total > maxPods
      if (truncated) {
        errors.push(`匹配到 ${total} 个 Pod，只读取前 ${maxPods} 个（可用 maxPods 调整）。`)
        pods = pods.slice(0, maxPods)
      }

      const declaredContainers = pods.map(p => (p.spec?.containers ?? []).map((c: Op) => text(c.name)))
      const totalContainers = declaredContainers.reduce((sum, names) => sum + names.length, 0)
      const showPrefix = pods.length > 1 || totalContainers > 1
      const tailLines = args.tailLines ?? 100

      const blocks = await mapLimit(pods, CONCURRENCY, async (pod) => {
        const podName = text(pod.metadata?.name)
        const names: string[] = (pod.spec?.containers ?? []).map((c: Op) => text(c.name)).filter(Boolean)
        const targets = args.container ? names.filter(n => n === args.container) : names
        if (args.container && targets.length === 0) {
          if (errors.length < MAX_ERRORS) errors.push(`${podName}: 没有名为 ${args.container} 的容器（现有：${names.join(',') || '无'}）`)
          return ''
        }
        if (targets.length === 0) return ''

        const sections = await Promise.all(targets.map(async (container) => {
          try {
            const logs = await clients.core.readNamespacedPodLog({
              name: podName,
              namespace,
              container,
              sinceSeconds: args.sinceSeconds,
              tailLines,
              timestamps: args.timestamps,
            })
            const body = text(logs).replace(/\n+$/, '')
            if (!body) return ''
            if (!showPrefix) return body
            return body.split('\n').map(line => `[${podName}/${container}] ${line}`).join('\n')
          } catch (error) {
            if (errors.length < MAX_ERRORS) {
              errors.push(`${podName}/${container}: ${(error as Error).message}`)
            }
            return ''
          }
        }))
        return sections.filter(Boolean).join('\n')
      })

      return {
        logs: blocks.filter(Boolean).join('\n'),
        pods: pods.length,
        truncated,
        errors,
      }
    },
  }))
}
