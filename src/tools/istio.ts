import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { kubeconfigFor, clientsFor, namespaceOf } from '../config.js'
import type { Config as ConfigType } from '../types.js'

type Op = Record<string, any>
type Clients = ReturnType<typeof clientsFor>

const GROUP = 'networking.istio.io'
const VIRTUAL_SERVICE = 'virtualservices'
const GATEWAY = 'gateways'
const DESTINATION_RULE = 'destinationrules'

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

function uniq(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))]
}

/** 列出 istio 自定义资源（命名空间范围或集群范围）。 */
async function listIstio(clients: Clients, plural: string, version: string, namespace?: string): Promise<Op[]> {
  const res = namespace
    ? await clients.customObjects.listNamespacedCustomObject({
        group: GROUP, version, namespace: namespaceOf(namespace), plural,
      })
    : await clients.customObjects.listClusterCustomObject({ group: GROUP, version, plural })
  return ((res as { items?: unknown[] }).items ?? []) as unknown as Op[]
}

/** host 匹配（精确或 *. 通配符前缀）。 */
function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase().replace(/\.$/, '')
  const h = host.toLowerCase().replace(/\.$/, '')
  if (p === h) return true
  if (p.startsWith('*.')) {
    return h.endsWith(`.${p.slice(2)}`) || h === p.slice(2)
  }
  return false
}

/** 把一条 http 规则压成一行。 */
function describeHttp(http: Op): string {
  const parts: string[] = []
  if (http.match?.length) {
    const conds = http.match
      .map((m: Op) => Object.entries(m.uri ?? {}).map(([k, v]) => `${k}:"${v}"`).join(' '))
      .filter(Boolean)
    if (conds.length) parts.push(`match=[${conds.join(' | ')}]`)
  }
  if (http.redirect) parts.push(`redirect→${text(http.redirect.uri)}`)
  if (http.rewrite) parts.push(`rewrite→${text(http.rewrite.uri)}`)
  if (http.route?.length) {
    const routes = http.route.map((r: Op) => {
      const dest = r.destination
      if (!dest) return '(no dest)'
      const port = dest.port?.number ? `:${dest.port.number}` : ''
      const weight = r.weight !== undefined ? ` w=${r.weight}` : ''
      return `${text(dest.host)}${port}${dest.subset ? ` (${text(dest.subset)})` : ''}${weight}`
    }).join(', ')
    parts.push(`route→${routes}`)
  }
  return parts.join('  ')
}

export function registerIstioTools(ctx: Context, config: ConfigType): void {
  ctx.tools.register(defineTool({
    name: 'k8s_trace_istio',
    description: '追踪 Istio 服务网格链路（只读）：按 host 匹配 VirtualService → 其路由到的 Service（含 DestinationRule 子集/权重）'
      + '与引用的 Gateway。用于排查 Istio 网格里 404 / 503 / 路由未命中问题。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
      host: { type: 'string', description: '目标 host，例如 my-svc.default.svc.cluster.local；可省略，列出全部。' },
      namespace: { type: 'string', description: '只在指定命名空间内查找；不填则所有命名空间。' },
      includeVsWithoutHost: { type: 'boolean', description: '是否包含没有 host 的 VirtualService（default route），缺省 false。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          chains: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                namespace: { type: 'string' }, virtualService: { type: 'string' },
                hosts: { type: 'string' }, gateways: { type: 'string' },
                http: { type: 'array', items: { type: 'string' } },
                destinations: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.chains.length === 0) {
          return [{ type: 'text', text: '未找到匹配的 Istio VirtualService。' }]
        }
        const lines: string[] = []
        for (const chain of value.chains) {
          lines.push(`• ${chain.namespace}/${chain.virtualService}`)
          lines.push(`  hosts=${chain.hosts || '-'}`)
          lines.push(`  gateways=${chain.gateways || '-'}`)
          for (const h of chain.http ?? []) lines.push(`  http: ${h}`)
          for (const d of chain.destinations ?? []) lines.push(`  destination: ${d}`)
          lines.push('')
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args) => {
      const clients = clientsFor(kubeconfigFor(config, args.cluster))
      const namespace = args.namespace ? namespaceOf(args.namespace) : undefined
      const targetHost = (args.host ?? '').trim().toLowerCase()

      // 探测 CRD 版本
      let version = 'v1alpha3'
      try {
        const crd = await clients.apiextensions.readCustomResourceDefinition({
          name: 'virtualservices.networking.istio.io',
        }) as unknown as Op
        const served = (crd.spec?.versions ?? []).find((v: Op) => v.served)
        if (served) version = served.name
      } catch {
        // 用默认版本兜底
      }

      const vsList = await listIstio(clients, VIRTUAL_SERVICE, version, namespace)
      const gwList = namespace
        ? await listIstio(clients, GATEWAY, version, namespace).catch(() => [])
        : await listIstio(clients, GATEWAY, version).catch(() => [])
      const drList = namespace
        ? await listIstio(clients, DESTINATION_RULE, version, namespace).catch(() => [])
        : await listIstio(clients, DESTINATION_RULE, version).catch(() => [])

      const gwByName = new Map(gwList.map((g: Op) => [text(g.metadata?.name), text(g.metadata?.namespace)]))

      const chains: Op[] = []
      for (const vs of vsList) {
        const hosts: string[] = (vs.spec?.hosts ?? []).map((h: string) => text(h))
        const gateways: string[] = (vs.spec?.gateways ?? []).map((g: string) => text(g))
        const ns = text(vs.metadata?.namespace)

        let matched = false
        if (targetHost) {
          matched = hosts.some(h => hostMatches(h, targetHost))
          if (!matched && args.includeVsWithoutHost && hosts.length === 0) matched = true
        } else {
          matched = true
        }
        if (!matched) continue

        const httpLines: string[] = []
        const destinations: string[] = []
        for (const http of vs.spec?.http ?? []) {
          httpLines.push(describeHttp(http))
          for (const route of http.route ?? []) {
            const dest = route.destination
            if (!dest) continue
            const hostName = text(dest.host)
            const port = dest.port?.number ? `:${dest.port.number}` : ''
            let line = `${hostName}${port}`
            if (dest.subset) {
              const dr = drList.find((d: Op) => {
                if (text(d.metadata?.name) === dest.subset && text(d.spec?.host) === hostName) return true
                return (d.spec?.subsets ?? []).some((s: Op) => text(s.name) === dest.subset && text(d.spec?.host) === hostName)
              })
              if (dr) {
                const subset = (dr.spec?.subsets ?? []).find((s: Op) => text(s.name) === dest.subset)
                const labels = subset ? ` labels=${JSON.stringify(subset.labels ?? {})}` : ''
                line += ` (subset=${text(dest.subset)}${labels})`
              } else {
                line += ` (subset=${text(dest.subset)})`
              }
            }
            if (route.weight !== undefined) line += ` weight=${route.weight}`
            destinations.push(line)
          }
        }

        const gwNames = gateways.map((g: string) => {
          const name = g.split('/').pop() ?? g
          const gwNs = g.includes('/') ? g.split('/')[0] : gwByName.get(name) ?? ns
          return `${gwNs}/${name}`
        })

        chains.push({
          namespace: ns,
          virtualService: text(vs.metadata?.name),
          hosts: uniq(hosts).join(','),
          gateways: uniq(gwNames).join('; '),
          http: httpLines,
          destinations: uniq(destinations),
        })
      }

      return { chains }
    },
  }))
}