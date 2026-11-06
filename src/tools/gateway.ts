import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { kubeconfigFor, clientsFor } from '../config.js'
import type { Config as ConfigType } from '../types.js'
import { renderList, meta } from '../helpers.js'

/** Gateway API 的 CRD group；具体版本随安装的 CRD 版本自动选择。 */
const GROUP = 'gateway.networking.k8s.io'
const PLURALS = [
  'gatewayclasses',
  'gateways',
  'httproutes',
  'grpcroutes',
  'tcproutes',
  'tlsroutes',
  'udproutes',
  'referencegrants',
  'backendtlspolicies',
] as const

type Op = Record<string, any>

interface GatewayType {
  kind: string
  version: string
  namespaced: boolean
}

/** 从集群的 CRD 里发现 Gateway API 类型，挑选已安装且优先 storage 的版本。 */
async function discoverTypes(apix: ReturnType<typeof clientsFor>['apiextensions']): Promise<Map<string, GatewayType>> {
  const found = new Map<string, GatewayType>()
  const res = await apix.listCustomResourceDefinition({})
  for (const crd of res.items) {
    if (crd.spec.group !== GROUP) continue
    const plural = crd.spec.names.plural
    if (!(PLURALS as readonly string[]).includes(plural)) continue
    const versions = crd.spec.versions ?? []
    const version = versions.find(v => v.served && v.storage) ?? versions.find(v => v.served)
    if (!version) continue
    found.set(plural, {
      kind: crd.spec.names.kind,
      version: version.name,
      namespaced: crd.spec.scope === 'Namespaced',
    })
  }
  return found
}

/** 取某个 condition 的精简状态；非 True 时带上 reason 便于定位。 */
function condition(status: Op | undefined, type: string): string {
  const cond = (status?.conditions ?? []).find((c: Op) => c.type === type)
  if (!cond) return ''
  return cond.status === 'True' ? 'True' : `${cond.status}${cond.reason ? `(${cond.reason})` : ''}`
}

function uniq(values: Array<string | undefined>): string {
  return [...new Set(values.filter((v): v is string => Boolean(v)))].join(',')
}

/** 把不同 Gateway API 类型压成一行摘要。 */
function summarize(plural: string, obj: Op): string {
  const ns = obj.metadata?.namespace ?? ''
  switch (plural) {
    case 'gatewayclasses':
      return [
        `controller=${obj.spec?.controller ?? '-'}`,
        `Accepted=${condition(obj.status, 'Accepted') || '-'}`,
      ].join('  ')
    case 'gateways': {
      const addresses = uniq((obj.status?.addresses ?? []).map((a: Op) => a.value))
      const listeners = (obj.spec?.listeners ?? []).map((l: Op) => `${l.name}:${l.port}`).join(',')
      return [
        `class=${obj.spec?.gatewayClassName ?? '-'}`,
        `listeners=${listeners || '-'}`,
        `addr=${addresses || '-'}`,
        `Accepted=${condition(obj.status, 'Accepted') || '-'}`,
        `Programmed=${condition(obj.status, 'Programmed') || '-'}`,
      ].join('  ')
    }
    case 'httproutes':
    case 'grpcroutes':
    case 'tcproutes':
    case 'tlsroutes':
    case 'udproutes': {
      const hosts = (obj.spec?.hostnames ?? []) as string[]
      const parents = (obj.spec?.parentRefs ?? []).map((p: Op) =>
        `${p.namespace ?? ns}/${p.name}${p.sectionName ? `:${p.sectionName}` : ''}`)
      const backends = (obj.spec?.rules ?? []).flatMap((rule: Op) =>
        (rule.backendRefs ?? []).map((b: Op) =>
          `${b.namespace ?? ns}/${b.kind ?? 'Service'}/${b.name}${b.port ? `:${b.port}` : ''}`))
      const accepted = uniq((obj.status?.parents ?? []).map((p: Op) => condition(p, 'Accepted')))
      return [
        `hosts=${hosts.join(',') || '-'}`,
        `parents=${uniq(parents) || '-'}`,
        `backends=${uniq(backends) || '-'}`,
        `Accepted=${accepted || '-'}`,
      ].join('  ')
    }
    case 'referencegrants': {
      const from = (obj.spec?.from ?? []).map((f: Op) => `${f.namespace}/${f.kind}`)
      const to = (obj.spec?.to ?? []).map((t: Op) => `${t.kind}${t.name ? `/${t.name}` : ''}`)
      return `from=${uniq(from) || '-'}  to=${uniq(to) || '-'}`
    }
    case 'backendtlspolicies': {
      const targets = (obj.spec?.targetRefs ?? []).map((t: Op) => `${t.kind}/${t.name}`)
      return `targets=${uniq(targets) || '-'}`
    }
    default:
      return ''
  }
}

