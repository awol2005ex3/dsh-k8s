import type { KubeObject } from '../types.js'
import type { ResourceRegistry } from './types.js'
import { itemsOf } from './types.js'
import { row } from '../describe/common.js'

function subjectsOf(binding: KubeObject): string {
  return (binding.subjects ?? [])
    .map((s: KubeObject) => `${s.kind}:${s.namespace ? `${s.namespace}/` : ''}${s.name}`)
    .join(',')
}

function roleRefOf(binding: KubeObject): string {
  return binding.roleRef ? `${binding.roleRef.kind}/${binding.roleRef.name}` : '-'
}

function summaryRole(role: KubeObject): string {
  return row(
    `rules=${(role.rules ?? []).length}`,
    role.aggregationRule ? 'aggregated' : '',
  )
}

function summaryBinding(binding: KubeObject): string {
  return row(`role=${roleRefOf(binding)}`, `subjects=${subjectsOf(binding) || '-'}`)
}

export const rbacResources: ResourceRegistry = {
  roles: {
    scope: 'Namespaced',
    list: (c, ns) => ns
      ? itemsOf(c.rbac.listNamespacedRole({ namespace: ns }))
      : itemsOf(c.rbac.listRoleForAllNamespaces({})),
    get: (c, ns, name) => c.rbac.readNamespacedRole({ name, namespace: ns }),
    summary: summaryRole,
  },

  rolebindings: {
    scope: 'Namespaced',
    list: (c, ns) => ns
      ? itemsOf(c.rbac.listNamespacedRoleBinding({ namespace: ns }))
      : itemsOf(c.rbac.listRoleBindingForAllNamespaces({})),
    get: (c, ns, name) => c.rbac.readNamespacedRoleBinding({ name, namespace: ns }),
    summary: summaryBinding,
  },

  clusterroles: {
    scope: 'Cluster',
    list: c => itemsOf(c.rbac.listClusterRole({})),
    get: (c, _ns, name) => c.rbac.readClusterRole({ name }),
    summary: summaryRole,
  },

  clusterrolebindings: {
    scope: 'Cluster',
    list: c => itemsOf(c.rbac.listClusterRoleBinding({})),
    get: (c, _ns, name) => c.rbac.readClusterRoleBinding({ name }),
    summary: summaryBinding,
  },
}
