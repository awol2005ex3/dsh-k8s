import { Writable } from 'node:stream'
import * as k8s from '@kubernetes/client-node'

/** 收集一块输出流（stdout / stderr）。 */
function collector(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = []
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) { chunks.push(Buffer.from(chunk)); cb() },
  })
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') }
}

function waitForStreams(...streams: Writable[]): Promise<void> {
  return Promise.all(streams.map(s => new Promise<void>((resolve) => {
    if (s.writableEnded || s.writableFinished) return resolve()
    s.once('finish', () => resolve())
    s.once('close', () => resolve())
    // 兜底：exec 通道异常时不至于永久挂起（工具本身也有宿主超时）。
    setTimeout(() => resolve(), 30000).unref?.()
  }))).then(() => undefined)
}

/**
 * 从 V1Status 解析退出码。失败时的真实载荷形如：
 *   { status: 'Failure', reason: 'NonZeroExitCode',
 *     details: { causes: [{ reason: 'ExitCode', message: '3' }] } }
 * 成功时为 Success（无 details）。
 */
export function exitCodeOf(status: k8s.V1Status | undefined): number {
  if (!status) return 0
  const cause = (status.details as { causes?: Array<{ reason?: string; message?: string }> } | undefined)
    ?.causes?.find(c => c.reason === 'ExitCode')
  if (cause?.message && /^\d+$/.test(cause.message)) return Number(cause.message)
  const m = status.message?.match(/(\d+)$/)
  if (m) return Number(m[1])
  return status.status === 'Failure' ? 1 : 0
}

/**
 * 在 Pod 容器内执行命令（只读排查用途）。
 * 走 Kubernetes exec 子资源 + WebSocket，不依赖 kubectl 二进制。
 * 严禁在此工具上扩展任何写/删除能力。
 */
export async function execInPod(
  kc: k8s.KubeConfig,
  opts: { namespace: string; pod: string; container?: string; command: string[] },
): Promise<{ output: string; exitCode: number }> {
  const out = collector()
  const err = collector()
  const exec = new k8s.Exec(kc)

  // statusCallback 通常在流结束前后异步触发；用 promise 与流一起等待，避免读到空状态。
  let resolveStatus: (s: k8s.V1Status | undefined) => void = () => {}
  const statusPromise = new Promise<k8s.V1Status | undefined>((resolve) => { resolveStatus = resolve })
  const statusTimer = setTimeout(() => resolveStatus(undefined), 30000)
  statusTimer.unref?.()

  await exec.exec(
    opts.namespace,
    opts.pod,
    opts.container ?? '',
    opts.command,
    out.stream,
    err.stream,
    null,           // stdin：不提供，杜绝交互式写入
    false,          // tty：关闭，避免终端转义污染输出
    (status) => { resolveStatus(status) },
  )

  // exec() 在 WebSocket 建立即 resolve；等流与状态回调都完成。
  const [, status] = await Promise.all([waitForStreams(out.stream, err.stream), statusPromise])
  clearTimeout(statusTimer)

  const combined = out.text() + (err.text() ? `\n[stderr]\n${err.text()}` : '')
  return { output: combined, exitCode: exitCodeOf(status) }
}