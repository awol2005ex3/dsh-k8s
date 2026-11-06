import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import * as k8s from '@kubernetes/client-node'
import { Config, kubeconfigFor, clientsFor, unwrap } from '../config.js'
import type { Config as ConfigType } from '../types.js'
import { renderList } from '../helpers.js'

export function registerClusterTools(ctx: Context, config: ConfigType): void {
  ctx.tools.register(defineTool({
    name: 'k8s_list_clusters',
    description: '列出已配置的 Kubernetes 集群及其 server 与当前 context。',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          clusters: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: { name: { type: 'string' }, server: { type: 'string' }, context: { type: 'string' } },
            },
          },
        },
      },
      render: (_args, value) => [renderList(
        value.clusters.map(c => `• ${c.name}  (${c.server}, context=${c.context})`),
        '未配置任何集群',
      )],
    },
    execute: async () => {
      const kc = new k8s.KubeConfig()
      const clusters: Array<{ name: string; server: string; context: string }> = []
      for (const entry of unwrap(config)) {
        try {
          kc.loadFromString(entry.kubeconfig)
          clusters.push({
            name: entry.name,
            server: kc.getCurrentCluster()?.server ?? '(解析失败)',
            context: entry.context ?? kc.getCurrentContext(),
          })
        } catch {
          clusters.push({ name: entry.name, server: '(kubeconfig 无法解析)', context: '(未知)' })
        }
      }
      return { clusters }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'k8s_test_connection',
    description: '测试与指定 Kubernetes 集群的连接，返回 server 地址与节点数。',
    parameters: { cluster: { type: 'string', required: true, description: '已配置集群的名称。' } },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean' }, server: { type: 'string' },
          nodeCount: { type: 'integer' }, error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.ok
        ? `连接成功：server=${value.server}，${value.nodeCount} 个节点`
        : `连接失败：${value.error}` }],
    },
    execute: async (args) => {
      try {
        const kc = kubeconfigFor(config, args.cluster)
        const nodes = await clientsFor(kc).core.listNode({})
        return { ok: true, server: kc.getCurrentCluster()?.server ?? '', nodeCount: nodes.items.length, error: '' }
      } catch (error) {
        return { ok: false, server: '', nodeCount: 0, error: (error as Error).message }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'k8s_list_nodes',
    description: '列出指定 Kubernetes 集群的节点及其就绪状态、角色与版本。',
    parameters: { cluster: { type: 'string', required: true, description: '已配置集群的名称。' } },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          nodes: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string' }, ready: { type: 'string' },
                version: { type: 'string' }, internalIP: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [renderList(
        value.nodes.map(n => `${n.name}  ready=${n.ready}  v=${n.version}  ip=${n.internalIP}`),
        '（无节点）',
      )],
    },
    execute: async (args) => {
      const res = await clientsFor(kubeconfigFor(config, args.cluster)).core.listNode({})
      const nodes = res.items.map((node) => {
        const ready = node.status?.conditions?.find(c => c.type === 'Ready')?.status ?? 'Unknown'
        return {
          name: node.metadata?.name ?? '',
          ready: ready === 'True' ? 'Ready' : ready,
          version: node.status?.nodeInfo?.kubeletVersion ?? '',
          internalIP: node.status?.addresses?.find(a => a.type === 'InternalIP')?.address ?? '',
        }
      })
      return { nodes }
    },
  }))
}
