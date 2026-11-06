import type { KubeObject } from '../types.js'
import type { ResourceRegistry } from './types.js'
import { itemsOf } from './types.js'
import { row } from '../describe/common.js'

function summaryPriorityClass(pc: KubeObject): string {
  return row(
    `value=${pc.value ?? '-'}`,
    `globalDefault=${pc.globalDefault ? 'yes' : 'no'}`,
    `preemption=${pc.preemptionPolicy ?? '-'}`,
  )
}

function summaryRuntimeClass(rc: KubeObject): string {
  return row(
    `handler=${rc.handler ?? '-'}`,
    `overhead=${rc.overhead?.podFixed ? Object.entries(rc.overhead.podFixed).map(([k, v]) => `${k}=${v}`).join(',') : '-'}`,
  )
}

export const schedulingResources: ResourceRegistry = {
  priorityclasses: {
    scope: 'Cluster',
    list: c => itemsOf(c.scheduling.listPriorityClass({})),
    get: (c, _ns, name) => c.scheduling.readPriorityClass({ name }),
    summary: summaryPriorityClass,
  },

  runtimeclasses: {
    scope: 'Cluster',
    list: c => itemsOf(c.node.listRuntimeClass({})),
    get: (c, _ns, name) => c.node.readRuntimeClass({ name }),
    summary: summaryRuntimeClass,
  },
}
