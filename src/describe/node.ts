import type { KubeObject } from '../types.js'
import { conditionOf, conditionsOf, labelsOf, resourcesOf, row } from './common.js'

function addressOf(status: KubeObject, type: string): string {
  return (status.addresses ?? []).find((a: KubeObject) => a.type === type)?.address ?? ''
}

function rolesOf(obj: KubeObject): string {
  return Object.keys(obj.metadata?.labels ?? {})
    .filter(k => k.startsWith('node-role.kubernetes.io/'))
    .map(k => k.slice('node-role.kubernetes.io/'.length))
    .join(',')
}

/** Node 列表摘要。 */
export function summaryNode(obj: KubeObject): string {
  return row(
    `ready=${conditionOf(obj, 'Ready') || '-'}`,
    `v=${obj.status?.nodeInfo?.kubeletVersion ?? '-'}`,
    `ip=${addressOf(obj.status ?? {}, 'InternalIP') || '-'}`,
    `unschedulable=${obj.spec?.unschedulable ? 'yes' : 'no'}`,
  )
}

/** Node 详情：状态、地址、容量、污点与条件。 */
export function describeNode(obj: KubeObject): string[] {
  const status = obj.status ?? {}
  const info = status.nodeInfo ?? {}
  const taints = (obj.spec?.taints ?? [])
    .map((t: KubeObject) => `${t.key}${t.value ? `=${t.value}` : ''}:${t.effect}`)
    .join(',')

  return [
    row(
      `ready=${conditionOf(obj, 'Ready') || '-'}`,
      `unschedulable=${obj.spec?.unschedulable ? 'yes' : 'no'}`,
      `roles=${rolesOf(obj) || '-'}`,
    ),
    row(
      `internalIP=${addressOf(status, 'InternalIP') || '-'}`,
      `externalIP=${addressOf(status, 'ExternalIP') || '-'}`,
      `hostname=${addressOf(status, 'Hostname') || '-'}`,
      `podCIDR=${obj.spec?.podCIDR ?? '-'}`,
    ),
    row(
      `version=${info.kubeletVersion ?? '-'}`,
      `runtime=${info.containerRuntimeVersion ?? '-'}`,
      `os=${info.operatingSystem ?? '-'}/${info.architecture ?? '-'}`,
      `kernel=${info.kernelVersion ?? '-'}`,
    ),
    `taints=${taints || '-'}`,
    `capacity=${resourcesOf(status.capacity) || '-'}`,
    `allocatable=${resourcesOf(status.allocatable) || '-'}`,
    `conditions=${conditionsOf(obj) || '-'}`,
    `labels=${labelsOf(obj) || '-'}`,
  ]
}
