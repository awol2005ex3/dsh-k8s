import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { kubeconfigFor, clientsFor } from '../config.js'
import type { Config as ConfigType } from '../types.js'
import {
  parseCertificates,
  decodeBase64Text,
  certificateCoversHost,
  describeCert,
  type CertInfo,
} from '../certs.js'

type Op = Record<string, any>
type Clients = ReturnType<typeof clientsFor>

interface Issue {
  severity: 'error' | 'warning'
  code: string
  ingress: string
  namespace: string
  host: string
  message: string
}

interface CertLookup {
  missing: boolean
  certs: CertInfo[]
}

/** 单次执行的轻量缓存：同一 Secret / Service 在多个 Ingress 间只读一次。 */
interface LookupContext {
  clients: Clients
  secrets: Map<string, CertLookup>
  services: Map<string, Op | null>
}

function lookupContext(clients: Clients): LookupContext {
  return { clients, secrets: new Map(), services: new Map() }
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

function uniq(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))]
}

async function listIngresses(clients: Clients, namespace?: string): Promise<Op[]> {
  const res = namespace
    ? await clients.networking.listNamespacedIngress({ namespace })
    : await clients.networking.listIngressForAllNamespaces({})
  return (res.items ?? []) as unknown as Op[]
}

/** Secret 里只解析证书，永远不返回 tls.key 的内容。 */
async function certsForSecret(ctx: LookupContext, namespace: string, name: string): Promise<CertLookup> {
  const cacheKey = `${namespace}/${name}`
  const cached = ctx.secrets.get(cacheKey)
  if (cached) return cached

  let result: CertLookup = { missing: true, certs: [] }
  try {
    const secret = await ctx.clients.core.readNamespacedSecret({ namespace, name }) as unknown as Op
    const data: Op = secret.data ?? {}
    const preferred = ['tls.crt', 'ca.crt', ...Object.keys(data)]
    const certs: CertInfo[] = []
    for (const key of uniq(preferred)) {
      if (!(key in data)) continue
      const pem = decodeBase64Text(data[key])
      if (!pem.includes('BEGIN CERTIFICATE')) continue
      certs.push(...parseCertificates(pem, key))
      if (certs.length > 0) break
    }
    result = { missing: false, certs }
  } catch {
    result = { missing: true, certs: [] }
  }
  ctx.secrets.set(cacheKey, result)
  return result
}

async function serviceFor(ctx: LookupContext, namespace: string, name: string): Promise<Op | null> {
  const cacheKey = `${namespace}/${name}`
  if (ctx.services.has(cacheKey)) return ctx.services.get(cacheKey) ?? null
  try {
    const svc = await ctx.clients.core.readNamespacedService({ namespace, name }) as unknown as Op
    ctx.services.set(cacheKey, svc)
    return svc
  } catch {
    ctx.services.set(cacheKey, null)
    return null
  }
}