export function registerGatewayTools(ctx: Context, config: ConfigType): void {
  ctx.tools.register(defineTool({
    name: 'k8s_list_gateway_api',
    description: '查看 Gateway API（gateway.networking.k8s.io）资源：GatewayClass / Gateway / HTTPRoute / GRPCRoute / TCPRoute / TLSRoute / UDPRoute / ReferenceGrant / BackendTLSPolicy。自动发现集群实际安装的 CRD 与版本；kind 缺省 all。只读。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
      kind: {
        type: 'string',
        description: '资源类型（复数）：' + PLURALS.join(' | ') + '；缺省 all',
      },
      namespace: { type: 'string', description: '命名空间；不填则读取所有命名空间（不影响集群级资源）。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          installed: { type: 'boolean', required: true },
          available: { type: 'string', required: true },
          resources: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                kind: { type: 'string' }, name: { type: 'string' }, namespace: { type: 'string' },
                summary: { type: 'string' }, created: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [renderList(
        value.resources.map(r => [
          `• ${r.kind}/${r.name}`,
          r.namespace ? `ns=${r.namespace}` : '',
          r.summary,
          `created=${r.created}`,
        ].filter(Boolean).join('  ')),
        value.installed
          ? `（未发现 Gateway API 资源；已安装类型：${value.available || '无'}）`
          : '集群未安装 Gateway API（gateway.networking.k8s.io CRD 不存在）',
      )],
    },
    execute: async (args) => {
      const kind = args.kind ?? 'all'
      if (kind !== 'all' && !(PLURALS as readonly string[]).includes(kind)) {
        throw new Error(`不支持的 Gateway API 类型 "${kind}"，可用：${['all', ...PLURALS].join(', ')}`)
      }
      const clients = clientsFor(kubeconfigFor(config, args.cluster))
      const types = await discoverTypes(clients.apiextensions)
      if (types.size === 0) return { installed: false, available: '', resources: [] }

      const wanted = kind === 'all'
        ? PLURALS.filter(p => types.has(p))
        : [kind as typeof PLURALS[number]]
      const available = PLURALS.filter(p => types.has(p)).join(',')

      const resources: Array<{
        kind: string; name: string; namespace: string; summary: string; created: string
      }> = []

      // 逐个类型串行读取，任一类型缺权限时整体报错，便于直接定位 RBAC 问题。
      for (const plural of wanted) {
        const info = types.get(plural)
        if (!info) continue
        const res = info.namespaced
          ? args.namespace
            ? await clients.customObjects.listNamespacedCustomObject({
                group: GROUP, version: info.version, namespace: args.namespace, plural,
              })
            : await clients.customObjects.listCustomObjectForAllNamespaces({
                group: GROUP, version: info.version, plural,
              })
          : await clients.customObjects.listClusterCustomObject({
              group: GROUP, version: info.version, plural,
            })
        const items = ((res as { items?: unknown[] }).items ?? []) as Op[]
        for (const obj of items) {
          const m = meta(obj as Record<string, unknown>)
          resources.push({
            kind: info.kind,
            name: m.name,
            namespace: m.namespace,
            summary: summarize(plural, obj),
            created: m.created,
          })
        }
      }

      return { installed: true, available, resources }
    },
  }))
}
