/**
 * 三个批量搜索工具共享的参数片段与默认值收口。
 * `as const` 保证 `required: true` / `enum` 的字面量类型能被 defineTool 正确推断。
 */

export const POD_TARGET_PARAMS = {
  cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
  namespace: { type: 'string', description: '命名空间；缺省 default。设置 allNamespaces 时忽略。' },
  allNamespaces: { type: 'boolean', description: '跨所有命名空间搜索（等价 kubectl -A）。大规模排查时常用，缺省 false。' },
  labelSelector: { type: 'string', description: '标签选择器，例如 app=api,tier=backend；用于缩小扫描范围。' },
  kind: { type: 'string', description: '工作负载类型：deployment | statefulset | daemonset | replicaset | job；与 name 配合使用。' },
  name: { type: 'string', description: '工作负载名称；与 labelSelector 二选一。' },
  podNameRegex: { type: 'string', description: '用正则再过滤 Pod 名（在 selector 之后生效），例如 "^order-"。' },
  container: { type: 'string', description: '只处理指定容器名；不填则处理每个 Pod 的所有容器。' },
  includeCompleted: { type: 'boolean', description: '是否包含已 Succeeded 的 Pod（默认排除，避免读到历史 Job）。' },
  maxPods: { type: 'integer', description: '最多扫描多少个 Pod，缺省 50；上限 500。' },
} as const

export const GREP_PARAMS = {
  pattern: { type: 'string', required: true, description: '搜索串。regex=false 时按字面子串匹配（等价于 grep -F）。' },
  regex: { type: 'boolean', description: '把 pattern 当正则表达式（等价 grep -E），缺省 false。' },
  ignoreCase: { type: 'boolean', description: '忽略大小写（等价 grep -i），缺省 false。' },
  before: { type: 'integer', description: '命中行之前保留的上下文行数，等价 grep -B；缺省 0，上限 1000。' },
  after: { type: 'integer', description: '命中行之后保留的上下文行数，等价 grep -A；缺省 0，上限 1000。例如 -A 111 填 111。' },
  maxMatches: { type: 'integer', description: '单个容器流最多保留多少处命中，缺省 200，上限 2000。' },
  maxTotalMatches: { type: 'integer', description: '全局最多保留多少处命中，缺省 500。' },
  maxChars: { type: 'integer', description: '渲染文本总字符上限，缺省 120000，防止大规模搜索把上下文撑爆。' },
} as const

export const LOG_SCAN_PARAMS = {
  tailLines: { type: 'integer', description: '每个容器读取的日志尾部行数，缺省 500（搜索场景比默认 200 更大）。' },
  sinceSeconds: { type: 'integer', description: '只读取最近 N 秒的日志。' },
  timestamps: { type: 'boolean', description: '每行前附带时间戳，缺省 false。' },
  previous: { type: 'boolean', description: '读取上一次容器实例的日志（排查 CrashLoopBackOff），缺省 false。' },
} as const

export const CONCURRENCY_PARAM = {
  concurrency: { type: 'integer', description: '并发读取的 Pod 数，缺省 5，上限 20。大规模搜索可调大但会加重 API Server 负载。' },
} as const

/** defineTool 推断出的参数对象形状（这里用宽松索引类型做默认值收口）。 */
export type SearchArgs = Record<string, any>

const DEFAULT_MAX_PODS = 50
const MAX_PODS = 500
const DEFAULT_CONCURRENCY = 5
const MAX_CONCURRENCY = 20
const DEFAULT_MAX_MATCHES = 200
const DEFAULT_MAX_TOTAL = 500
const DEFAULT_MAX_CHARS = 120000

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, n))
}

export interface ResolvedSearchSettings {
  maxPods: number
  concurrency: number
  maxMatches: number
  maxTotalMatches: number
  maxChars: number
  before: number
  after: number
  regex: boolean
  ignoreCase: boolean
  pattern: string
}

export function resolveSearchSettings(args: SearchArgs): ResolvedSearchSettings {
  return {
    maxPods: boundedInt(args.maxPods, DEFAULT_MAX_PODS, 1, MAX_PODS),
    concurrency: boundedInt(args.concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY),
    maxMatches: boundedInt(args.maxMatches, DEFAULT_MAX_MATCHES, 1, 2000),
    maxTotalMatches: boundedInt(args.maxTotalMatches, DEFAULT_MAX_TOTAL, 1, 10000),
    maxChars: boundedInt(args.maxChars, DEFAULT_MAX_CHARS, 1000, 1000000),
    before: boundedInt(args.before, 0, 0, 1000),
    after: boundedInt(args.after, 0, 0, 1000),
    regex: args.regex === true,
    ignoreCase: args.ignoreCase === true,
    pattern: String(args.pattern ?? ''),
  }
}