function selectorString(selector: Op | undefined): string {
  return Object.entries(selector ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(',')
}

function normalizePath(path: string | undefined): string {
  if (!path) return '/'
  return path.startsWith('/') ? path : `/${path}`
}

/** Exact / Prefix / ImplementationSpecific 的路径匹配（Prefix 按路径段边界）。 */
function pathMatches(pathType: string | undefined, rulePath: string | undefined, requestPath: string): boolean {
  const rule = normalizePath(rulePath)
  const request = normalizePath(requestPath)
  const type = (pathType ?? 'Prefix').toLowerCase()
  if (type === 'exact') return request === rule
  if (rule === '/') return true
  const base = rule.endsWith('/') ? rule.slice(0, -1) : rule
  return request === base || request.startsWith(`${base}/`)
}

/** Ingress rule host 支持单层通配符。 */
function hostMatches(ruleHost: string, host: string): boolean {
  const rule = ruleHost.toLowerCase().replace(/\.$/, '')
  const target = host.toLowerCase().replace(/\.$/, '')
  if (!rule) return true
  if (rule === target) return true
  if (!rule.startsWith('*.')) return false
  const dot = target.indexOf('.')
  return dot > 0 && target.slice(dot + 1) === rule.slice(2)
}

interface BackendRef {
  host: string
  path: string
  pathType: string
  service: string
  port: string
}

/** 把 Ingress 的 rules 展开成 host + path + backend 的扁平列表。 */
function backendRefs(ing: Op): BackendRef[] {
  const refs: BackendRef[] = []
  for (const rule of ing.spec?.rules ?? []) {
    const host = text(rule.host)
    for (const item of rule.http?.paths ?? []) {
      const svc = item.backend?.service
      if (!svc?.name) continue
      const port = svc.port?.number !== undefined ? text(svc.port.number) : text(svc.port?.name)
      refs.push({
        host,
        path: normalizePath(item.path),
        pathType: text(item.pathType) || 'Prefix',
        service: text(svc.name),
        port,
      })
    }
  }
  const def = ing.spec?.defaultBackend?.service
  if (def?.name) {
    refs.push({
      host: '',
      path: '(default)',
      pathType: 'Default',
      service: text(def.name),
      port: def.port?.number !== undefined ? text(def.port.number) : text(def.port?.name),
    })
  }
  return refs
}

function servicePortMatches(svc: Op, port: string): boolean {
  const ports: Op[] = svc.spec?.ports ?? []
  if (ports.length === 0) return false
  if (!port) return true
  return ports.some(p => text(p.port) === port || text(p.name) === port)
}

function tlsEntries(ing: Op): Op[] {
  return ing.spec?.tls ?? []
}

/** 为某个 host 找 TLS 配置；找不到精确匹配时退回第一条。 */
function tlsForHost(ing: Op, host: string): Op | undefined {
  const entries = tlsEntries(ing)
  if (entries.length === 0) return undefined
  if (!host) return entries[0]
  return entries.find(e => (e.hosts ?? []).some((h: string) => String(h).toLowerCase() === host.toLowerCase()))
    ?? entries[0]
}

function ruleHosts(ing: Op): string[] {
  return uniq((ing.spec?.rules ?? []).map((r: Op) => text(r.host)))
}

function tlsSummary(ing: Op, host: string, ctx: LookupContext): Promise<string> {
  const entry = tlsForHost(ing, host)
  if (!entry?.secretName) return Promise.resolve('')
  return certsForSecret(ctx, text(ing.metadata?.namespace), text(entry.secretName)).then((result) => {
    if (result.missing) return `secret=${entry.secretName} (not found)`
    if (result.certs.length === 0) return `secret=${entry.secretName} (no certificate)`
    const cert = result.certs.find(c => certificateCoversHost(c, host)) ?? result.certs[0]
    return `secret=${entry.secretName} ${describeCert(cert)}`
  })
}

function renderTrace(chains: Op[]): string {
  if (chains.length === 0) {
    return '未找到匹配的 Ingress。可先用 k8s_list_ingresses 确认 host / path，或检查 Ingress 是否在指定命名空间。'
  }
  return chains.map((chain) => {
    const lines = [
      `• ${chain.namespace}/${chain.ingress}  host=${chain.host || '*'}  path=${chain.path} (${chain.pathType})  status=${chain.status}`,
      chain.tls ? `  tls=${chain.tls}` : '',
      chain.service
        ? `  → service ${chain.namespace}/${chain.service}:${chain.servicePort || '-'}  clusterIP=${chain.clusterIP || '-'}`
        : '  → service (not found)',
      chain.endpoints ? `  → endpoints ${chain.endpoints}` : '',
      chain.pods ? `  → pods ${chain.pods}` : '',
    ]
    return lines.filter(Boolean).join('\n')
  }).join('\n\n')
}

export function registerIngressTools(ctx: Context, config: ConfigType): void {
  ctx.tools.register(defineTool({
    name: 'k8s_audit_ingresses',
    description: '体检 Ingress 配置（只读）：TLS Secret 是否存在、证书是否过期/即将过期、证书是否覆盖 host、'
      + 'backend Service 与端口是否存在、是否缺少 ingressClassName。不填 namespace 时检查所有命名空间。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
      namespace: { type: 'string', description: '命名空间；不填则检查所有命名空间。' },
      expireDays: { type: 'integer', description: '证书剩余天数低于该值时告警，缺省 30。' },
      requireTls: { type: 'boolean', description: '是否把「完全没有 TLS 配置」也视为问题，缺省 false。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          checked: { type: 'integer', required: true },
          issues: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                severity: { type: 'string' }, code: { type: 'string' },
                ingress: { type: 'string' }, namespace: { type: 'string' },
                host: { type: 'string' }, message: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.issues.length === 0) {
          return [{ type: 'text', text: `共检查 ${value.checked} 个 Ingress，未发现问题。` }]
        }
        const rows = value.issues.map(i => `• [${i.severity}] ${i.code}  ${i.namespace}/${i.ingress}${i.host ? `  host=${i.host}` : ''}\n  ${i.message}`)
        return [{ type: 'text', text: `共检查 ${value.checked} 个 Ingress，发现 ${value.issues.length} 个问题：\n${rows.join('\n')}` }]
      },
    },
    execute: async (args) => {
      const clients = clientsFor(kubeconfigFor(config, args.cluster))
      const ingresses = await listIngresses(clients, args.namespace)
      const lookup = lookupContext(clients)
      const expireDays = args.expireDays ?? 30
      const issues: Issue[] = []

      for (const ing of ingresses) {
        const namespace = text(ing.metadata?.namespace)
        const name = text(ing.metadata?.name)
        const add = (severity: Issue['severity'], code: string, message: string, host = '') => {
          issues.push({ severity, code, ingress: name, namespace, host, message })
        }

        const className = ing.spec?.ingressClassName
          ?? ing.metadata?.annotations?.['kubernetes.io/ingress.class']
        if (!className) {
          add('warning', 'class-missing', 'Ingress 没有 ingressClassName，可能不会被任何控制器处理。')
        }

        const tls = tlsEntries(ing)
        if (tls.length === 0 && args.requireTls) {
          add('warning', 'tls-missing', 'Ingress 没有配置 TLS。')
        }

        for (const entry of tls) {
          const secretName = text(entry.secretName)
          if (!secretName) {
            add('error', 'tls-secret-name-missing', 'TLS 配置缺少 secretName。')
            continue
          }
          const result = await certsForSecret(lookup, namespace, secretName)
          if (result.missing) {
            add('error', 'tls-secret-missing', `TLS Secret ${secretName} 不存在。`)
            continue
          }
          if (result.certs.length === 0) {
            add('error', 'tls-cert-invalid', `TLS Secret ${secretName} 里没有可解析的证书（期望 tls.crt）。`)
            continue
          }
          for (const cert of result.certs) {
            if (cert.expired) {
              add('error', 'tls-cert-expired', `证书 ${cert.key || '-'} 已于 ${cert.notAfter.slice(0, 10)} 过期。`)
            } else if (cert.daysLeft <= expireDays) {
              add('warning', 'tls-cert-expiring', `证书 ${cert.key || '-'} 剩余 ${cert.daysLeft} 天（阈值 ${expireDays} 天），到期 ${cert.notAfter.slice(0, 10)}。`)
            }
          }
          const ownHosts = (entry.hosts ?? []).map((h: string) => text(h))
          const expected = ownHosts.length > 0 ? uniq(ownHosts) : ruleHosts(ing)
          for (const host of expected) {
            if (!result.certs.some(c => certificateCoversHost(c, host))) {
              add('warning', 'tls-host-mismatch', `证书不覆盖 host ${host}（SAN: ${result.certs[0]?.san || '-'}）。`, host)
            }
          }
        }

        for (const ref of backendRefs(ing)) {
          if (!ref.host && tls.length > 0 && ref.path !== '(default)') {
            add('warning', 'rule-host-missing', '配置了 TLS 但 rule 没有 host。')
          }
          const svc = await serviceFor(lookup, namespace, ref.service)
          if (!svc) {
            add('error', 'backend-service-missing', `backend Service ${ref.service} 不存在。`, ref.host)
            continue
          }
          if (!servicePortMatches(svc, ref.port)) {
            add('error', 'backend-port-missing', `Service ${ref.service} 没有端口 ${ref.port || '-'}（现有：${(svc.spec?.ports ?? []).map((p: Op) => p.name ? `${p.name}:${p.port}` : p.port).join(',') || '无'}）。`, ref.host)
          }
        }
      }

      issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
      return { checked: ingresses.length, issues }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'k8s_trace_ingress',
    description: '按 URL / host 追踪 Ingress 链路（只读）：匹配 host 与 path，返回 Ingress → Service → Endpoints/EndpointSlice → Pods，'
      + '并附带 TLS Secret 的证书摘要。用于定位 404 / 502 / 503 是 Ingress 规则、Service 还是 Pod 的问题。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
      url: { type: 'string', description: '完整 URL（含 http:// 或 https://），会自动解析 host 与 path。' },
      host: { type: 'string', description: '只给 host 时默认 path 为 /；与 url 二选一。' },
      path: { type: 'string', description: '请求路径，缺省 /。' },
      namespace: { type: 'string', description: '只在指定命名空间内查找；不填则搜索所有命名空间。' },
      maxChains: { type: 'integer', description: '最多返回多少条匹配链路，缺省 20。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          chains: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                ingress: { type: 'string' }, namespace: { type: 'string' },
                host: { type: 'string' }, path: { type: 'string' },
                pathType: { type: 'string' }, tls: { type: 'string' },
                service: { type: 'string' }, servicePort: { type: 'string' },
                clusterIP: { type: 'string' }, endpoints: { type: 'string' },
                pods: { type: 'string' }, status: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderTrace(value.chains) }],
    },
    execute: async (args) => {
      let host = (args.host ?? '').trim()
      let requestPath = normalizePath(args.path)
      if (args.url) {
        let parsed: URL
        try {
          parsed = new URL(args.url)
        } catch {
          throw new Error(`无效的 URL："${args.url}"，请包含 http:// 或 https://`)
        }
        host = parsed.hostname
        requestPath = normalizePath(parsed.pathname)
      }
      if (!host) throw new Error('请提供 url 或 host 参数。')

      const clients = clientsFor(kubeconfigFor(config, args.cluster))
      const ingresses = await listIngresses(clients, args.namespace)
      const lookup = lookupContext(clients)
      const chains: Op[] = []
      const limit = args.maxChains ?? 20

      for (const ing of ingresses) {
        if (chains.length >= limit) break
        const refs = backendRefs(ing).filter((ref) => {
          if (ref.path === '(default)') return false
          return hostMatches(ref.host, host) && pathMatches(ref.pathType, ref.path, requestPath)
        })
        const matched = refs.length > 0 ? refs : backendRefs(ing).filter(ref => ref.path === '(default)')
        if (matched.length === 0) continue

        const namespace = text(ing.metadata?.namespace)
        const tls = await tlsSummary(ing, host, lookup)

        for (const ref of matched) {
          if (chains.length >= limit) break
          const svc = await serviceFor(lookup, namespace, ref.service)
          let endpoints = ''
          let pods = ''
          let status = 'ok'

          if (!svc) {
            status = 'service-missing'
          } else {
            const addresses: string[] = []
            try {
              const ep = await clients.core.readNamespacedEndpoints({ name: ref.service, namespace }) as unknown as Op
              for (const subset of ep.subsets ?? []) {
                for (const addr of subset.addresses ?? []) {
                  for (const port of subset.ports ?? []) {
                    addresses.push(`${addr.ip}:${port.port}`)
                  }
                  if ((subset.ports ?? []).length === 0) addresses.push(text(addr.ip))
                }
              }
            } catch { /* Endpoints 可能尚未创建 */ }

            if (addresses.length === 0) {
              try {
                const slices = await clients.discovery.listNamespacedEndpointSlice({
                  namespace,
                  labelSelector: `kubernetes.io/service-name=${ref.service}`,
                }) as unknown as Op
                for (const slice of slices.items ?? []) {
                  for (const endpoint of slice.endpoints ?? []) {
                    if (endpoint.conditions?.ready === false && endpoint.conditions?.serving === false) continue
                    const port = (slice.ports ?? [])[0]?.port
                    for (const ip of endpoint.addresses ?? []) {
                      addresses.push(port ? `${ip}:${port}` : text(ip))
                    }
                  }
                }
              } catch { /* 集群可能未安装 EndpointSlice */ }
            }

            endpoints = uniq(addresses).join(',')
            if (!endpoints) status = 'no-endpoints'

            const selector = selectorString(svc.spec?.selector)
            try {
              const podRes = await clients.core.listNamespacedPod(selector
                ? { namespace, labelSelector: selector }
                : { namespace }) as unknown as Op
              let items: Op[] = podRes.items ?? []
              if (!selector && endpoints) {
                const ips = new Set(addresses.map(a => a.split(':')[0]))
                items = items.filter(pod => {
                  const podIps = [pod.status?.podIP, ...(pod.status?.podIPs ?? []).map((p: Op) => p.ip)]
                  return podIps.some(ip => ip && ips.has(String(ip)))
                })
              }
              pods = items.slice(0, 20).map(p => `${text(p.metadata?.name)}(${text(p.status?.phase) || '-'})`).join(',')
              if (!pods && endpoints) status = 'pod-missing'
            } catch {
              if (status === 'ok') status = 'pod-query-failed'
            }
          }

          chains.push({
            ingress: text(ing.metadata?.name),
            namespace,
            host,
            path: ref.path,
            pathType: ref.pathType,
            tls,
            service: ref.service,
            servicePort: ref.port,
            clusterIP: text(svc?.spec?.clusterIP),
            endpoints,
            pods,
            status,
          })
        }
      }

      return { chains }
    },
  }))
}
