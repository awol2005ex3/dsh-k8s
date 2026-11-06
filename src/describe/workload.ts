import type { KubeObject } from '../types.js'
import { conditionsOf, imageField, imagesOf, labelsOf, row } from './common.js'

/** matchLabels → k=v,k=v。 */
function selectorOf(obj: KubeObject): string {
  const labels = obj.spec?.selector?.matchLabels ?? {}
  return Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',')
}

/** Deployment 列表摘要。 */
export function summaryDeployment(obj: KubeObject): string {
  const s = obj.status ?? {}
  return row(
    `ready=${s.readyReplicas ?? 0}/${obj.spec?.replicas ?? 0}`,
    `updated=${s.updatedReplicas ?? 0}`,
    `available=${s.availableReplicas ?? 0}`,
    imageField(obj.spec?.template?.spec),
  )
}

export function describeDeployment(obj: KubeObject): string[] {
  const s = obj.status ?? {}
  return [
    row(
      `replicas=${obj.spec?.replicas ?? 0}`,
      `updated=${s.updatedReplicas ?? 0}`,
      `ready=${s.readyReplicas ?? 0}`,
      `available=${s.availableReplicas ?? 0}`,
      `unavailable=${s.unavailableReplicas ?? 0}`,
    ),
    row(
      `strategy=${obj.spec?.strategy?.type ?? '-'}`,
      `paused=${obj.spec?.paused ? 'yes' : 'no'}`,
      `generation=${obj.metadata?.generation ?? '-'}/${s.observedGeneration ?? '-'}`,
    ),
    `selector=${selectorOf(obj) || '-'}`,
    `images=${imagesOf(obj.spec?.template?.spec) || '-'}`,
    `conditions=${conditionsOf(obj) || '-'}`,
    `labels=${labelsOf(obj) || '-'}`,
  ]
}

/** StatefulSet 列表摘要。 */
export function summaryStatefulSet(obj: KubeObject): string {
  const s = obj.status ?? {}
  return row(
    `ready=${s.readyReplicas ?? 0}/${obj.spec?.replicas ?? 0}`,
    `current=${s.currentReplicas ?? 0}`,
    `updated=${s.updatedReplicas ?? 0}`,
    imageField(obj.spec?.template?.spec),
  )
}

export function describeStatefulSet(obj: KubeObject): string[] {
  const s = obj.status ?? {}
  return [
    row(
      `replicas=${obj.spec?.replicas ?? 0}`,
      `ready=${s.readyReplicas ?? 0}`,
      `current=${s.currentReplicas ?? 0}`,
      `updated=${s.updatedReplicas ?? 0}`,
    ),
    row(
      `serviceName=${obj.spec?.serviceName ?? '-'}`,
      `updateStrategy=${obj.spec?.updateStrategy?.type ?? '-'}`,
      `podManagementPolicy=${obj.spec?.podManagementPolicy ?? '-'}`,
    ),
    `revision=${s.currentRevision ?? '-'} → ${s.updateRevision ?? '-'}`,
    `selector=${selectorOf(obj) || '-'}`,
    `images=${imagesOf(obj.spec?.template?.spec) || '-'}`,
    `conditions=${conditionsOf(obj) || '-'}`,
    `labels=${labelsOf(obj) || '-'}`,
  ]
}

/** DaemonSet 列表摘要。 */
export function summaryDaemonSet(obj: KubeObject): string {
  const s = obj.status ?? {}
  return row(
    `ready=${s.numberReady ?? 0}/${s.desiredNumberScheduled ?? 0}`,
    `updated=${s.updatedNumberScheduled ?? 0}`,
    `misscheduled=${s.numberMisscheduled ?? 0}`,
    imageField(obj.spec?.template?.spec),
  )
}

