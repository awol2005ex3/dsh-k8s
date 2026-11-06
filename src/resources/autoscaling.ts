import type { KubeObject } from '../types.js'
import type { ResourceRegistry } from './types.js'
import { itemsOf } from './types.js'
import { row } from '../describe/common.js'

/** 指标当前值/目标值压成一行。 */
function metricsOf(hpa: KubeObject): string {
  return (hpa.status?.currentMetrics ?? [])
    .map((m: KubeObject) => {
      const current = m.resource?.current?.averageUtilization ?? m.resource?.current?.averageValue
        ?? m.external?.current?.value ?? m.pods?.current?.averageValue
      return `${m.type}${m.resource?.name ? `:${m.resource.name}` : ''}=${current ?? '-'}`
    })
    .join(',')
}

function summaryHpa(hpa: KubeObject): string {
  return row(
    `target=${hpa.spec?.scaleTargetRef?.kind}/${hpa.spec?.scaleTargetRef?.name}`,
    `replicas=${hpa.status?.currentReplicas ?? 0}→${hpa.status?.desiredReplicas ?? 0}`,
    `min=${hpa.spec?.minReplicas ?? 1}/max=${hpa.spec?.maxReplicas ?? '-'}`,
    `metrics=${metricsOf(hpa) || '-'}`,
  )
}

export const autoscalingResources: ResourceRegistry = {
  horizontalpodautoscalers: {
    scope: 'Namespaced',
    list: (c, ns) => ns
      ? itemsOf(c.autoscaling.listNamespacedHorizontalPodAutoscaler({ namespace: ns }))
      : itemsOf(c.autoscaling.listHorizontalPodAutoscalerForAllNamespaces({})),
    get: (c, ns, name) => c.autoscaling.readNamespacedHorizontalPodAutoscaler({ name, namespace: ns }),
    summary: summaryHpa,
  },
}
