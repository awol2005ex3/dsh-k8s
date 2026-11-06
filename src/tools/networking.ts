import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { kubeconfigFor, clientsFor } from '../config.js'
import type { Config as ConfigType } from '../types.js'
import { renderList, meta } from '../helpers.js'

/** 去重并保持顺序，用于 hosts / tls / addresses 这类数组字段。 */
function uniq(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))]
}

export function registerNetworkingTools(ctx: Context, config: ConfigType): void {
  ctx.tools.register(defineTool({
    name: 'k8s_list_ingresses',
    description: '列出 Ingress（networking.k8s.io/v1），含 class、主机名、TLS 与负载均衡地址。不填 namespace 时读取所有命名空间。只读。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
      namespace: { type: 'string', description: '命名空间；不填则读取所有命名空间。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ingresses: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string' }, namespace: { type: 'string' }, class: { type: 'string' },
                hosts: { type: 'string' }, tls: { type: 'string' },
                addresses: { type: 'string' }, created: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [renderList(
        value.ingresses.map(i => [
          `• ${i.name}`,
          `ns=${i.namespace}`,
          `class=${i.class || '-'}`,
          `hosts=${i.hosts || '-'}`,
          i.tls ? `tls=${i.tls}` : '',
          `addr=${i.addresses || '-'}`,
          `created=${i.created}`,
        ].filter(Boolean).join('  ')),
        '（未发现 Ingress）',
      )],
    },
    execute: async (args) => {
      const networking = clientsFor(kubeconfigFor(config, args.cluster)).networking
      const res = args.namespace
        ? await networking.listNamespacedIngress({ namespace: args.namespace })
        : await networking.listIngressForAllNamespaces({})
      const ingresses = res.items.map((ing) => {
        const m = meta(ing as unknown as Record<string, unknown>)
        return {
          name: m.name,
          namespace: m.namespace,
          class: ing.spec?.ingressClassName
            ?? ing.metadata?.annotations?.['kubernetes.io/ingress.class']
            ?? '',
          hosts: uniq((ing.spec?.rules ?? []).map(r => r.host)).join(','),
          tls: uniq((ing.spec?.tls ?? []).flatMap(t => t.hosts ?? [])).join(','),
          addresses: uniq((ing.status?.loadBalancer?.ingress ?? []).map(i => i.ip ?? i.hostname)).join(','),
          created: m.created,
        }
      })
      return { ingresses }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'k8s_list_ingress_classes',
    description: '列出 IngressClass（networking.k8s.io/v1），含 controller、默认标记与 parameters。只读。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          classes: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string' }, controller: { type: 'string' },
                default: { type: 'boolean' }, parameters: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [renderList(
        value.classes.map(c => [
          `• ${c.name}`,
          `default=${c.default}`,
          `controller=${c.controller || '-'}`,
          c.parameters ? `parameters=${c.parameters}` : '',
        ].filter(Boolean).join('  ')),
        '（未发现 IngressClass）',
      )],
    },
    execute: async (args) => {
      const networking = clientsFor(kubeconfigFor(config, args.cluster)).networking
      const res = await networking.listIngressClass({})
      const classes = res.items.map((cls) => {
        const param = cls.spec?.parameters
        return {
          name: cls.metadata?.name ?? '',
          controller: cls.spec?.controller ?? '',
          default: cls.metadata?.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true',
          parameters: param ? `${param.kind}/${param.name}` : '',
        }
      })
      return { classes }
    },
  }))
}
