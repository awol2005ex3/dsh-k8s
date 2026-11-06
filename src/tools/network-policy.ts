import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { kubeconfigFor, clientsFor, namespaceOf } from '../config.js'
import type { Config as ConfigType } from '../types.js'

type Op = Record<string, any>
type Clients = ReturnType<typeof clientsFor>

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

/** 判断 labels 是否满足 selector（matchLabels + matchExpressions）。 */
function labelsMatch(labels: Op, selector: Op | undefined): boolean {
  if (!selector) return false
  for (const [key, expected] of Object.entries(selector.matchLabels ?? {})) {
    if (text(labels[key]) !== String(expected)) return false
  }
  for (const expr of selector.matchExpressions ?? []) {
    const actual = labels[expr.key]
    const values = new Set((expr.values ?? []).map(String))
    switch (expr.operator) {
      case 'In':
        if (actual === undefined || !values.has(String(actual))) return false
        break
      case 'NotIn':
        if (actual !== undefined && values.has(String(actual))) return false
        break
      case 'Exists':
        if (actual === undefined) return false
        break
      case 'DoesNotExist':
        if (actual !== undefined) return false
        break
    }
  }
  return true
}

/** 空 selector = 匹配所有。 */
function selectorAllowsAll(selector: Op | undefined): boolean {
  if (!selector) return true
  const labels = selector.matchLabels ?? {}
  const exprs = selector.matchExpressions ?? []
  return Object.keys(labels).length === 0 && exprs.length === 0
}

interface PeerInfo {
  description: string
  applies: boolean
}

/** 把一段 from/to peer 解析成可读描述，并判断是否命中目标。 */
function describePeers(
  peers: Op[] | undefined,
  targetNsLabels: Op,
  targetPodLabels: Op,
  targetNamespace: string,
  policyNamespace: string,
): PeerInfo[] {
  const result: PeerInfo[] = []
  for (const peer of peers ?? []) {
    const parts: string[] = []
    const hasPodSel = peer.podSelector !== undefined && !selectorAllowsAll(peer.podSelector)
    const hasNsSel = peer.namespaceSelector !== undefined && !selectorAllowsAll(peer.namespaceSelector)
    const hasIpBlock = peer.ipBlock !== undefined

    const podMatch = hasPodSel ? labelsMatch(targetPodLabels, peer.podSelector) : false
    const nsMatch = hasNsSel ? labelsMatch(targetNsLabels, peer.namespaceSelector) : false

    if (hasPodSel) parts.push(`podSelector:${JSON.stringify(peer.podSelector)}`)
    if (hasNsSel) parts.push(`namespaceSelector:${JSON.stringify(peer.namespaceSelector)}`)
    if (hasIpBlock) {
      parts.push(`ipBlock:${peer.ipBlock.cidr}${peer.ipBlock.except?.length ? ` (except ${peer.ipBlock.except.join(',')})` : ''}`)
    }
    if (parts.length === 0) {
      parts.push('(匹配所有来源)')
      result.push({ description: parts[0], applies: true })
      continue
    }

    // 命中判定：
    // - 无 selector（仅 ipBlock 或空）→ 命中（ipBlock 无法本地判断，标记命中）
    // - 仅 podSelector：命中要求同 namespace 且 pod 匹配
    // - 仅 namespaceSelector：命中要求 ns 匹配
    // - 两者都有：AND
    let applies: boolean
    if (hasPodSel && hasNsSel) {
      applies = podMatch && nsMatch
    } else if (hasPodSel) {
      applies = podMatch && policyNamespace === targetNamespace
    } else if (hasNsSel) {
      applies = nsMatch
    } else {
      applies = hasIpBlock // 无法精确判断，保守命中
    }

    result.push({ description: parts.join(' AND '), applies })
  }
  return result
}

function renderPeers(peers: PeerInfo[]): string {
  if (peers.length === 0) return '  (无来源限制：匹配所有)'
  return peers.map(p => `   ${p.applies ? '▶ 命中' : '  (不命中)'} ${p.description}`).join('\n')
}

function renderRuleBody(peers: PeerInfo[], ports: Op[]): string[] {
  const lines: string[] = []
  lines.push(...renderPeers(peers).split('\n'))
  const portStr = ports.length
    ? ports.map((p: Op) => `${text(p.protocol) || 'TCP'}/${text(p.port) || '*'}`).join(',')
    : '*'
  lines.push(`   port: ${portStr}`)
  return lines
}

