import type { InspectCertificateResult, SignWithCertificateRequest } from '../../../pdf/src/shared/ipc'
import { openCertificate, signPdf, SignError } from '../../../pdf/src/shared/pdf-sign'

type SignOptions = Pick<SignWithCertificateRequest, 'reason' | 'location' | 'contactInfo' | 'certifyLevel' | 'visible'>
type Failure = Extract<Awaited<ReturnType<import('../../../pdf/src/shared/ipc').PdfApi['signWithCertificate']>>, { ok: false; cancelled?: false }>
export type CertificateTask = { bytes: ArrayBuffer; password: string } & (
  | { kind: 'inspect' }
  | { kind: 'sign'; pdf: ArrayBuffer; options: SignOptions }
)
export type CertificateReply = InspectCertificateResult | { ok: true; signed: Uint8Array<ArrayBuffer> } | Failure

const worker = self as unknown as {
  onmessage(event: MessageEvent<CertificateTask>): Promise<void>
  postMessage(reply: CertificateReply, transfer?: ArrayBuffer[]): void
}

async function execute(data: CertificateTask, p12: Uint8Array): Promise<CertificateReply> {
  const certificate = openCertificate(p12, data.password)
  if (!certificate.ok) return certificate
  if (data.kind === 'inspect') return { ok: true, signer: certificate.info[0]!, chain: certificate.info }
  const { visible, ...options } = data.options
  const signed = await signPdf(new Uint8Array(data.pdf), {
    ...options,
    loaded: certificate.loaded,
    ...(visible === undefined ? {} : {
      visible: { ...visible, png: Uint8Array.from(atob(visible.png), char => char.charCodeAt(0)) },
    }),
  }) as Uint8Array<ArrayBuffer>
  return { ok: true, signed }
}

worker.onmessage = async ({ data }) => {
  const p12 = new Uint8Array(data.bytes)
  let reply: CertificateReply
  try {
    reply = await execute(data, p12)
  } catch (error) {
    reply = { ok: false, error: error instanceof SignError ? error.code : 'sign-failed' }
  } finally {
    p12.fill(0)
  }
  worker.postMessage(reply, reply.ok && 'signed' in reply ? [reply.signed.buffer] : [])
}
