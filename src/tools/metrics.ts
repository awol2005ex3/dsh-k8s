import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import * as k8s from '@kubernetes/client-node'
import { kubeconfigFor, namespaceOf } from '../config.js'
import type { Config as ConfigType } from '../types.js'
import { renderList } from '../helpers.js'

export function registerMetricsTools(ctx: Context, config: ConfigType): void {
  ctx.tools.register(defineTool({
    name: 'k8s_read_metrics',
    description: '读取 Metrics Server 指标（需集群已安装 metrics-server，否则报错）。只读。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
      namespace: { type: 'string', description: 'pods 类型的命名空间，缺省 default。' },
      type: { type: 'string', description: '指标类型：pods | nodes（缺省 pods）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          metrics: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string' }, namespace: { type: 'string' },
                cpu: { type: 'string' }, memory: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [renderList(
        value.metrics.map(m => `• ${m.name}  ns=${m.namespace}  cpu=${m.cpu}  mem=${m.memory}`),
        '（无指标）',
      )],
    },
    execute: async (args) => {
      const kc = kubeconfigFor(config, args.cluster)
      const metrics = new k8s.Metrics(kc)
      const type = args.type ?? 'pods'
      if (type === 'nodes') {
        const res = await metrics.getNodeMetrics()
        return {
          metrics: res.items.map(n => ({
            name: n.metadata.name, namespace: '',
            cpu: `${Math.round(parseCpu(n.usage.cpu))}m`,
            memory: formatMemory(parseMemory(n.usage.memory)),
          })),
        }
      }
      const res = await metrics.getPodMetrics(namespaceOf(args.namespace))
      return {
        metrics: res.items.map(p => {
          const cpu = p.containers.reduce((sum, c) => sum + parseCpu(c.usage.cpu), 0)
          const memoryKi = p.containers.reduce((sum, c) => sum + parseMemory(c.usage.memory), 0)
          return {
            name: p.metadata.name,
            namespace: p.metadata.namespace,
            cpu: `${Math.round(cpu)}m`,
            memory: formatMemory(memoryKi),
          }
        }),
      }
    },
  }))
}

/** Ki → 人类可读（>=1024Ki 用 Mi）。 */
function formatMemory(ki: number): string {
  return ki >= 1024 ? `${Math.round(ki / 1024)}Mi` : `${Math.round(ki)}Ki`
}

/** '100n' / '250m' / '1' → 毫核。 */
function parseCpu(v: string): number {
  if (v.endsWith('n')) return Number(v.slice(0, -1)) / 1e6
  if (v.endsWith('u')) return Number(v.slice(0, -1)) / 1e3
  if (v.endsWith('m')) return Number(v.slice(0, -1))
  return Number(v) * 1000
}

/** '1024Ki' / '1Mi' / '1Gi' → Ki。 */
function parseMemory(v: string): number {
  const m = v.match(/^([\d.]+)(Ki|Mi|Gi|Ti|K|M|G|T)?i?$/)
  if (!m) return Number(v) || 0
  const n = Number(m[1])
  const unit = m[2] ?? ''
  const factor: Record<string, number> = { Ki: 1, Mi: 1024, Gi: 1024 ** 2, Ti: 1024 ** 3, K: 1000 / 1024, M: 1000 ** 2 / 1024, G: 1000 ** 3 / 1024, T: 1000 ** 4 / 1024 }
  return n * (factor[unit] ?? 1 / 1024)
}
