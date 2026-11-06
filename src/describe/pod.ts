import type { KubeObject } from '../types.js'
import { conditionsOf, containerState, labelsOf, row } from './common.js'

/** Pod 重启总次数。 */
export function restartCountOf(pod: KubeObject): number {
  return (pod.status?.containerStatuses ?? []).reduce(
    (sum: number, c: KubeObject) => sum + (c.restartCount ?? 0),
    0,
  )
}

/** Pod 列表摘要。 */
export function summaryPod(pod: KubeObject): string {
  return row(
    `phase=${pod.status?.phase ?? '-'}`,
    `restarts=${restartCountOf(pod)}`,
    `node=${pod.spec?.nodeName ?? '-'}`,
    `ip=${pod.status?.podIP ?? '-'}`,
  )
}

/** 单 Pod 详情：调度位置、条件、各容器状态（含 waiting/terminated 原因）。 */
export function describePod(pod: KubeObject): string[] {
  const status = pod.status ?? {}
  const containers: KubeObject[] = status.containerStatuses ?? []
  const owners = (pod.metadata?.ownerReferences ?? []).map(
    (o: KubeObject) => `${o.kind}/${o.name}`,
  )

  const lines = [
    row(
      `phase=${status.phase ?? '-'}`,
      `node=${pod.spec?.nodeName ?? '-'}`,
      `ip=${status.podIP ?? '-'}`,
      `hostIP=${status.hostIP ?? '-'}`,
      `qos=${status.qosClass ?? '-'}`,
    ),
    row(
      `restarts=${restartCountOf(pod)}`,
      `startTime=${status.startTime ?? '-'}`,
      `serviceAccount=${pod.spec?.serviceAccountName ?? '-'}`,
      `restartPolicy=${pod.spec?.restartPolicy ?? '-'}`,
    ),
    `owner=${owners.join(',') || '-'}`,
    `conditions=${conditionsOf(pod) || '-'}`,
    `labels=${labelsOf(pod) || '-'}`,
    'containers:',
  ]

  if (containers.length === 0) lines.push('  （无容器状态）')
  for (const c of containers) {
    const last = c.lastState && (c.lastState.terminated || c.lastState.waiting)
      ? `  last=${containerState(c.lastState)}`
      : ''
    lines.push(
      `  - ${c.name}: ready=${c.ready} restarts=${c.restartCount} state=${containerState(c.state)}${last}`,
    )
    lines.push(`    image=${c.image ?? '-'}`)
  }

  const volumes = (pod.spec?.volumes ?? []).map((v: KubeObject) => v.name)
  if (volumes.length > 0) lines.push(`volumes=${volumes.join(',')}`)

  return lines
}
