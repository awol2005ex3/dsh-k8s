/**
 * Java 应用识别与 JVM 参数解析（纯函数，无 IO）。
 * 数据来源两类：
 *   - spec：Pod 声明里的 containers[].command / args / env（JAVA_OPTS 等）
 *   - exec：容器内 /proc/1/cmdline、ps、env、/proc/<pid>/task（运行时真实值，优先级更高）
 */

import type { Op } from './pod-targets.js'
import { text } from './pod-targets.js'

/** K8s 资源数量串（512Mi / 1Gi / 500M / 纯字节）→ Ki；无法解析返回 null。 */
export function parseK8sMemoryKi(raw: string): number | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([kKmMgGtTpPeE])(i?)$/)
  if (m) {
    const n = Number(m[1])
    if (!Number.isFinite(n)) return null
    const base = m[3] === 'i' ? 1024 : 1000
    const pow: Record<string, number> = { K: 1, M: 2, G: 3, T: 4, P: 5, E: 6 }
    return Math.round(n * Math.pow(base, pow[m[2].toUpperCase()]))
  }
  if (/^\d+(\.\d+)?$/.test(s)) {
    const bytes = Number(s)
    return Number.isFinite(bytes) ? Math.round(bytes / 1024) : null
  }
  return null
}

/** JVM 参数串（-Xmx 的值：1g / 512m / 262144k / 纯字节；JVM 按 1024 进制）→ Ki。 */
export function parseJvmMemoryKi(raw: string): number | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([kKmMgGtT])$/)
  if (m) {
    const n = Number(m[1])
    if (!Number.isFinite(n)) return null
    const pow: Record<string, number> = { K: 1, M: 2, G: 3, T: 4 }
    return Math.round(n * Math.pow(1024, pow[m[2].toUpperCase()]))
  }
  if (/^\d+(\.\d+)?$/.test(s)) {
    const bytes = Number(s)
    return Number.isFinite(bytes) ? Math.round(bytes / 1024) : null
  }
  return null
}

/** Ki → 人类可读（优先 Gi / Mi / Ki）。 */
export function formatKi(ki: number | null): string {
  if (ki === null) return '?'
  if (ki >= 1024 ** 3 && ki % (1024 ** 3) === 0) return `${ki / 1024 ** 3}Gi`
  if (ki >= 1024 ** 2 && ki % (1024 ** 2) === 0) return `${ki / 1024 ** 2}Mi`
  if (ki >= 1024 && ki % 1024 === 0) return `${ki / 1024}Ki`
  return `${ki}Ki`
}

export interface JvmFlags {
  xmx?: string
  xms?: string
  xmn?: string
  /** 其他值得关注的 -XX 参数（Metaspace / DirectMemory / RAMPercentage 等）。 */
  extra: Record<string, string>
}

export function emptyFlags(): JvmFlags {
  return { extra: {} }
}

const XX_INTERESTING = /^(MaxMetaspaceSize|MaxDirectMemorySize|MaxRAMPercentage|InitialRAMPercentage|ActiveProcessorCount|MaxRAM)$/i

/** 从一段命令行 / 环境变量值里抽取 -Xmx / -Xms / -Xmn 与关注项 -XX 参数。 */
export function extractJvmFlags(cmdline: string): JvmFlags {
  const flags = emptyFlags()
  if (!cmdline) return flags
  const tokens = cmdline.split(/\s+/)
  for (const token of tokens) {
    let m = token.match(/^-Xmx(\S+)$/)
    if (m) { flags.xmx ??= m[1]; continue }
    m = token.match(/^-Xms(\S+)$/)
    if (m) { flags.xms ??= m[1]; continue }
    m = token.match(/^-Xmn(\S+)$/)
    if (m) { flags.xmn ??= m[1]; continue }
    m = token.match(/^-XX:(\w+)=(\S+)$/)
    if (m && XX_INTERESTING.test(m[1])) {
      const key = m[1]
      flags.extra[key] ??= m[2]
    }
  }
  return flags
}

