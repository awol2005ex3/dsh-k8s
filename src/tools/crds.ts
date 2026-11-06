import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { kubeconfigFor, clientsFor, namespaceOf } from '../config.js'
import type { Config as ConfigType } from '../types.js'
import { renderList, meta } from '../helpers.js'

export function registerCrdTools(ctx: Context, config: ConfigType): void {
  ctx.tools.register(defineTool({
    name: 'k8s_list_crds',
    description: '列出集群内所有 CustomResourceDefinition（CRD）定义，便于查看非标准资源类型。',
    parameters: { cluster: { type: 'string', required: true, description: '已配置集群的名称。' } },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          crds: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string' }, group: { type: 'string' },
                kind: { type: 'string' }, plural: { type: 'string' },
                scope: { type: 'string' }, versions: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [renderList(
        value.crds.map(c => `• ${c.name} (kind=${c.kind}, group=${c.group}, plural=${c.plural}, scope=${c.scope}, versions=${c.versions})`),
        '集群中没有 CRD 定义',
      )],
    },
    execute: async (args) => {
      const apix = clientsFor(kubeconfigFor(config, args.cluster)).apiextensions
      const res = await apix.listCustomResourceDefinition({})
      const crds = res.items.map((crd) => ({
        name: crd.metadata?.name ?? '',
        group: crd.spec.group,
        kind: crd.spec.names.kind,
        plural: crd.spec.names.plural,
        scope: crd.spec.scope,
        versions: (crd.spec.versions ?? []).map(v => v.name).join(','),
      }))
      return { crds }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'k8s_list_crd_instances',
    description: '列出指定 CRD 类型的实例（先通过 k8s_list_crds 了解 group/version/plural）。仅读取，不修改。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
      group: { type: 'string', required: true, description: 'CRD 的 group，如 example.com' },
      version: { type: 'string', required: true, description: 'CRD 的 version，如 v1' },
      plural: { type: 'string', required: true, description: '复数形式，如 myresources' },
      namespace: { type: 'string', description: '命名空间；不填则按集群范围（Cluster）资源读取' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          instances: {
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
        value.instances.map(i => `• ${i.name}  ns=${i.namespace}  created=${i.created}`),
        '未找到该 CRD 的任何实例',
      )],
    },
    execute: async (args) => {
      const customObjects = clientsFor(kubeconfigFor(config, args.cluster)).customObjects
      const res = args.namespace
        ? await customObjects.listNamespacedCustomObject({
            group: args.group, version: args.version, namespace: namespaceOf(args.namespace), plural: args.plural,
          })
        : await customObjects.listClusterCustomObject({ group: args.group, version: args.version, plural: args.plural })
      const items = (res as { items?: unknown[] }).items ?? []
      const instances = items.map((row) => meta(row as Record<string, unknown>))
      return { instances }
    },
  }))
}
