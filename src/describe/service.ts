import type { KubeObject } from '../types.js'
import { labelsOf, row } from './common.js'

/** Service 列表摘要。 */
export function summaryService(obj: KubeObject): string {
  const ports = (obj.spec?.ports ?? [])
    .map((p: KubeObject) => `${p.port}${p.protocol && p.protocol !== 'TCP' ? `/${p.protocol}` : ''}`)
    .join(',')
  return row(
    `type=${obj.spec?.type ?? '-'}`,
    `clusterIP=${obj.spec?.clusterIP ?? '-'}`,
    `ports=${ports || '-'}`,
  )
}

/** Service 详情：类型、地址、端口、选择器与后端地址。 */
export function describeService(obj: KubeObject): string[] {
  const spec = obj.spec ?? {}
  const status = obj.status ?? {}
  const ports = (spec.ports ?? []).map((p: KubeObject) =>
    `${p.name ? `${p.name}:` : ''}${p.port}${p.targetPort ? `→${p.targetPort}` : ''}/${p.protocol ?? 'TCP'}`,
  )
  const selector = Object.entries(spec.selector ?? {}).map(([k, v]) => `${k}=${v}`).join(',')
  const externalIPs = (spec.externalIPs ?? []).join(',')
  const ingress = (status.loadBalancer?.ingress ?? [])
    .map((i: KubeObject) => i.ip ?? i.hostname)
    .filter(Boolean)
    .join(',')

  return [
    row(
      `type=${spec.type ?? '-'}`,
      `clusterIP=${spec.clusterIP ?? '-'}`,
      `externalIPs=${externalIPs || '-'}`,
      `loadBalancer=${ingress || '-'}`,
    ),
    row(
      `ports=${ports.join(',') || '-'}`,
      `sessionAffinity=${spec.sessionAffinity ?? '-'}`,
      `externalTrafficPolicy=${spec.externalTrafficPolicy ?? '-'}`,
    ),
    `selector=${selector || '-'}`,
    `labels=${labelsOf(obj) || '-'}`,
  ]
}
