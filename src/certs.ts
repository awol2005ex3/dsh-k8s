import { X509Certificate } from 'node:crypto'

/** 一张证书的可读摘要（不包含私钥，解析后即丢弃原始 PEM）。 */
export interface CertInfo {
  /** Secret 里的 key 名，例如 tls.crt / ca.crt。 */
  key: string
  subject: string
  issuer: string
  /** 逗号分隔的 DNS SAN。 */
  san: string
  notBefore: string
  notAfter: string
  /** 距离过期还有多少天；已过期时为负数。 */
  daysLeft: number
  expired: boolean
}

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

/** 把 X509 的 subject/issuer 多行格式压成单行，便于表格渲染。 */
function flattenName(value: string): string {
  return value.replace(/\r?\n/g, ', ').replace(/,\s*,/g, ',').trim()
}

/** 从 subject 行里取 CN（用于 SAN 为空时的兜底匹配）。 */
function commonName(subject: string): string {
  const item = flattenName(subject)
    .split(',')
    .map(s => s.trim())
    .find(s => s.startsWith('CN='))
  return item ? item.slice(3) : ''
}

/** 解析一段 PEM 里的全部证书；无法解析的块直接跳过，不影响其它证书。 */
export function parseCertificates(pem: string, key = ''): CertInfo[] {
  const now = Date.now()
  const certs: CertInfo[] = []
  for (const block of pem.match(PEM_BLOCK) ?? []) {
    try {
      const cert = new X509Certificate(block)
      const notBefore = new Date(cert.validFrom)
      const notAfter = new Date(cert.validTo)
      if (Number.isNaN(notAfter.getTime())) continue
      certs.push({
        key,
        subject: flattenName(cert.subject),
        issuer: flattenName(cert.issuer),
        san: cert.subjectAltName ?? '',
        notBefore: notBefore.toISOString(),
        notAfter: notAfter.toISOString(),
        daysLeft: Math.ceil((notAfter.getTime() - now) / 86_400_000),
        expired: notAfter.getTime() < now,
      })
    } catch {
      // 忽略单个坏证书块
    }
  }
  return certs
}

/** Secret.data 的值在客户端里通常是 base64 字符串，也兼容 Buffer。 */
export function decodeBase64Text(value: unknown): string {
  if (typeof value === 'string') {
    if (!value) return ''
    return Buffer.from(value, 'base64').toString('utf8')
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  return ''
}

/** webhook caBundle 在客户端模型里是 Buffer，兼容 base64 字符串。 */
export function decodeCaBundle(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') {
    // 兼容「已经是 PEM」的少见情况
    return value.includes('BEGIN CERTIFICATE') ? value : Buffer.from(value, 'base64').toString('utf8')
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  return ''
}

/** 证书里声明的 DNS 名称（SAN + CN 兜底）。 */
export function certificateNames(cert: CertInfo): string[] {
  const san = cert.san
    .split(/,\s*/)
    .map(s => s.trim())
    .filter(s => /^DNS:/i.test(s))
    .map(s => s.replace(/^DNS:/i, '').trim().toLowerCase())
  const cn = commonName(cert.subject).toLowerCase()
  return [...new Set([...san, cn].filter(Boolean))]
}

/** 单层通配符匹配：*.example.com 只匹配 a.example.com，不匹配 a.b.example.com。 */
export function certificateCoversHost(cert: CertInfo, host: string): boolean {
  const target = host.toLowerCase().replace(/\.$/, '')
  if (!target) return false
  for (const name of certificateNames(cert)) {
    if (name === target) return true
    if (!name.startsWith('*.')) continue
    const suffix = name.slice(2)
    const dot = target.indexOf('.')
    if (dot > 0 && target.slice(dot + 1) === suffix) return true
  }
  return false
}

/** 一张证书的一行摘要。 */
export function describeCert(cert: CertInfo): string {
  const names = certificateNames(cert).join(',')
  return [
    cert.key ? `key=${cert.key}` : '',
    `CN=${commonName(cert.subject) || '-'}`,
    names ? `SAN=${names}` : '',
    `issuer=${commonName(cert.issuer) || cert.issuer || '-'}`,
    `expires=${cert.notAfter.slice(0, 10)}`,
    cert.expired ? 'EXPIRED' : `剩余${cert.daysLeft}天`,
  ].filter(Boolean).join('  ')
}
