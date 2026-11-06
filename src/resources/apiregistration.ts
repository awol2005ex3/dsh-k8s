import type { KubeObject } from '../types.js'
import type { ResourceRegistry } from './types.js'
import { itemsOf } from './types.js'
import { conditionOf, row } from '../describe/common.js'

function summaryApiService(api: KubeObject): string {
  const svc = api.spec?.service
  return row(
    `group=${api.spec?.group ?? '-'}`,
    `version=${api.spec?.version ?? '-'}`,
    svc ? `service=${svc.namespace}/${svc.name}:${svc.port ?? 443}` : 'local',
    `available=${conditionOf(api, 'Available') || '-'}`,
  )
}

export const apiregistrationResources: ResourceRegistry = {
  apiservices: {
    scope: 'Cluster',
    list: c => itemsOf(c.apiregistration.listAPIService({})),
    get: (c, _ns, name) => c.apiregistration.readAPIService({ name }),
    summary: summaryApiService,
  },
}
