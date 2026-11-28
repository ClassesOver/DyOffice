import type { PdfApi, SignWithCertificateRequest, SignWithCertificateResult } from '../../../pdf/src/shared/ipc'
import { pickLocalFiles } from './pick-local-files'
import type { CertificateReply, CertificateTask } from './pdf-certificate.worker'

const MAX_CERTIFICATE_BYTES = 2 * 1024 * 1024
const MAX_PDF_SIGN_BYTES = 64 * 1024 * 1024
const positions = new Set(['bottom-right', 'bottom-left', 'top-right', 'top-left', 'center'])

function validOptions(request: SignWithCertificateRequest): boolean {
  if (request.certifyLevel !== undefined && ![1, 2, 3].includes(request.certifyLevel)) return false
  const visible = request.visible
  return visible === undefined || (
    Number.isSafeInteger(visible.pageIndex) && visible.pageIndex >= 0
    && positions.has(visible.position)
    && Number.isFinite(visible.width) && visible.width >= 40 && visible.width <= 800
    && Number.isFinite(visible.height) && visible.height >= 20 && visible.height <= 800
    && typeof visible.png === 'string' && visible.png.length <= 8 * 1024 * 1024
    && visible.png.startsWith('iVBORw0KGgo')
  )
}

function runCertificateWorker(job: CertificateTask, signal: AbortSignal): Promise<CertificateReply> {
  signal.throwIfAborted()
  const worker = new Worker(new URL('./pdf-certificate.worker.ts', import.meta.url), { type: 'module' })
  const transfer = job.kind === 'sign' ? [job.bytes, job.pdf] : [job.bytes]
  let onAbort: (() => void) | undefined
  return new Promise<CertificateReply>((resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    worker.onmessage = ({ data }: MessageEvent<CertificateReply>) => resolve(data)
    worker.onerror = worker.onmessageerror = () => reject(Error('PDF certificate worker failed'))
    try { worker.postMessage(job, transfer) } catch (error) { reject(error) }
  }).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort)
    worker.terminate()
  })
}

type CertificateApi = Pick<PdfApi, 'pickCertificate' | 'inspectCertificate' | 'releaseCertificate' | 'signWithCertificate'>

/** The picker and signing worker run in the browser. Certificate material stays in this document. */
export function createBrowserPdfCertificate<R extends { size: number }>({
  path, signal, current, canSign, readPdf, deliverSigned,
}: {
  path: string
  signal: AbortSignal
  current: () => R
  canSign: () => boolean
  readPdf: (path: string) => Promise<ArrayBuffer>
  deliverSigned: (bytes: Uint8Array<ArrayBuffer>, revision: R, signal: AbortSignal) => Promise<SignWithCertificateResult>
}): CertificateApi {
  let certificate: { id: string; file: File; lifetime: AbortController } | undefined
  const certificateFor = (id: string) => certificate?.id === id ? certificate : undefined
  const releaseCertificate: CertificateApi['releaseCertificate'] = id => {
    if (certificate?.id !== id) return
    certificate.lifetime.abort()
    certificate = undefined
  }
  const certificateSignal = (entry: NonNullable<typeof certificate>) =>
    AbortSignal.any([signal, entry.lifetime.signal])

  return {
    async pickCertificate() {
      const [file] = await pickLocalFiles('.p12,.pfx', signal)
      signal.throwIfAborted()
      if (!file) return null
      if (!/\.(?:p12|pfx)$/i.test(file.name) || !file.size || file.size > MAX_CERTIFICATE_BYTES) {
        throw Error('Invalid PDF signing certificate')
      }
      if (certificate) releaseCertificate(certificate.id)
      certificate = { id: crypto.randomUUID(), file, lifetime: new AbortController() }
      return { certId: certificate.id, fileName: file.name }
    },
    releaseCertificate,
    async inspectCertificate(id, password) {
      const entry = certificateFor(id)
      if (!entry || typeof password !== 'string' || password.length > 1024) {
        return { ok: false, error: 'cert-invalid' }
      }
      try {
        const result = await runCertificateWorker({
          kind: 'inspect', bytes: await entry.file.arrayBuffer(), password,
        }, certificateSignal(entry))
        if (result.ok && 'signer' in result) return result
        if (!result.ok && result.error !== 'pdf-encrypted' && result.error !== 'sign-failed') {
          return { ok: false, error: result.error }
        }
      } catch { /* An expired local selection is no longer inspectable. */ }
      return { ok: false, error: 'cert-invalid' }
    },
    async signWithCertificate(request): Promise<SignWithCertificateResult> {
      const fail = { ok: false as const, error: 'sign-failed' as const }
      const entry = certificateFor(request.certId)
      if (!entry || typeof request.password !== 'string' || request.password.length > 1024) {
        return { ok: false, error: 'cert-invalid' }
      }
      if (request.path !== path || !validOptions(request) || !canSign()) return fail
      const revision = current()
      if (revision.size > MAX_PDF_SIGN_BYTES) return fail
      const active = certificateSignal(entry)
      const text = (value: string | undefined) => value?.trim().slice(0, 500) || undefined
      try {
        const pdf = await readPdf(path)
        active.throwIfAborted()
        if (pdf.byteLength > MAX_PDF_SIGN_BYTES || current() !== revision || !canSign()) return fail
        const signed = await runCertificateWorker({
          kind: 'sign', bytes: await entry.file.arrayBuffer(), pdf, password: request.password,
          options: {
            reason: text(request.reason), location: text(request.location), contactInfo: text(request.contactInfo),
            certifyLevel: request.certifyLevel, visible: request.visible,
          },
        }, active)
        active.throwIfAborted()
        if (!signed.ok) return signed
        if (!('signed' in signed) || current() !== revision || !canSign()) return fail
        return await deliverSigned(signed.signed, revision, active)
      } catch {
        return active.aborted ? { ok: false, cancelled: true } : fail
      }
    },
  }
}
