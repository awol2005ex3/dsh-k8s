import type { KubeObject } from '../types.js'
import type { ResourceRegistry } from './types.js'
import { itemsOf } from './types.js'
import { row } from '../describe/common.js'

function summaryPdb(pdb: KubeObject): string {
  const s = pdb.status ?? {}
  return row(
    `minAvailable=${pdb.spec?.minAvailable ?? '-'}`,
    `maxUnavailable=${pdb.spec?.maxUnavailable ?? '-'}`,
    `healthy=${s.currentHealthy ?? '-'}/${s.desiredHealthy ?? '-'}`,
    `allowed=${s.disruptionsAllowed ?? '-'}`,
  )
}

export const policyResources: ResourceRegistry = {
  poddisruptionbudgets: {
    scope: 'Namespaced',
    list: (c, ns) => ns
      ? itemsOf(c.policy.listNamespacedPodDisruptionBudget({ namespace: ns }))
      : itemsOf(c.policy.listPodDisruptionBudgetForAllNamespaces({})),
    get: (c, ns, name) => c.policy.readNamespacedPodDisruptionBudget({ name, namespace: ns }),
    summary: summaryPdb,
  },
}