export function registerNetworkPolicyTools(ctx: Context, config: ConfigType): void {
  ctx.tools.register(defineTool({
    name: 'k8s_explain_networkpolicy',
    description: '解释 NetworkPolicy 对指定 Pod 的覆盖情况（只读）：列出选中该 Pod 的策略、'
      + '每条 Ingress/Egress 规则的允许来源/目标（podSelector / namespaceSelector / ipBlock / 端口）是否命中该 Pod，'
      + '以及集群是否存在默认拒绝策略。用于排查 Pod 之间网络不通的问题。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
      namespace: { type: 'string', required: true, description: 'Pod 所在命名空间。' },
      pod: { type: 'string', required: true, description: 'Pod 名称。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          pod: { type: 'string', required: true },
          namespace: { type: 'string', required: true },
          labels: { type: 'string', required: true },
          defaultDeny: { type: 'boolean', required: true },
          policies: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string' }, namespace: { type: 'string' },
                podSelector: { type: 'string' },
                ingress: { type: 'array', items: { type: 'string' } },
                egress: { type: 'array', items: { type: 'string' } },
                policyTypes: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = [
          `• Pod ${value.namespace}/${value.pod}  labels=${value.labels || '(无)'}`,
          `defaultDeny=${value.defaultDeny ? '是（未匹配策略即拒绝）' : '否（未匹配策略即允许）'}`,
        ]
        if (value.policies.length === 0) {
          lines.push('\n未找到选中该 Pod 的 NetworkPolicy。')
        } else {
          lines.push(`\n选中该 Pod 的策略（${value.policies.length} 个）：`)
          for (const p of value.policies) {
            lines.push(`\n• ${p.namespace}/${p.name}  selector=${p.podSelector}  types=[${(p.policyTypes ?? []).join(',')}]`)
            if (p.ingress?.length) {
              lines.push('  Ingress 允许来源:')
              lines.push(...p.ingress)
            }
            if (p.egress?.length) {
              lines.push('  Egress 允许目标:')
              lines.push(...p.egress)
            }
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args) => {
      const clients = clientsFor(kubeconfigFor(config, args.cluster))
      const namespace = namespaceOf(args.namespace)

      const pod = await clients.core.readNamespacedPod({ name: args.pod, namespace }) as unknown as Op
      const podLabels: Op = pod.metadata?.labels ?? {}
      const nsObj = await clients.core.readNamespace({ name: namespace }) as unknown as Op
      const nsLabels: Op = nsObj.metadata?.labels ?? {}

      const netPolRes = await clients.networking.listNetworkPolicyForAllNamespaces({}) as unknown as Op
      const allPolicies: Op[] = netPolRes.items ?? []

      // defaultDeny：存在任意 namespace 的 policy 其 podSelector 为空（匹配所有）即视为有默认拒绝
      let defaultDeny = false
      for (const np of allPolicies) {
        const sel = np.spec?.podSelector
        if (selectorAllowsAll(sel)) {
          defaultDeny = true
          break
        }
      }

      const selected: Op[] = []
      for (const np of allPolicies) {
        const policyNs = text(np.metadata?.namespace)
        const podSelector = np.spec?.podSelector ?? {}
        // 只有同 namespace 的 policy 才会选中本 namespace 的 pod
        if (policyNs !== namespace) continue
        if (!labelsMatch(podLabels, podSelector)) continue

        const policyTypes: string[] = np.spec?.policyTypes ?? ['Ingress', 'Egress']

        const ingress: string[] = []
        for (const rule of np.spec?.ingress ?? []) {
          const peers = describePeers(rule.from, nsLabels, podLabels, namespace, policyNs)
          const body = renderRuleBody(peers, rule.ports ?? [])
          if (body.length) {
            ingress.push(`from: ${body[0]}`)
            for (const line of body.slice(1)) ingress.push(`  ${line}`)
          }
        }
        if (ingress.length === 0 && policyTypes.includes('Ingress')) {
          ingress.push('（无规则：仅选中，default-deny 下拒绝所有入站）')
        }

        const egress: string[] = []
        for (const rule of np.spec?.egress ?? []) {
          const peers = describePeers(rule.to, nsLabels, podLabels, namespace, policyNs)
          const body = renderRuleBody(peers, rule.ports ?? [])
          if (body.length) {
            egress.push(`to: ${body[0]}`)
            for (const line of body.slice(1)) egress.push(`  ${line}`)
          }
        }
        if (egress.length === 0 && policyTypes.includes('Egress')) {
          egress.push('（无规则：仅选中，default-deny 下拒绝所有出站）')
        }

        selected.push({
          name: text(np.metadata?.name),
          namespace: policyNs,
          podSelector: JSON.stringify(podSelector),
          ingress,
          egress,
          policyTypes,
        })
      }

      return {
        pod: text(pod.metadata?.name),
        namespace,
        labels: Object.entries(podLabels).map(([k, v]) => `${k}=${v}`).join(',') || '(无)',
        defaultDeny,
        policies: selected,
      }
    },
  }))
}