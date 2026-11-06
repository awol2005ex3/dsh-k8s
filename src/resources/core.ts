import type { KubeObject } from '../types.js'
import type { ResourceRegistry } from './types.js'
import { itemsOf } from './types.js'
import { row, text } from '../describe/common.js'
import { describePod, summaryPod } from '../describe/pod.js'
import { describeService, summaryService } from '../describe/service.js'
import { describeNode, summaryNode } from '../describe/node.js'

/** ResourceQuota：used/hard 压成一行，最多 6 项。 */
function summaryQuota(quota: KubeObject): string {
  const hard = quota.status?.hard ?? {}
  const used = quota.status?.used ?? {}
  const entries = Object.keys(hard)
    .slice(0, 6)
    .map(k => `${k}=${used[k] ?? 0}/${hard[k]}`)
  return entries.join(',')
}

/** LimitRange：列出约束类型与默认值，便于排查注入的 request/limit。 */
function summaryLimitRange(range: KubeObject): string {
  return (range.spec?.limits ?? [])
    .map((l: KubeObject) => {
      const def = l.default ? Object.entries(l.default).map(([k, v]) => `${k}=${v}`).join(',') : '-'
      const req = l.defaultRequest
        ? Object.entries(l.defaultRequest).map(([k, v]) => `${k}=${v}`).join(',')
        : '-'
      return `${l.type}: default(${def}) request(${req})`
    })
    .join(' | ')
}

/** Event：类型/原因/对象/消息，消息截断避免刷屏。 */
function summaryEvent(event: KubeObject): string {
  const obj = event.involvedObject
  const message = text(event.message)
  return row(
    `type=${event.type ?? '-'}`,
    `reason=${event.reason ?? '-'}`,
    obj ? `object=${obj.kind}/${obj.name}` : '',
    `count=${event.count ?? 1}`,
    `message=${message.length > 160 ? `${message.slice(0, 160)}...` : message}`,
  )
}

export const coreResources: ResourceRegistry = {
  pods: {
    scope: 'Namespaced',
    list: (c, ns) => ns
      ? itemsOf(c.core.listNamespacedPod({ namespace: ns }))
      : itemsOf(c.core.listPodForAllNamespaces({})),
    get: (c, ns, name) => c.core.readNamespacedPod({ name, namespace: ns }),
    summary: summaryPod,
    describe: describePod,
  },

  namespaces: {
    scope: 'Cluster',
    list: c => itemsOf(c.core.listNamespace({})),
    get: (c, _ns, name) => c.core.readNamespace({ name }),
    summary: ns => `status=${ns.status?.phase ?? '-'}`,
  },

  nodes: {
    scope: 'Cluster',
    list: c => itemsOf(c.core.listNode({})),
    get: (c, _ns, name) => c.core.readNode({ name }),
    summary: summaryNode,
    describe: describeNode,
  },

  services: {
    scope: 'Namespaced',
    list: (c, ns) => ns
      ? itemsOf(c.core.listNamespacedService({ namespace: ns }))
      : itemsOf(c.core.listServiceForAllNamespaces({})),
    get: (c, ns, name) => c.core.readNamespacedService({ name, namespace: ns }),
    summary: summaryService,
    describe: describeService,
  },

  configmaps: {
    scope: 'Namespaced',
    list: (c, ns) => ns
      ? itemsOf(c.core.listNamespacedConfigMap({ namespace: ns }))
      : itemsOf(c.core.listConfigMapForAllNamespaces({})),
    get: (c, ns, name) => c.core.readNamespacedConfigMap({ name, namespace: ns }),
    summary: cm => `keys=${Object.keys(cm.data ?? {}).join(',') || '-'}`,
  },

  secrets: {
    scope: 'Namespaced',
    list: (c, ns) => ns
      ? itemsOf(c.core.listNamespacedSecret({ namespace: ns }))
      : itemsOf(c.core.listSecretForAllNamespaces({})),
    get: (c, ns, name) => c.core.readNamespacedSecret({ name, namespace: ns }),
    // 只给类型和 key 数量，绝不下发内容。
    summary: s => row(`type=${s.type ?? '-'}`, `keys=${Object.keys(s.data ?? {}).length}`),
  },

  events: {
    scope: 'Namespaced',
    list: (c, ns) => ns
      ? itemsOf(c.core.listNamespacedEvent({ namespace: ns }))
      : itemsOf(c.core.listEventForAllNamespaces({})),
    get: (c, ns, name) => c.core.readNamespacedEvent({ name, namespace: ns }),
    summary: summaryEvent,
  },

  serviceaccounts: {
    scope: 'Namespaced',
    list: (c, ns) => ns
      ? itemsOf(c.core.listNamespacedServiceAccount({ namespace: ns }))
      : itemsOf(c.core.listServiceAccountForAllNamespaces({})),
    get: (c, ns, name) => c.core.readNamespacedServiceAccount({ name, namespace: ns }),
    summary: sa => row(
      `secrets=${(sa.secrets ?? []).length}`,
      `imagePullSecrets=${(sa.imagePullSecrets ?? []).map((s: KubeObject) => s.name).join(',') || '-'}`,
    ),
  },

  resourcequotas: {
    scope: 'Namespaced',
    list: (c, ns) => ns
      ? itemsOf(c.core.listNamespacedResourceQuota({ namespace: ns }))
      : itemsOf(c.core.listResourceQuotaForAllNamespaces({})),
    get: (c, ns, name) => c.core.readNamespacedResourceQuota({ name, namespace: ns }),
    summary: summaryQuota,
  },

  limitranges: {
    scope: 'Namespaced',
    list: (c, ns) => ns
      ? itemsOf(c.core.listNamespacedLimitRange({ namespace: ns }))
      : itemsOf(c.core.listLimitRangeForAllNamespaces({})),
    get: (c, ns, name) => c.core.readNamespacedLimitRange({ name, namespace: ns }),
    summary: summaryLimitRange,
  },
}
