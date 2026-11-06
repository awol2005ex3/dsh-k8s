import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { gunzipSync } from 'node:zlib'
import { kubeconfigFor, clientsFor } from '../config.js'
import type { Config as ConfigType } from '../types.js'

type Op = Record<string, any>
type Clients = ReturnType<typeof clientsFor>

/** Helm 3 的 Secret 命名：sh.helm.release.v1.<release>.v<revision>。 */
const RELEASE_SECRET = /^sh\.helm\.release\.v1\.(.+)\.v(\d+)$/
const ALLOWED_INCLUDE = ['meta', 'values', 'config', 'manifest', 'chart', 'templates', 'notes', 'all'] as const

interface LoadedRelease {
  secret: Op
  release: Op
  secretName: string
  releaseName: string
  revision: number
  namespace: string
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

function iso(value: unknown): string {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? text(value) : date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n... (truncated, ${value.length} chars)` : value
}

/**
 * 解码 Helm release。链路（Helm 3 Secret 存储）：
 *   secret.data.release（外层 base64 字符串）
 *   → 第一层 base64 解码 → 得到内层 base64 字符串文本
 *   → 第二层 base64 解码 → 得到 gzip 压缩字节
 *   → gunzip → JSON
 * 全程本地解析，不调用 helm 命令。
 */
function decodeRelease(secret: Op): Op | null {
  const raw = secret.data?.release
  if (raw === undefined || raw === null) return null

  // 第一层 base64 解码 → 内层 base64 字符串文本（也可能是 gzip 字节或 JSON）
  const layer1 = Buffer.from(String(raw), 'base64').toString('utf8')
  if (!layer1) return null

  let payload: Buffer
  const trimmed = layer1.trim()

  // 第二层：若第一层结果像 base64 文本，再解码一次；否则直接用第一层
  if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) {
    try {
      const layer2 = Buffer.from(trimmed, 'base64')
      // 第二层是 gzip 魔数 → gunzip；否则可能就是 JSON 原文
      if (layer2[0] === 0x1f && layer2[1] === 0x8b) {
        try {
          payload = gunzipSync(layer2)
        } catch {
          payload = layer2
        }
      } else {
        payload = layer2
      }
    } catch {
      payload = Buffer.from(layer1, 'utf8')
    }
  } else {
    payload = Buffer.from(layer1, 'utf8')
  }

  // 兜底：payload 本身仍是 gzip（某些后端只存一层 base64）
  if (payload[0] === 0x1f && payload[1] === 0x8b) {
    try {
      payload = gunzipSync(payload)
    } catch {
      return null
    }
  }

  try {
    const parsed = JSON.parse(payload.toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed as Op : null
  } catch {
    return null
  }
}

/** 读取 Helm 3 Secret；label 缺失时按名称前缀兜底（兼容老 release）。 */
async function loadReleases(clients: Clients, namespace?: string): Promise<LoadedRelease[]> {
  // 主路径：按名称前缀扫描（不依赖 owner=helm label，华为 CCE 等后端常缺该 label）。
  // 先按 namespace 过滤出候选 secret，再逐条解析。
  let secrets: Op[] = []
  if (namespace) {
    const res = await clients.core.listNamespacedSecret({ namespace }) as unknown as Op
    secrets = (res.items ?? []) as unknown as Op[]
  } else {
    const res = await clients.core.listSecretForAllNamespaces({}) as unknown as Op
    secrets = (res.items ?? []) as unknown as Op[]
  }

  const loaded: LoadedRelease[] = []
  for (const secret of secrets) {
    const secretName = text(secret.metadata?.name)
    const match = RELEASE_SECRET.exec(secretName)
    if (!match) continue
    const release = decodeRelease(secret)
    if (!release) continue
    loaded.push({
      secret,
      release,
      secretName,
      releaseName: text(release.name) || match[1],
      revision: Number(match[2]) || 0,
      namespace: text(secret.metadata?.namespace),
    })
  }
  return loaded
}

function latestPerRelease(releases: LoadedRelease[]): LoadedRelease[] {
  const map = new Map<string, LoadedRelease>()
  for (const item of releases) {
    const key = `${item.namespace}/${item.releaseName}`
    const previous = map.get(key)
    if (!previous || item.revision > previous.revision) map.set(key, item)
  }
  return [...map.values()]
}

function rowOf(item: LoadedRelease): Op {
  const info = item.release.info ?? {}
  const meta = item.release.chart?.metadata ?? {}
  return {
    name: item.releaseName,
    namespace: item.namespace,
    revision: item.revision,
    status: text(info.status),
    chart: text(meta.name),
    chartVersion: text(meta.version),
    appVersion: text(meta.appVersion),
    updated: iso(info.last_deployed) || iso(item.secret.metadata?.creationTimestamp),
    description: truncate(text(info.description), 200),
  }
}

function renderList(rows: Op[]): string {
  if (rows.length === 0) return '（未发现 Helm release；只支持 Helm 3 的 Secret 存储）'
  return rows.map(r => [
    `• ${r.name}`,
    `ns=${r.namespace}`,
    `rev=${r.revision}`,
    `status=${r.status || '-'}`,
    `chart=${r.chart || '-'}`,
    `version=${r.chartVersion || '-'}`,
    r.appVersion ? `appVersion=${r.appVersion}` : '',
    `updated=${r.updated || '-'}`,
    r.description ? `desc=${r.description}` : '',
  ].filter(Boolean).join('  ')).join('\n')
}

export function registerHelmTools(ctx: Context, config: ConfigType): void {
  ctx.tools.register(defineTool({
    name: 'k8s_list_helm_releases',
    description: '列出 Helm 3 release（只读，直接解析 sh.helm.release.v1.* Secret，不调用 helm 命令）。'
      + '默认每个 release 只显示最新 revision，可按命名空间与状态过滤。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
      namespace: { type: 'string', description: '命名空间；不填则读取所有命名空间。' },
      status: { type: 'string', description: '按状态过滤，例如 deployed / failed / pending-install / superseded。' },
      allRevisions: { type: 'boolean', description: '是否列出所有 revision，缺省 false（只列最新）。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          releases: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string' }, namespace: { type: 'string' },
                revision: { type: 'integer' }, status: { type: 'string' },
                chart: { type: 'string' }, chartVersion: { type: 'string' },
                appVersion: { type: 'string' }, updated: { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderList(value.releases) }],
    },
    execute: async (args) => {
      const clients = clientsFor(kubeconfigFor(config, args.cluster))
      let releases = await loadReleases(clients, args.namespace)
      if (!args.allRevisions) releases = latestPerRelease(releases)
      if (args.status) releases = releases.filter(r => text(r.release.info?.status) === args.status)

      const rows = releases.map(rowOf)
        .sort((a, b) => `${a.namespace}/${a.name}/${String(a.revision).padStart(6, '0')}`
          .localeCompare(`${b.namespace}/${b.name}/${String(b.revision).padStart(6, '0')}`))
      return { releases: rows }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'k8s_get_helm_release',
    description: '查看单个 Helm 3 release 的详情（只读，不调用 helm 命令）：chart 元数据、用户 values、chart 默认 values、'
      + '渲染后的 manifest 与 NOTES。注意 values / manifest 可能包含明文密钥，默认只返回元数据。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
      namespace: { type: 'string', required: true, description: 'release 所在命名空间。' },
      name: { type: 'string', required: true, description: 'release 名称。' },
      revision: { type: 'integer', description: '指定 revision；缺省取最新。' },
      include: {
        type: 'string',
        description: '要包含的内容，逗号分隔：meta | values | config | manifest | chart | templates | notes | all。缺省 meta。',
      },
      maxChars: { type: 'integer', description: '每段内容的最大字符数，缺省 200000。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string' }, namespace: { type: 'string' },
          revision: { type: 'integer' }, status: { type: 'string' },
          chart: { type: 'string' }, chartVersion: { type: 'string' },
          appVersion: { type: 'string' }, updated: { type: 'string' },
          description: { type: 'string' }, chartMetadata: { type: 'string' },
          values: { type: 'string' }, userValues: { type: 'string' },
          manifest: { type: 'string' }, templates: { type: 'string' },
          notes: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const lines = [
          `• ${value.namespace}/${value.name}  rev=${value.revision}  status=${value.status || '-'}`,
          `  chart=${value.chart || '-'} version=${value.chartVersion || '-'}${value.appVersion ? ` appVersion=${value.appVersion}` : ''}`,
          `  updated=${value.updated || '-'}`,
          value.description ? `  desc=${value.description}` : '',
        ].filter(Boolean)
        const sections: Array<[string, string | undefined]> = [
          ['chart metadata', value.chartMetadata],
          ['chart values (JSON)', value.values],
          ['user values (JSON)', value.userValues],
          ['manifest', value.manifest],
          ['templates', value.templates],
          ['notes', value.notes],
        ]
        for (const [label, body] of sections) {
          if (body) lines.push(`\n===== ${label} =====\n${body}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args) => {
      const include = new Set((args.include ?? 'meta').split(',').map(s => s.trim()).filter(Boolean))
      for (const token of include) {
        if (!(ALLOWED_INCLUDE as readonly string[]).includes(token)) {
          throw new Error(`不支持的 include "${token}"，可用：${ALLOWED_INCLUDE.join(', ')}`)
        }
      }
      if (include.has('all')) {
        for (const token of ['meta', 'values', 'config', 'manifest', 'chart', 'templates', 'notes']) include.add(token)
      }

      const clients = clientsFor(kubeconfigFor(config, args.cluster))
      const releases = await loadReleases(clients, args.namespace)
      const matched = releases
        .filter(r => r.releaseName === args.name)
        .filter(r => args.revision === undefined || r.revision === args.revision)
        .sort((a, b) => b.revision - a.revision)
      const found = matched[0]
      if (!found) {
        const available = [...new Set(releases.map(r => r.releaseName))].join(', ') || '无'
        throw new Error(`未找到 Helm release "${args.name}"${args.revision !== undefined ? ` revision ${args.revision}` : ''}，命名空间内可用：${available}`)
      }

      const limit = args.maxChars ?? 200_000
      const row = rowOf(found)
      const chartMeta = found.release.chart?.metadata ?? {}
      const chartValues = found.release.chart?.values
      const userValues = found.release.config
      const manifest = text(found.release.manifest)
      const notes = text(found.release.info?.notes)
      const templateNames = (found.release.chart?.templates ?? []).map((t: Op) => text(t.name)).filter(Boolean)

      return {
        name: row.name as string,
        namespace: row.namespace as string,
        revision: row.revision as number,
        status: row.status as string,
        chart: row.chart as string,
        chartVersion: row.chartVersion as string,
        appVersion: row.appVersion as string,
        updated: row.updated as string,
        description: row.description as string,
        chartMetadata: include.has('chart') || include.has('meta')
          ? truncate(JSON.stringify(chartMeta, null, 2), limit)
          : '',
        values: include.has('values') && chartValues !== undefined
          ? truncate(JSON.stringify(chartValues, null, 2), limit)
          : '',
        userValues: include.has('config') && userValues !== undefined
          ? truncate(JSON.stringify(userValues, null, 2), limit)
          : '',
        manifest: include.has('manifest') ? truncate(manifest, limit) : '',
        templates: include.has('templates') ? truncate(templateNames.join('\n'), limit) : '',
        notes: include.has('notes') ? truncate(notes, limit) : '',
      }
    },
  }))
}
