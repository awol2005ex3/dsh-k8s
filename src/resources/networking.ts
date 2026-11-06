import type { KubeObject } from '../types.js'
import type { ResourceRegistry } from './types.js'
import { itemsOf } from './types.js'
import { row } from '../describe/common.js'

/** matchLabels → k=v,k=v。 */
function matchLabels(selector: KubeObject | undefined): string {
  return Object.entries(selector?.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`).join(',')
}

function summaryEndpoints(obj: KubeObject): string {
  const subsets: KubeObject[] = obj.subsets ?? []
  const addresses = subsets.flatMap(s => s.addresses ?? []).map((a: KubeObject) => a.ip)
  const ports = subsets.flatMap(s => (s.ports ?? []).map((p: KubeObject) => p.port))
  return row(`addresses=${addresses.join(',') || '-'}`, `ports=${[...new Set(ports)].join(',') || '-'}`)
}

function summaryEndpointSlice(obj: KubeObject): string {
  const endpoints: KubeObject[] = obj.endpoints ?? []
  const ready = endpoints.filter(e => e.conditions?.ready !== false).length
  const ports = (obj.ports ?? []).map((p: KubeObject) => p.port).join(',')
  return row(
    `addressType=${obj.addressType ?? '-'}`,
    `endpoints=${ready}/${endpoints.length}`,
    `ports=${ports || '-'}`,
  )
}

function summaryNetworkPolicy(obj: KubeObject): string {
  return row(
    `podSelector=${matchLabels(obj.spec?.podSelector) || '*'}`,
    `types=${(obj.spec?.policyTypes ?? []).join(',') || '-'}`,
    `ingress=${(obj.spec?.ingress ?? []).length}`,
    `egress=${(obj.spec?.egress ?? []).length}`,
  )
}

function summaryIngress(obj: KubeObject): string {
  const hosts = (obj.spec?.rules ?? []).map((r: KubeObject) => r.host).filter(Boolean)
  const addresses = (obj.status?.loadBalancer?.ingress ?? [])
    .map((i: KubeObject) => i.ip ?? i.hostname)
    .filter(Boolean)
  return row(
    `class=${obj.spec?.ingressClassName ?? obj.metadata?.annotations?.['kubernetes.io/ingress.class'] ?? '-'}`,
    `hosts=${hosts.join(',') || '-'}`,
    `addr=${addresses.join(',') || '-'}`,
  )
}

export const networkingResources: ResourceRegistry = {
  endpoints: {
    scope: 'Namespaced',
    list: (c, ns) => ns
      ? itemsOf(c.core.listNamespacedEndpoints({ namespace: ns }))
      : itemsOf(c.core.listEndpointsForAllNamespaces({})),
    get: (c, ns, name) => c.core.readNamespacedEndpoints({ name, namespace: ns }),
    summary: summaryEndpoints,
  },

  endpointslices: {
    scope: 'Namespaced',
    list: (c, ns) => ns
      ? itemsOf(c.discovery.listNamespacedEndpointSlice({ namespace: ns }))
      : itemsOf(c.discovery.listEndpointSliceForAllNamespaces({})),
    get: (c, ns, name) => c.discovery.readNamespacedEndpointSlice({ name, namespace: ns }),
    summary: summaryEndpointSlice,
  },

  networkpolicies: {
    scope: 'Namespaced',
    list: (c, ns) => ns
      ? itemsOf(c.networking.listNamespacedNetworkPolicy({ namespace: ns }))
      : itemsOf(c.networking.listNetworkPolicyForAllNamespaces({})),
    get: (c, ns, name) => c.networking.readNamespacedNetworkPolicy({ name, namespace: ns }),
    summary: summaryNetworkPolicy,
  },

  ingresses: {
    scope: 'Namespaced',
    list: (c, ns) => ns
      ? itemsOf(c.networking.listNamespacedIngress({ namespace: ns }))
      : itemsOf(c.networking.listIngressForAllNamespaces({})),
    get: (c, ns, name) => c.networking.readNamespacedIngress({ name, namespace: ns }),
    summary: summaryIngress,
  },
}
