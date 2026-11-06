import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import * as k8s from '@kubernetes/client-node'
import { kubeconfigFor } from '../config.js'
import type { Config as ConfigType } from '../types.js'

type Op = Record<string, any>

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

/** 用 KubeConfig 的 applyToFetchOptions 走 raw HTTP，取 /api/v1/componentstatuses。 */
type FetchOpts = Parameters<k8s.KubeConfig['applyToFetchOptions']>[0]

async function fetchComponentStatuses(kc: k8s.KubeConfig): Promise<Op[]> {
  const cluster = kc.getCurrentCluster()
  if (!cluster?.server) throw new Error('无当前集群配置')
  const url = new URL('/api/v1/componentstatuses', cluster.server)
  const init: FetchOpts = { method: 'GET' }
  await kc.applyToFetchOptions(init)
  const rawHeaders = (init.headers ?? {}) as Record<string, string | number | readonly string[] | undefined>
  const headers = new Headers()
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const v of value) headers.append(key, v)
    else headers.set(key, String(value))
  }
  const res = await fetch(url, { method: 'GET', headers })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as Op
  return (body.items ?? []) as Op[]
}

export function registerComponentStatusTools(ctx: Context, config: ConfigType): void {
  ctx.tools.register(defineTool({
    name: 'k8s_get_component_status',
    description: '读取集群组件状态（/api/v1/componentstatuses，只读）。'
      + '注意：该 API 在 Kubernetes 1.19+ 已弃用，部分集群返回空或直接报错，属预期行为。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          available: { type: 'boolean', required: true },
          components: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string' }, status: { type: 'string' },
                message: { type: 'string' }, error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (!value.available) {
          return [{ type: 'text', text: '该集群不支持 componentstatuses API（1.19+ 已弃用）。' }]
        }
        if (value.components.length === 0) {
          return [{ type: 'text', text: '集群没有报告任何组件状态（componentstatuses 在 1.19+ 已弃用）。' }]
        }
        return [{ type: 'text', text: value.components.map(c =>
          `• ${c.name}  status=${c.status || '-'}${c.message ? `  msg=${c.message}` : ''}${c.error ? `  error=${c.error}` : ''}`,
        ).join('\n') }]
      },
    },
    execute: async (args) => {
      const kc = kubeconfigFor(config, args.cluster)
      let available = false
      let components: Op[] = []
      try {
        components = await fetchComponentStatuses(kc)
        available = true
      } catch {
        available = false
      }
      return {
        available,
        components: components.map((item) => {
          const conds: Op[] = item.conditions ?? []
          const unhealthy = conds.find((c: Op) => c.status !== 'True')
          const healthy = conds.find((c: Op) => c.status === 'True')
          return {
            name: text(item.metadata?.name),
            status: unhealthy ? 'Unhealthy' : healthy ? 'Healthy' : 'Unknown',
            message: text(unhealthy?.message ?? healthy?.message),
            error: text(unhealthy?.error),
          }
        }),
      }
    },
  }))
}