function mergeFlags(...sources: JvmFlags[]): JvmFlags {
  const out = emptyFlags()
  for (const src of sources) {
    out.xmx ??= src.xmx
    out.xms ??= src.xms
    out.xmn ??= src.xmn
    for (const [k, v] of Object.entries(src.extra)) out.extra[k] ??= v
  }
  return out
}

export interface JavaProbe {
  isJava: boolean
  /** spec = Pod 声明可见；exec = 容器内运行时取证。 */
  source: 'spec' | 'exec' | 'none'
  /** 找到的 java 命令行（截断预览用）。 */
  command: string
  jar: string
  flags: JvmFlags
  /** java 进程线程总数（仅 exec 来源可得）。 */
  threads: number
}

const JAVA_HINT = /(^|[\s/=])java(\s|$)|\.jar(\s|$|"|')|-Xmx|-Xms/

function probeFromCommand(command: string, source: 'spec' | 'exec'): JavaProbe {
  const trimmed = command.trim()
  const isJava = JAVA_HINT.test(trimmed)
  const flags = isJava ? extractJvmFlags(trimmed) : emptyFlags()
  const jar = trimmed.match(/([\w./-]+\.jar)/)?.[1] ?? ''
  return { isJava, source: isJava ? source : 'none', command: trimmed.slice(0, 300), jar, flags, threads: 0 }
}

/** 从 Pod spec 的容器定义里取 Java 证据：command / args / JAVA_OPTS 类 env。 */
export function probeFromSpec(container: Op): JavaProbe {
  const cmd = [
    ...(Array.isArray(container.command) ? container.command.map(text) : []),
    ...(Array.isArray(container.args) ? container.args.map(text) : []),
  ].join(' ')
  const envJava = (container.env ?? [])
    .filter((e: Op) => /^(JAVA_OPTS|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JVM_OPTS)$/i.test(text(e.name)))
    .map((e: Op) => text(e.value))
    .join(' ')
  const combined = `${cmd} ${envJava}`.trim()
  if (!combined) return { isJava: false, source: 'none', command: '', jar: '', flags: emptyFlags(), threads: 0 }
  return probeFromCommand(combined, 'spec')
}

/**
 * 容器内取证脚本（sh 兼容，全部只读）：
 * PID1 命令行 + ps 里的 java 进程 + JAVA_* 环境变量 + java 进程线程数。
 */
export const JAVA_PROBE_SCRIPT = [
  'echo ===CMD===',
  'tr \'\\0\' \' \' </proc/1/cmdline 2>/dev/null; echo',
  'echo ===PS===',
  "ps -ef 2>/dev/null | grep -i '[j]ava' | head -5",
  'echo ===ENV===',
  "env 2>/dev/null | grep -iE '^(JAVA_OPTS|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JVM_OPTS)='",
  'echo ===THR===',
  'for p in /proc/[0-9]*; do c=$(tr \'\\0\' \' \' <"$p/cmdline" 2>/dev/null); case "$c" in *java*) echo "T ${p#/proc/} $(ls "$p/task" 2>/dev/null | wc -l) $c";; esac; done',
  'echo ===END===',
].join('; ')

/** 解析 JAVA_PROBE_SCRIPT 的输出；脚本失败（无 sh / distroless）时返回 isJava=false。 */
export function parseJavaProbeOutput(output: string): JavaProbe {
  const section = (name: string): string => {
    const start = output.indexOf(`===${name}===`)
    if (start < 0) return ''
    const rest = output.slice(start + name.length + 5)
    const end = rest.indexOf('===')
    return (end >= 0 ? rest.slice(0, end) : rest).trim()
  }

  const cmd1 = section('CMD')
  const ps = section('PS')
  const env = section('ENV')
  const thr = section('THR')

  const candidates = [
    cmd1,
    ...ps.split('\n').map(l => l.trim()).filter(Boolean),
    ...thr.split('\n').filter(l => l.startsWith('T ')).map(l => l.replace(/^T \d+ \d+ /, '').trim()),
  ].filter(Boolean)

  const envValues = env.split('\n').map(l => l.split('=').slice(1).join('=')).filter(Boolean)

  const javaCandidates = candidates.filter(c => JAVA_HINT.test(c))
  const best = javaCandidates.find(c => /-Xmx|-Xms|\.jar/.test(c)) ?? javaCandidates[0] ?? ''
  const isJava = javaCandidates.length > 0 || envValues.length > 0

  // 线程数：取所有 java 进程的 /task 计数之和（通常只有一个 java 进程）。
  let threads = 0
  for (const line of thr.split('\n')) {
    const m = line.match(/^T \d+ (\d+) /)
    if (m) threads += Number(m[1]) || 0
  }

  const flags = mergeFlags(
    ...candidates.map(c => extractJvmFlags(c)),
    ...envValues.map(v => extractJvmFlags(v)),
  )

  const command = best || cmd1
  return {
    isJava,
    source: isJava ? 'exec' : 'none',
    command: command.slice(0, 300),
    jar: command.match(/([\w./-]+\.jar)/)?.[1] ?? '',
    flags,
    threads,
  }
}

/** 合并 spec 与 exec 两路证据：运行时（exec）优先，spec 兜底。 */
export function mergeProbes(spec: JavaProbe, runtime: JavaProbe | null): JavaProbe {
  if (!runtime || (!runtime.isJava && runtime.threads === 0 && !runtime.command)) {
    return spec
  }
  return {
    isJava: spec.isJava || runtime.isJava,
    source: runtime.isJava ? 'exec' : (spec.isJava ? 'spec' : 'none'),
    command: runtime.command || spec.command,
    jar: runtime.jar || spec.jar,
    flags: mergeFlags(runtime.flags, spec.flags),
    threads: runtime.threads || spec.threads,
  }
}

export interface MemoryViolation {
  kind: 'xmx-over-limit' | 'xms-over-limit' | 'xms-over-xmx'
  message: string
}

/**
 * JVM 内存红线判读（与 dsh-k8s-jvm-diagnosis 知识卡一致）：
 * -Xmx > limit、-Xms > limit、-Xms > -Xmx。
 */
export function memoryViolations(limitKi: number | null, flags: JvmFlags): MemoryViolation[] {
  const out: MemoryViolation[] = []
  const xmxKi = parseJvmMemoryKi(flags.xmx ?? '')
  const xmsKi = parseJvmMemoryKi(flags.xms ?? '')
  if (limitKi !== null && xmxKi !== null && xmxKi > limitKi) {
    out.push({ kind: 'xmx-over-limit', message: `-Xmx${flags.xmx}(${formatKi(xmxKi)}) 超过容器 limit.memory(${formatKi(limitKi)})，运行时堆会被压限甚至 OOMKilled` })
  }
  if (limitKi !== null && xmsKi !== null && xmsKi > limitKi) {
    out.push({ kind: 'xms-over-limit', message: `-Xms${flags.xms}(${formatKi(xmsKi)}) 超过容器 limit.memory(${formatKi(limitKi)})，启动即可能崩溃` })
  }
  if (xmsKi !== null && xmxKi !== null && xmsKi > xmxKi) {
    out.push({ kind: 'xms-over-xmx', message: `-Xms${flags.xms} 大于 -Xmx${flags.xmx}，属调优错误配置` })
  }
  return out
}

/** 把 flags 渲染成一行紧凑文本。 */
export function renderFlags(flags: JvmFlags): string {
  const parts: string[] = []
  if (flags.xmx) parts.push(`-Xmx=${flags.xmx}`)
  if (flags.xms) parts.push(`-Xms=${flags.xms}`)
  if (flags.xmn) parts.push(`-Xmn=${flags.xmn}`)
  for (const [k, v] of Object.entries(flags.extra)) parts.push(`-XX:${k}=${v}`)
  return parts.join(' ')
}
