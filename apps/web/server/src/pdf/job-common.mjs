import {createHash} from 'node:crypto'

/** Throws a coded error; the isolated job boundary maps unknown codes to NATIVE_FAILED. */
export function fail(code){throw Object.assign(new Error(code),{code})}
export function check(signal){if(signal?.aborted)fail('ABORTED')}
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
/** Accepts exactly `{version:1, action, [payloadKey]}` (no other keys), else INVALID_REQUEST. */
export function requireEnvelope(value,action,payloadKey){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==['action',payloadKey,'version'].sort().join(',')||value.version!==1||value.action!==action)fail('INVALID_REQUEST')
}
