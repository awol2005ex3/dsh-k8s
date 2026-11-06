import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { kubeconfigFor, clientsFor, namespaceOf } from '../config.js'
import type { Config as ConfigType } from '../types.js'

type Op = Record<string, any>
type Clients = ReturnType<typeof clientsFor>

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

/** 从 kube-system/coredns 的 Corefile 里取 cluster domain（形如 cluster.local）。 */
async function clusterDomain(clients: Clients): Promise<string> {
  try {
    const cm = await clients.core.readNamespacedConfigMap({
      namespace: 'kube-system',
      name: 'coredns',
    }) as unknown as Op
    const corefile = text(cm.data?.Corefile)
    for (const line of corefile.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.startsWith('kubernetes ')) {
        const domain = trimmed.split(/\s+/)[1]
        if (domain) return domain.replace(/\.$/, '')
      }
    }
  } catch {
    // 读不到 Corefile 时退化为默认值
  }
  return 'cluster.local'
}

export function registerDomainTools(ctx: Context, config: ConfigType): void {
  ctx.tools.register(defineTool({
    name: 'k8s_get_dns_names',
    description: '查询集群 DNS 域名（只读）：读 coredns Corefile 得出 cluster domain，返回 Service 的完整 FQDN 与简写，'
      + '以及 StatefulSet headless 下的 Pod 域名。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
      namespace: { type: 'string', description: 'Service 所在命名空间。' },
      service: { type: 'string', description: 'Service 名称；不填则返回该命名空间所有 Service 的域名。' },
      pod: { type: 'string', description: '可选：StatefulSet headless 场景下查询 Pod 域名。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          clusterDomain: { type: 'string', required: true },
          services: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string' }, namespace: { type: 'string' },
                fqdn: { type: 'string' }, shortFqdn: { type: 'string' },
                headless: { type: 'boolean' },
              },
            },
          },
          pods: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string' }, namespace: { type: 'string' },
                fqdn: { type: 'string' }, shortFqdn: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines: string[] = [`clusterDomain = ${value.clusterDomain}`]
        if (value.services?.length) {
          lines.push('\nServices:')
          lines.push(...value.services.map(s =>
            `  • ${s.namespace}/${s.name}${s.headless ? ' (headless)' : ''}\n    fqdn=${s.fqdn}\n    short=${s.shortFqdn}`))
        }
        if (value.pods?.length) {
          lines.push('\nPods:')
          lines.push(...value.pods.map(p => `  • ${p.namespace}/${p.name}\n    fqdn=${p.fqdn}\n    short=${p.shortFqdn}`))
        }
        if (!value.services?.length && !value.pods?.length) {
          lines.push('（未找到匹配对象）')
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args) => {
      const clients = clientsFor(kubeconfigFor(config, args.cluster))
      const domain = await clusterDomain(clients)
      const namespace = args.namespace ? namespaceOf(args.namespace) : undefined

      const services: Op[] = []
      let items: Op[] = []
      if (namespace) {
        const res = await clients.core.listNamespacedService({ namespace }) as unknown as Op
        items = res.items ?? []
      } else {
        const res = await clients.core.listServiceForAllNamespaces({}) as unknown as Op
        items = res.items ?? []
      }
      for (const svc of items) {
        const name = text(svc.metadata?.name)
        const ns = text(svc.metadata?.namespace)
        if (!name) continue
        if (args.service && name !== args.service) continue
        services.push({
          name,
          namespace: ns,
          fqdn: `${name}.${ns}.svc.${domain}`,
          shortFqdn: `${name}.${ns}`,
          headless: text(svc.spec?.clusterIP) === 'None',
        })
      }

      const pods: Op[] = []
      if (args.pod && namespace) {
        try {
          const pod = await clients.core.readNamespacedPod({ name: args.pod, namespace }) as unknown as Op
          const name = text(pod.metadata?.name)
          const ns = text(pod.metadata?.namespace)
          const ip = text(pod.status?.podIP)
          const owner = (pod.metadata?.ownerReferences ?? [])[0]
          const stName = text(owner?.kind) === 'StatefulSet' ? text(owner?.name) : ''
          let fqdn = ''
          let short = ''
          if (stName) {
            fqdn = `${name}.${stName}.${ns}.svc.${domain}`
            short = `${name}.${stName}.${ns}.svc`
          } else if (ip) {
            const ipShort = ip.replaceAll('.', '-')
            fqdn = `${ipShort}.${ns}.pod.${domain}`
            short = `${ipShort}.${ns}.pod`
          }
          if (fqdn) pods.push({ name, namespace: ns, fqdn, shortFqdn: short })
        } catch {
          // Pod 不存在时忽略
        }
      }

      return { clusterDomain: domain, services, pods }
    },
  }))
}