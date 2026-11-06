import type { KubeObject } from '../types.js'
import type { ResourceRegistry } from './types.js'
import { itemsOf } from './types.js'
import { row } from '../describe/common.js'

function summaryLease(lease: KubeObject): string {
  const spec = lease.spec ?? {}
  return row(
    `holder=${spec.holderIdentity ?? '-'}`,
    `renewTime=${spec.renewTime ?? '-'}`,
    `duration=${spec.leaseDurationSeconds ?? '-'}s`,
    `transitions=${spec.leaseTransitions ?? 0}`,
  )
}

export const coordinationResources: ResourceRegistry = {
  leases: {
    scope: 'Namespaced',
    list: (c, ns) => ns
      ? itemsOf(c.coordination.listNamespacedLease({ namespace: ns }))
      : itemsOf(c.coordination.listLeaseForAllNamespaces({})),
    get: (c, ns, name) => c.coordination.readNamespacedLease({ name, namespace: ns }),
    summary: summaryLease,
  },
}
