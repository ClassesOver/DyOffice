import { X509Certificate } from 'node:crypto'
import forge from 'node-forge'
import type { InspectCertificateResult } from '../shared/ipc'
import {
  openCertificate as openSharedCertificate,
  openExternalCertificate as openSharedExternalCertificate,
  type ExternalSigner,
} from '../shared/pdf-sign'
import { useNativePkcs12Crypto } from './forge-native'
import { describeCertificate } from './pdf-signatures'

export { loadCertificate, signPdf, SignError } from '../shared/pdf-sign'
export type { ExternalSigner, SignPdfOptions } from '../shared/pdf-sign'

useNativePkcs12Crypto()

const describe = (cert: forge.pki.Certificate) => describeCertificate(new X509Certificate(
  Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary'),
))

export function openCertificate(p12: Uint8Array, password: string, wantedSha1?: string) {
  return openSharedCertificate(p12, password, wantedSha1, describe)
}

export function openExternalCertificate(signer: ExternalSigner) {
  return openSharedExternalCertificate(signer, describe)
}

export function inspectCertificate(
  p12: Uint8Array,
  password: string,
  wantedSha1?: string,
): InspectCertificateResult {
  const opened = openCertificate(p12, password, wantedSha1)
  return opened.ok ? { ok: true, signer: opened.info[0]!, chain: opened.info } : opened
}
