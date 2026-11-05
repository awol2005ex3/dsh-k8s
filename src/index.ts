import { Context } from '@deepseek-ai/cordis'
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as k8s from '@kubernetes/client-node'

/**
 * One configured Kubernetes cluster: a display name plus the full kubeconfig
 * text (YAML). The optional `context` overrides kubeconfig `current-context`.
 * Fields are readonly because a volatile snapshot is immutable.
 */
export interface ClusterConfig {
  readonly name: string
  readonly kubeconfig: string
  readonly context?: string
}

/** Model-facing `dsh-k8s` plugin configuration (renders as a settings form). */
export interface Config {
  /** `.volatile()` 使集群字段进入「设置→插件」表单并可热改（dsh 只渲染 volatile 字段）。 */
  clusters: Volatile<ClusterConfig[]>
}

/** 解包 volatile 引用；兼容旧 dsh（普通数组）与测试替身。 */
function unwrap(config: Config): readonly ClusterConfig[] {
  const v = config.clusters
  const ref = v as unknown as { get?: () => readonly ClusterConfig[] } | undefined
  if (typeof ref?.get === 'function') {
    try { return ref.get() } catch { return [] }
  }
  return v as unknown as readonly ClusterConfig[]
}

const clusterEntry = z.object({
  name: z.string().required().description('唯一集群标识，例如 prod-cluster。'),
  kubeconfig: z.string().required().role('textarea').description('该集群的 kubeconfig 字符串，粘贴完整 YAML。'),
  context: z.string().description('可选：覆盖 kubeconfig 的 current-context。'),
})

/** Schemastery config carrier; the cluster list renders as a settings form. */
export const Config = z.object({
  // `.volatile()` 让集群字段进入「设置→插件」表单并可热改。dsh 的 settings 表单只
  // 渲染带 `.volatile()` 的字段，缺了它集群配置页不会展示。
  clusters: z.array(clusterEntry).default([]).volatile(),
}) as z<Config>

/**
 * Minimal typing for the promise-based API wrapper `makeApiClient` returns.
 * With `@kubernetes/client-node` v1, `CoreV1Api` is the object-arg API: methods
 * accept one options object and resolve the resource list / string directly.
 */
interface KubeCoreClient {
  listNode(opts: Record<string, unknown>): Promise<{ items: unknown[] }>
  listNamespacedPod(opts: { namespace: string } & Record<string, unknown>): Promise<{ items: unknown[] }>
  readNamespacedPodLog(opts: { name: string; namespace: string; tailLines?: number }): Promise<string>
}

function makeCoreV1(client: k8s.KubeConfig): KubeCoreClient {
  return client.makeApiClient(k8s.CoreV1Api) as unknown as KubeCoreClient
}

function listNames(clusters: readonly ClusterConfig[]): string {
  return clusters.length === 0 ? '（无）' : clusters.map((c) => c.name).join('、')
}

/** Resolve a cluster to a prepared KubeConfig, throwing on unknown/invalid config. */
function clientFor(config: Config, name: string): k8s.KubeConfig {
  const clusters = unwrap(config)
  const entry = clusters.find((c) => c.name === name)
  if (!entry) throw new Error(`未配置集群 "${name}"，请在 设置→插件 中添加。已知集群：${listNames(clusters)}`)
  const kc = new k8s.KubeConfig()
  try {
    kc.loadFromString(entry.kubeconfig)
  } catch (error) {
    throw new Error(`集群 "${name}" 的 kubeconfig 无法解析：${(error as Error).message}`)
  }
  if (entry.context) {
    if (!kc.getContexts().some((c) => c.name === entry.context)) {
      throw new Error(`集群 "${name}" 指定的 context "${entry.context}" 不存在`)
    }
    kc.setCurrentContext(entry.context)
  }
  return kc
}

/** Cordis plugin name. */
export const name = 'dsh-k8s'

/** Host services required by this plugin. */
export const inject = ['tools'] as const

