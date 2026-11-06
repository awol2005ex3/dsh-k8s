import type { ResourceRegistry } from './types.js'
import { itemsOf } from './types.js'
import {
  describeCronJob, describeDaemonSet, describeDeployment, describeJob,
  describeReplicaSet, describeStatefulSet,
  summaryCronJob, summaryDaemonSet, summaryDeployment, summaryJob,
  summaryReplicaSet, summaryStatefulSet,
} from '../describe/workload.js'

export const workloadResources: ResourceRegistry = {
  deployments: {
    scope: 'Namespaced',
    list: (c, ns) => ns
      ? itemsOf(c.apps.listNamespacedDeployment({ namespace: ns }))
      : itemsOf(c.apps.listDeploymentForAllNamespaces({})),
    get: (c, ns, name) => c.apps.readNamespacedDeployment({ name, namespace: ns }),
    summary: summaryDeployment,
    describe: describeDeployment,
  },

  statefulsets: {
    scope: 'Namespaced',
    list: (c, ns) => ns
      ? itemsOf(c.apps.listNamespacedStatefulSet({ namespace: ns }))
      : itemsOf(c.apps.listStatefulSetForAllNamespaces({})),
    get: (c, ns, name) => c.apps.readNamespacedStatefulSet({ name, namespace: ns }),
    summary: summaryStatefulSet,
    describe: describeStatefulSet,
  },

  daemonsets: {
    scope: 'Namespaced',
    list: (c, ns) => ns
      ? itemsOf(c.apps.listNamespacedDaemonSet({ namespace: ns }))
      : itemsOf(c.apps.listDaemonSetForAllNamespaces({})),
    get: (c, ns, name) => c.apps.readNamespacedDaemonSet({ name, namespace: ns }),
    summary: summaryDaemonSet,
    describe: describeDaemonSet,
  },

  replicasets: {
    scope: 'Namespaced',
    list: (c, ns) => ns
      ? itemsOf(c.apps.listNamespacedReplicaSet({ namespace: ns }))
      : itemsOf(c.apps.listReplicaSetForAllNamespaces({})),
    get: (c, ns, name) => c.apps.readNamespacedReplicaSet({ name, namespace: ns }),
    summary: summaryReplicaSet,
    describe: describeReplicaSet,
  },

  jobs: {
    scope: 'Namespaced',
    list: (c, ns) => ns
      ? itemsOf(c.batch.listNamespacedJob({ namespace: ns }))
      : itemsOf(c.batch.listJobForAllNamespaces({})),
    get: (c, ns, name) => c.batch.readNamespacedJob({ name, namespace: ns }),
    summary: summaryJob,
    describe: describeJob,
  },

  cronjobs: {
    scope: 'Namespaced',
    list: (c, ns) => ns
      ? itemsOf(c.batch.listNamespacedCronJob({ namespace: ns }))
      : itemsOf(c.batch.listCronJobForAllNamespaces({})),
    get: (c, ns, name) => c.batch.readNamespacedCronJob({ name, namespace: ns }),
    summary: summaryCronJob,
    describe: describeCronJob,
  },
}
