import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { kubeconfigFor, clientsFor, namespaceOf } from '../config.js'
import type { Config as ConfigType } from '../types.js'
import { renderList } from '../helpers.js'

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
    description: '读取指定集群某 Pod 的日志（默认最近 200 行）。支持指定容器、读取上一次容器实例（排查 CrashLoopBackOff）与按时间窗口读取。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
      namespace: { type: 'string', description: '命名空间，缺省为 default。' },
      pod: { type: 'string', required: true, description: 'Pod 名称。' },
      container: { type: 'string', description: '容器名称；多容器 Pod 建议指定。' },
      previous: { type: 'boolean', description: '读取上一次容器实例的日志（容器重启后可用），缺省 false。' },
      sinceSeconds: { type: 'integer', description: '只读取最近 N 秒的日志；与 tailLines 二选一即可。' },
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
        container: args.container,
        previous: args.previous,
        sinceSeconds: args.sinceSeconds,
        tailLines: args.tailLines ?? 200,
      })
      return { logs }
    },
  }))
}