/** Register the `dsh-k8s` tools on the injected tools service. */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'k8s_list_clusters',
    description: '列出已配置的 Kubernetes 集群及其 server 与当前 context。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          clusters: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                server: { type: 'string' },
                context: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.clusters.length === 0
        ? '未配置任何集群'
        : value.clusters.map((c) => `• ${c.name}  (${c.server}, context=${c.context})`).join('\n') }],
    },
    execute: async () => {
      const kc = new k8s.KubeConfig()
      const clusters: Array<{ name: string; server: string; context: string }> = []
      for (const entry of unwrap(config)) {
        try {
          kc.loadFromString(entry.kubeconfig)
          clusters.push({
            name: entry.name,
            server: kc.getCurrentCluster()?.server ?? '(解析失败)',
            context: entry.context ?? kc.getCurrentContext(),
          })
        } catch {
          clusters.push({ name: entry.name, server: '(kubeconfig 无法解析)', context: '(未知)' })
        }
      }
      return { clusters }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'k8s_test_connection',
    description: '测试与指定 Kubernetes 集群的连接，返回 server 地址与节点数。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          server: { type: 'string' },
          nodeCount: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.ok
        ? `连接成功：server=${value.server}，${value.nodeCount} 个节点`
        : `连接失败：${value.error}` }],
    },
    execute: async (args) => {
      try {
        const kc = clientFor(config, args.cluster)
        const core = makeCoreV1(kc)
        const nodes = await core.listNode({})
        return { ok: true, server: kc.getCurrentCluster()?.server ?? '', nodeCount: nodes.items.length, error: '' }
      } catch (error) {
        return { ok: false, server: '', nodeCount: 0, error: (error as Error).message }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'k8s_list_nodes',
    description: '列出指定 Kubernetes 集群的节点及其就绪状态、角色与版本。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          nodes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                ready: { type: 'string' },
                version: { type: 'string' },
                internalIP: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.nodes.length === 0
        ? '（无节点）'
        : value.nodes.map((n) => `${n.name}  ready=${n.ready}  v=${n.version}  ip=${n.internalIP}`).join('\n') }],
    },
    execute: async (args) => {
      const core = makeCoreV1(clientFor(config, args.cluster))
      const res = await core.listNode({})
      const nodes = res.items.map((raw) => {
        const node = raw as {
          metadata?: { name?: string }
          status?: {
            conditions?: Array<{ type?: string; status?: string }>
            addresses?: Array<{ type?: string; address?: string }>
            nodeInfo?: { kubeletVersion?: string }
          }
        }
        const ready = node.status?.conditions?.find((c) => c.type === 'Ready')?.status ?? 'Unknown'
        return {
          name: node.metadata?.name ?? '',
          ready: ready === 'True' ? 'Ready' : ready,
          version: node.status?.nodeInfo?.kubeletVersion ?? '',
          internalIP: node.status?.addresses?.find((a) => a.type === 'InternalIP')?.address ?? '',
        }
      })
      return { nodes }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'k8s_list_pods',
    description: '列出指定集群某命名空间的 Pod（缺省 default），含运行阶段与重启次数。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
      namespace: { type: 'string', description: '命名空间，缺省为 default。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pods: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                namespace: { type: 'string' },
                phase: { type: 'string' },
                restarts: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.pods.length === 0
        ? '（无 Pod）'
        : value.pods.map((p) => `${p.name}  ns=${p.namespace}  phase=${p.phase}  restarts=${p.restarts}`).join('\n') }],
    },
    execute: async (args) => {
      const core = makeCoreV1(clientFor(config, args.cluster))
      const namespace = args.namespace ?? 'default'
      const res = await core.listNamespacedPod({ namespace })
      const pods = res.items.map((raw) => {
        const pod = raw as {
          metadata?: { name?: string; namespace?: string }
          status?: { phase?: string; containerStatuses?: Array<{ restartCount?: number }> }
        }
        const restarts = pod.status?.containerStatuses?.reduce((sum, c) => sum + (c.restartCount ?? 0), 0) ?? 0
        return { name: pod.metadata?.name ?? '', namespace: pod.metadata?.namespace ?? namespace, phase: pod.status?.phase ?? '', restarts }
      })
      return { pods }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'k8s_read_pod_logs',
    description: '读取指定集群某 Pod 的日志（默认最近 200 行）。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
      namespace: { type: 'string', description: '命名空间，缺省为 default。' },
      pod: { type: 'string', required: true, description: 'Pod 名称。' },
      tailLines: { type: 'integer', description: '读取的尾部行数，缺省 200。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          logs: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.logs || '（日志为空）' }],
    },
    execute: async (args) => {
      const core = makeCoreV1(clientFor(config, args.cluster))
      const namespace = args.namespace ?? 'default'
      const logs = await core.readNamespacedPodLog({ name: args.pod, namespace, tailLines: args.tailLines ?? 200 })
      return { logs }
    },
  }))
}