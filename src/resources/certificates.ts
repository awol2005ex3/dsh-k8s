import type { KubeObject } from '../types.js'
import type { ResourceRegistry } from './types.js'
import { itemsOf } from './types.js'
import { row } from '../describe/common.js'

function summaryCsr(csr: KubeObject): string {
  const conditions = (csr.status?.conditions ?? [])
    .map((c: KubeObject) => `${c.type}=${c.status}`)
    .join(',')
  return row(
    `signer=${csr.spec?.signerName ?? '-'}`,
    `requestor=${csr.spec?.username ?? '-'}`,
    `conditions=${conditions || '-'}`,
  )
}

export const certificatesResources: ResourceRegistry = {
  certificatesigningrequests: {
    scope: 'Cluster',
    list: c => itemsOf(c.certificates.listCertificateSigningRequest({})),
    get: (c, _ns, name) => c.certificates.readCertificateSigningRequest({ name }),
    summary: summaryCsr,
  },
}
