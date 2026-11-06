import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { kubeconfigFor, clientsFor } from '../config.js'
import type { Config as ConfigType } from '../types.js'
import { renderList } from '../helpers.js'
import { parseCertificates, decodeCaBundle } from '../certs.js'

type WebhookType = 'validating' | 'mutating'

/** 把 webhook 的 kubebuilder 规则压成一行：groups/resources:operations。 */
function rulesOf(hook: { rules?: Array<{ apiGroups?: string[]; apiVersions?: string[]; resources?: string[]; operations?: string[] }> }): string {
  return (hook.rules ?? []).map((rule) => {
    const groups = (rule.apiGroups ?? []).join(',') || '-'
    const resources = (rule.resources ?? []).join(',') || '-'
    const operations = (rule.operations ?? []).join(',') || '-'
    return `${groups}/${resources}:${operations}`
  }).join(' | ')
}

/** service 引用或外部 URL，统一成一个目标字符串。 */
function targetOf(clientConfig: {
  service?: { namespace?: string; name?: string; path?: string; port?: number }
  url?: string
} | undefined): string {
  if (clientConfig?.service) {
    const svc = clientConfig.service
    const port = svc.port ?? 443
    return `svc:${svc.namespace ?? ''}/${svc.name ?? ''}:${port}${svc.path ?? ''}`
  }
  return clientConfig?.url ?? ''
}

export function registerWebhookTools(ctx: Context, config: ConfigType): void {
  ctx.tools.register(defineTool({
    name: 'k8s_list_webhooks',
    description: '列出准入 Webhook（ValidatingWebhookConfiguration / MutatingWebhookConfiguration），含调用目标、failurePolicy、caBundle 与匹配规则。'
      + 'caBundle 会解析出 Subject 与有效期，便于排查证书过期导致的准入失败。只读。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
      type: {
        type: 'string',
        description: 'Webhook 类型：validating | mutating | all（缺省 all）',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          webhooks: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                config: { type: 'string' }, type: { type: 'string' },
                name: { type: 'string' }, target: { type: 'string' },
                failurePolicy: { type: 'string' }, sideEffects: { type: 'string' },
                caBundle: { type: 'boolean' }, caSubject: { type: 'string' },
                caExpires: { type: 'string' }, caDaysLeft: { type: 'integer' },
                caExpired: { type: 'boolean' }, rules: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [renderList(
        value.webhooks.map(w => [
          `• [${w.type}] ${w.config} → ${w.name}`,
          `target=${w.target || '-'}`,
          `failure=${w.failurePolicy || '-'}`,
          `sideEffects=${w.sideEffects || '-'}`,
          `caBundle=${w.caBundle ? 'yes' : 'no'}`,
          w.caSubject ? `CA=${w.caSubject}` : '',
          w.caExpires ? `CA expires=${w.caExpires}${w.caExpired ? '(EXPIRED)' : ` (${w.caDaysLeft}d)`}` : '',
          w.rules ? `rules=${w.rules}` : '',
        ].filter(Boolean).join('  ')),
        '（未发现准入 Webhook）',
      )],
    },
    execute: async (args) => {
      const type = args.type ?? 'all'
      if (!['validating', 'mutating', 'all'].includes(type)) {
        throw new Error(`不支持的 webhook 类型 "${type}"，可用：validating, mutating, all`)
      }
      const api = clientsFor(kubeconfigFor(config, args.cluster)).admissionregistration

      const types: WebhookType[] = type === 'all' ? ['validating', 'mutating'] : [type as WebhookType]
      const results = await Promise.all(types.map(async (t) => {
        const res = t === 'validating'
          ? await api.listValidatingWebhookConfiguration({})
          : await api.listMutatingWebhookConfiguration({})
        return { type: t, items: res.items }
      }))

      const webhooks = results.flatMap(({ type: t, items }) => items.flatMap((cfg) => {
        const configName = cfg.metadata?.name ?? ''
        return (cfg.webhooks ?? []).map((hook) => {
          const certs = parseCertificates(decodeCaBundle(hook.clientConfig?.caBundle))
          const ca = certs[0]
          return {
            config: configName,
            type: t,
            name: hook.name,
            target: targetOf(hook.clientConfig),
            failurePolicy: hook.failurePolicy ?? '',
            sideEffects: hook.sideEffects ?? '',
            caBundle: Boolean(hook.clientConfig?.caBundle),
            caSubject: ca?.subject ?? '',
            caExpires: ca ? ca.notAfter.slice(0, 10) : '',
            caDaysLeft: ca?.daysLeft ?? 0,
            caExpired: ca?.expired ?? false,
            rules: rulesOf(hook),
          }
        })
      }))
      return { webhooks }
    },
  }))
}
