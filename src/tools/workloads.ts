import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { kubeconfigFor, clientsFor, namespaceOf } from '../config.js'
import type { Config as ConfigType, KubeClients } from '../types.js'
import { renderList, meta } from '../helpers.js'

/** 各非 Pod 组件的只读 list 方法；只取 items，避免与各 V1XxxList 类型耦合。 */
type Lister = (c: KubeClients, ns: string) => Promise<{ items?: unknown[] }>

const LISTS: Record<string, Lister> = {
  deployments: (c, ns) => c.apps.listNamespacedDeployment({ namespace: ns }),
  statefulsets: (c, ns) => c.apps.listNamespacedStatefulSet({ namespace: ns }),
  daemonsets: (c, ns) => c.apps.listNamespacedDaemonSet({ namespace: ns }),
  replicasets: (c, ns) => c.apps.listNamespacedReplicaSet({ namespace: ns }),
  jobs: (c, ns) => c.batch.listNamespacedJob({ namespace: ns }),
  cronjobs: (c, ns) => c.batch.listNamespacedCronJob({ namespace: ns }),
  services: (c, ns) => c.core.listNamespacedService({ namespace: ns }),
  configmaps: (c, ns) => c.core.listNamespacedConfigMap({ namespace: ns }),
  secrets: (c, ns) => c.core.listNamespacedSecret({ namespace: ns }),
  events: (c, ns) => c.core.listNamespacedEvent({ namespace: ns }),
  endpoints: (c, ns) => c.core.listNamespacedEndpoints({ namespace: ns }),
  serviceaccounts: (c, ns) => c.core.listNamespacedServiceAccount({ namespace: ns }),
  pvcs: (c, ns) => c.core.listNamespacedPersistentVolumeClaim({ namespace: ns }),
}

export function registerWorkloadTools(ctx: Context, config: ConfigType): void {
  ctx.tools.register(defineTool({
    name: 'k8s_list_pods',
    description: '列出指定集群某命名空间的 Pod（缺省 default），含运行阶段与重启次数。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
      namespace: { type: 'string', description: '命名空间，缺省为 default。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          pods: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string' }, namespace: { type: 'string' },
                phase: { type: 'string' }, restarts: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value) => [renderList(
        value.pods.map(p => `${p.name}  ns=${p.namespace}  phase=${p.phase}  restarts=${p.restarts}`),
        '（无 Pod）',
      )],
    },
    execute: async (args) => {
      const core = clientsFor(kubeconfigFor(config, args.cluster)).core
      const namespace = namespaceOf(args.namespace)
      const res = await core.listNamespacedPod({ namespace })
      const pods = res.items.map((pod) => {
        const restarts = pod.status?.containerStatuses?.reduce((sum, c) => sum + (c.restartCount ?? 0), 0) ?? 0
        return {
          name: pod.metadata?.name ?? '',
          namespace: pod.metadata?.namespace ?? namespace,
          phase: pod.status?.phase ?? '',
          restarts,
        }
      })
      return { pods }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'k8s_read_pod_logs',
    description: '读取指定集群某 Pod 的日志（默认最近 200 行）。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
      namespace: { type: 'string', description: '命名空间，缺省为 default。' },
      pod: { type: 'string', required: true, description: 'Pod 名称。' },
      tailLines: { type: 'integer', description: '读取的尾部行数，缺省 200。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { logs: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.logs || '（日志为空）' }],
    },
    execute: async (args) => {
      const core = clientsFor(kubeconfigFor(config, args.cluster)).core
      const logs = await core.readNamespacedPodLog({
        name: args.pod,
        namespace: namespaceOf(args.namespace),
        tailLines: args.tailLines ?? 200,
      })
      return { logs }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'k8s_list_resources',
    description: '列出非 Pod 组件（只读）：Deployment/StatefulSet/DaemonSet/ReplicaSet/Job/CronJob/Service/ConfigMap/Secret/Event/Endpoints/ServiceAccount/PVC。用于排查工作负载与网络、配置问题。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
      namespace: { type: 'string', description: '命名空间，缺省为 default。' },
      kind: {
        type: 'string', required: true,
        description: '资源类型：' + Object.keys(LISTS).join(' | '),
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          resources: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string' }, namespace: { type: 'string' }, created: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [renderList(
        value.resources.map(r => `• ${r.name}  ns=${r.namespace}  created=${r.created}`),
        '（无资源）',
      )],
    },
    execute: async (args) => {
      const lister = LISTS[args.kind]
      if (!lister) throw new Error(`不支持的资源类型 "${args.kind}"，可用：${Object.keys(LISTS).join(', ')}`)
      const clients = clientsFor(kubeconfigFor(config, args.cluster))
      const res = await lister(clients, namespaceOf(args.namespace))
      const resources = (res.items ?? []).map((row) => meta(row as Record<string, unknown>))
      return { resources }
    },
  }))
}
