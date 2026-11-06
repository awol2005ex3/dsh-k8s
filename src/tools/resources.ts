import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { kubeconfigFor, clientsFor, namespaceOf } from '../config.js'
import type { Config as ConfigType, KubeObject } from '../types.js'
import { renderList, meta } from '../helpers.js'
import { RESOURCES, RESOURCE_KINDS } from '../resources/index.js'
import { genericDescribe } from '../describe/common.js'

/** 解析并校验 kind，拼出可用值清单便于模型自我纠正。 */
function resolveResource(kind: string) {
  const def = RESOURCES[kind.toLowerCase()]
  if (!def) {
    throw new Error(`不支持的资源类型 "${kind}"，可用：${RESOURCE_KINDS.join(', ')}`)
  }
  return def
}

export function registerResourceTools(ctx: Context, config: ConfigType): void {
  ctx.tools.register(defineTool({
    name: 'k8s_list_resources',
    description: '列出集群内的基础 K8s 资源（只读），覆盖核心/工作负载/网络/存储/扩缩容/策略/RBAC/调度等常用类型。'
      + '不填 namespace 或填 * 时读取所有命名空间（集群级资源忽略该参数）。kind 取值见参数说明。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
      namespace: { type: 'string', description: '命名空间；留空或 * 表示所有命名空间。集群级资源忽略此参数。' },
      kind: {
        type: 'string', required: true,
        description: '资源类型（复数）：' + RESOURCE_KINDS.join(' | '),
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
                name: { type: 'string' }, namespace: { type: 'string' },
                created: { type: 'string' }, summary: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [renderList(
        value.resources.map(r => [
          `• ${r.name}`,
          r.namespace ? `ns=${r.namespace}` : '',
          r.summary,
          `created=${r.created}`,
        ].filter(Boolean).join('  ')),
        '（无资源）',
      )],
    },
    execute: async (args) => {
      const def = resolveResource(args.kind)
      const clients = clientsFor(kubeconfigFor(config, args.cluster))
      const namespace = !args.namespace || args.namespace === '*' ? undefined : args.namespace
      const items = await def.list(clients, namespace)

      const resources = items
        .map((item) => {
          const obj = item as KubeObject
          const m = meta(obj)
          return { ...m, summary: def.summary?.(obj) ?? '' }
        })
        .sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`))

      return { resources }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'k8s_get_resource',
    description: '查看单个 K8s 资源的详情（只读）：Pod/Node/Service/工作负载有专门摘要（容器状态、副本数、污点、条件等），'
      + '其他类型回退为 spec/status JSON。用于定位 Pending、CrashLoopBackOff、未就绪、调度失败等问题。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
      kind: {
        type: 'string', required: true,
        description: '资源类型（复数）：' + RESOURCE_KINDS.join(' | '),
      },
      name: { type: 'string', required: true, description: '资源名称。' },
      namespace: { type: 'string', description: '命名空间，缺省为 default；集群级资源忽略此参数。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          kind: { type: 'string' }, name: { type: 'string' }, namespace: { type: 'string' },
          created: { type: 'string' },
          details: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `• ${value.kind}/${value.name}${value.namespace ? `  ns=${value.namespace}` : ''}  created=${value.created || '-'}`,
          ...(value.details ?? []),
        ].join('\n'),
      }],
    },
    execute: async (args) => {
      const def = resolveResource(args.kind)
      const clients = clientsFor(kubeconfigFor(config, args.cluster))
      const namespace = def.scope === 'Namespaced' ? namespaceOf(args.namespace) : ''
      const obj = await def.get(clients, namespace, args.name) as KubeObject
      const m = meta(obj)
      return {
        kind: args.kind.toLowerCase(),
        name: m.name || args.name,
        namespace: m.namespace,
        created: m.created,
        details: def.describe?.(obj) ?? genericDescribe(obj),
      }
    },
  }))
}
