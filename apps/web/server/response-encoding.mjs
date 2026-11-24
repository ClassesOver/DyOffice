import Negotiator from 'negotiator'
import { constants } from 'node:zlib'

export const minCompressionBytes = 32 * 1024
export const fastBrotli = { params: { [constants.BROTLI_PARAM_QUALITY]: 1 } }

export function acceptsBrotli(headers) {
  return (
    Boolean(headers?.['accept-encoding']) &&
    new Negotiator({ headers }).encoding(['br', 'identity']) === 'br'
  )
}