export function describeDaemonSet(obj: KubeObject): string[] {
  const s = obj.status ?? {}
  return [
    row(
      `desired=${s.desiredNumberScheduled ?? 0}`,
      `current=${s.currentNumberScheduled ?? 0}`,
      `ready=${s.numberReady ?? 0}`,
      `available=${s.numberAvailable ?? 0}`,
      `misscheduled=${s.numberMisscheduled ?? 0}`,
    ),
    row(
      `updated=${s.updatedNumberScheduled ?? 0}`,
      `updateStrategy=${obj.spec?.updateStrategy?.type ?? '-'}`,
    ),
    `selector=${selectorOf(obj) || '-'}`,
    `images=${imagesOf(obj.spec?.template?.spec) || '-'}`,
    `conditions=${conditionsOf(obj) || '-'}`,
    `labels=${labelsOf(obj) || '-'}`,
  ]
}

/** ReplicaSet 列表摘要。 */
export function summaryReplicaSet(obj: KubeObject): string {
  const s = obj.status ?? {}
  return row(
    `ready=${s.readyReplicas ?? 0}/${obj.spec?.replicas ?? 0}`,
    `available=${s.availableReplicas ?? 0}`,
    imageField(obj.spec?.template?.spec),
  )
}

export function describeReplicaSet(obj: KubeObject): string[] {
  const s = obj.status ?? {}
  return [
    row(
      `replicas=${obj.spec?.replicas ?? 0}`,
      `current=${s.replicas ?? 0}`,
      `ready=${s.readyReplicas ?? 0}`,
      `available=${s.availableReplicas ?? 0}`,
      `fullyLabeled=${s.fullyLabeledReplicas ?? 0}`,
    ),
    `selector=${selectorOf(obj) || '-'}`,
    `images=${imagesOf(obj.spec?.template?.spec) || '-'}`,
    `labels=${labelsOf(obj) || '-'}`,
  ]
}

/** Job 列表摘要。 */
export function summaryJob(obj: KubeObject): string {
  const s = obj.status ?? {}
  return row(
    `active=${s.active ?? 0}`,
    `succeeded=${s.succeeded ?? 0}`,
    `failed=${s.failed ?? 0}`,
    `completions=${obj.spec?.completions ?? '-'}`,
  )
}

export function describeJob(obj: KubeObject): string[] {
  const s = obj.status ?? {}
  return [
    row(
      `completions=${obj.spec?.completions ?? '-'}`,
      `parallelism=${obj.spec?.parallelism ?? '-'}`,
      `backoffLimit=${obj.spec?.backoffLimit ?? '-'}`,
      `activeDeadlineSeconds=${obj.spec?.activeDeadlineSeconds ?? '-'}`,
    ),
    row(
      `active=${s.active ?? 0}`,
      `succeeded=${s.succeeded ?? 0}`,
      `failed=${s.failed ?? 0}`,
      `startTime=${s.startTime ?? '-'}`,
      `completionTime=${s.completionTime ?? '-'}`,
    ),
    `conditions=${conditionsOf(obj) || '-'}`,
    `images=${imagesOf(obj.spec?.template?.spec) || '-'}`,
    `labels=${labelsOf(obj) || '-'}`,
  ]
}

/** CronJob 列表摘要。 */
export function summaryCronJob(obj: KubeObject): string {
  const s = obj.status ?? {}
  return row(
    `schedule=${obj.spec?.schedule ?? '-'}`,
    `suspend=${obj.spec?.suspend ? 'yes' : 'no'}`,
    `active=${(s.active ?? []).length}`,
    `lastSchedule=${s.lastScheduleTime ?? '-'}`,
  )
}

export function describeCronJob(obj: KubeObject): string[] {
  const s = obj.status ?? {}
  return [
    row(
      `schedule=${obj.spec?.schedule ?? '-'}`,
      `suspend=${obj.spec?.suspend ? 'yes' : 'no'}`,
      `concurrencyPolicy=${obj.spec?.concurrencyPolicy ?? '-'}`,
      `timeZone=${obj.spec?.timeZone ?? '-'}`,
    ),
    row(
      `lastSchedule=${s.lastScheduleTime ?? '-'}`,
      `lastSuccessful=${s.lastSuccessfulTime ?? '-'}`,
      `active=${(s.active ?? []).map((a: KubeObject) => a.name).join(',') || '0'}`,
    ),
    `images=${imagesOf(obj.spec?.jobTemplate?.spec?.template?.spec) || '-'}`,
    `labels=${labelsOf(obj) || '-'}`,
  ]
}
