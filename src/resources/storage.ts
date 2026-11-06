import type { KubeObject } from '../types.js'
import type { ResourceRegistry } from './types.js'
import { itemsOf } from './types.js'
import { row } from '../describe/common.js'

function summaryPv(pv: KubeObject): string {
  return row(
    `capacity=${pv.spec?.capacity?.storage ?? '-'}`,
    `accessModes=${(pv.spec?.accessModes ?? []).join(',') || '-'}`,
    `reclaim=${pv.spec?.persistentVolumeReclaimPolicy ?? '-'}`,
    `status=${pv.status?.phase ?? '-'}`,
    `class=${pv.spec?.storageClassName ?? '-'}`,
    pv.spec?.claimRef ? `claim=${pv.spec.claimRef.namespace}/${pv.spec.claimRef.name}` : 'claim=-',
  )
}

function summaryPvc(pvc: KubeObject): string {
  return row(
    `status=${pvc.status?.phase ?? '-'}`,
    `capacity=${pvc.status?.capacity?.storage ?? '-'}`,
    `request=${pvc.spec?.resources?.requests?.storage ?? '-'}`,
    `class=${pvc.spec?.storageClassName ?? '-'}`,
    `volume=${pvc.spec?.volumeName ?? '-'}`,
  )
}

function summaryStorageClass(sc: KubeObject): string {
  return row(
    `provisioner=${sc.provisioner ?? '-'}`,
    `reclaim=${sc.reclaimPolicy ?? '-'}`,
    `binding=${sc.volumeBindingMode ?? '-'}`,
    `expansion=${sc.allowVolumeExpansion ? 'yes' : 'no'}`,
    sc.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true' ? 'default' : '',
  )
}

function summaryCsiDriver(driver: KubeObject): string {
  return row(
    `attachRequired=${driver.spec?.attachRequired ?? '-'}`,
    `podInfoOnMount=${driver.spec?.podInfoOnMount ?? '-'}`,
    `storageCapacity=${driver.spec?.storageCapacity ?? '-'}`,
    `modes=${(driver.spec?.volumeLifecycleModes ?? []).join(',') || '-'}`,
  )
}

function summaryCsiNode(node: KubeObject): string {
  return `drivers=${(node.spec?.drivers ?? []).map((d: KubeObject) => d.name).join(',') || '-'}`
}

function summaryVolumeAttachment(va: KubeObject): string {
  return row(
    `node=${va.spec?.nodeName ?? '-'}`,
    `pv=${va.spec?.source?.persistentVolumeName ?? '-'}`,
    `attached=${va.status?.attached ?? '-'}`,
  )
}

export const storageResources: ResourceRegistry = {
  pvs: {
    scope: 'Cluster',
    list: c => itemsOf(c.core.listPersistentVolume({})),
    get: (c, _ns, name) => c.core.readPersistentVolume({ name }),
    summary: summaryPv,
  },

  pvcs: {
    scope: 'Namespaced',
    list: (c, ns) => ns
      ? itemsOf(c.core.listNamespacedPersistentVolumeClaim({ namespace: ns }))
      : itemsOf(c.core.listPersistentVolumeClaimForAllNamespaces({})),
    get: (c, ns, name) => c.core.readNamespacedPersistentVolumeClaim({ name, namespace: ns }),
    summary: summaryPvc,
  },

  storageclasses: {
    scope: 'Cluster',
    list: c => itemsOf(c.storage.listStorageClass({})),
    get: (c, _ns, name) => c.storage.readStorageClass({ name }),
    summary: summaryStorageClass,
  },

  csidrivers: {
    scope: 'Cluster',
    list: c => itemsOf(c.storage.listCSIDriver({})),
    get: (c, _ns, name) => c.storage.readCSIDriver({ name }),
    summary: summaryCsiDriver,
  },

  csinodes: {
    scope: 'Cluster',
    list: c => itemsOf(c.storage.listCSINode({})),
    get: (c, _ns, name) => c.storage.readCSINode({ name }),
    summary: summaryCsiNode,
  },

  volumeattachments: {
    scope: 'Cluster',
    list: c => itemsOf(c.storage.listVolumeAttachment({})),
    get: (c, _ns, name) => c.storage.readVolumeAttachment({ name }),
    summary: summaryVolumeAttachment,
  },
}
