import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString } from 'pdf-lib'
import type { PdfPermissions } from './ipc'

/** UTF-8 without a BOM, cut at the first NUL and at 127 bytes (§7.6.3.1) */
export function passwordBytes(password: string): Uint8Array {
  const utf8 = new TextEncoder().encode(password)
  let end = utf8.length
  for (let i = 0; i < utf8.length; i++) {
    if (utf8[i] === 0) {
      end = i
      break
    }
  }
  return utf8.subarray(0, Math.min(end, 127))
}

export function hex(data: Uint8Array): string {
  let out = ''
  for (const byte of data) out += byte.toString(16).padStart(2, '0')
  return out
}

/** /Length of a stream dict must describe the ciphertext the file actually holds */
function replaceStream(
  context: { assign(ref: PDFRef, obj: unknown): void },
  ref: PDFRef,
  stream: PDFStream,
  payload: Uint8Array,
): void {
  const dict = stream.dict
  dict.set(PDFName.of('Length'), PDFNumber.of(payload.length))
  context.assign(ref, PDFRawStream.of(dict, payload))
}

/** active-low bits; a denied permission clears its bit (§7.6.3.2 Table 24) */
export function permissionsToP(permissions: PdfPermissions): number {
  let p = -1
  const clear = (mask: number): void => {
    p &= ~mask
  }
  if (!permissions.printing) clear(0x4 | 0x800)
  if (!permissions.modifying) clear(0x8 | 0x400)
  if (!permissions.annotating) clear(0x20 | 0x100)
  if (!permissions.copying) clear(0x10)
  return p | 0
}

export function permissionsFromP(p: number): PdfPermissions {
  return {
    printing: (p & 0x4) !== 0 || (p & 0x800) !== 0,
    modifying: (p & 0x8) !== 0 || (p & 0x400) !== 0,
    annotating: (p & 0x20) !== 0 || (p & 0x100) !== 0,
    copying: (p & 0x10) !== 0,
  }
}

/** the /Encrypt dictionary reduced to the fields key derivation and re-emission need */
export interface EncryptEntries {
  filter: string
  v: number
  r: number
  length: number
  p: number
  o: Uint8Array
  u: Uint8Array
  oe: Uint8Array
  ue: Uint8Array
  perms: Uint8Array
  /** named crypt filters from /CF; /StmF and /StrF name the ones in use */
  cf: Record<string, { cfm: string; authEvent?: string; lengthBytes?: number }>
  stmF: string
  strF: string
  encryptMetadata: boolean
}

/** the /Encrypt dictionary to write; a carried protection re-emits the source's entries */
export function encryptDictFor(context: PDFDocument['context'], entries: EncryptEntries): PDFDict {
  const filters: Record<string, PDFDict> = {}
  for (const [name, filter] of Object.entries(entries.cf)) {
    filters[name] = context.obj({
      CFM: filter.cfm,
      ...(filter.authEvent === undefined ? {} : { AuthEvent: filter.authEvent }),
      ...(filter.lengthBytes === undefined ? {} : { Length: filter.lengthBytes }),
    }) as PDFDict
  }
  const dict = context.obj({
    Filter: entries.filter,
    V: entries.v,
    R: entries.r,
    ...(entries.length >= 40 ? { Length: entries.length } : {}),
    P: entries.p,
    O: PDFHexString.of(hex(entries.o)),
    U: PDFHexString.of(hex(entries.u)),
    ...(entries.oe.length > 0 ? { OE: PDFHexString.of(hex(entries.oe)) } : {}),
    ...(entries.ue.length > 0 ? { UE: PDFHexString.of(hex(entries.ue)) } : {}),
    ...(entries.perms.length > 0 ? { Perms: PDFHexString.of(hex(entries.perms)) } : {}),
    ...(Object.keys(filters).length > 0 ? { CF: context.obj(filters) } : {}),
    StmF: entries.stmF,
    StrF: entries.strF,
    ...(entries.encryptMetadata ? {} : { EncryptMetadata: false }),
  })
  if (!(dict instanceof PDFDict)) throw new Error('could not build the encryption dictionary')
  return dict
}


/** Stream and string byte ranges of a document, each with its PDF object setter. */
export function* pdfCryptoPayloads(
  doc: PDFDocument,
  skip: PDFRef | null,
  encryptMetadata = true,
): Generator<{ref: PDFRef; data: Uint8Array; isString: boolean; replace: (data: Uint8Array) => void}> {
  type Payload = {ref: PDFRef; data: Uint8Array; isString: boolean; replace: (data: Uint8Array) => void}
  function* strings(ref: PDFRef,node: PDFDict | PDFArray): Generator<Payload> {
    const slots = node instanceof PDFDict
      ? node.entries().map(([key,value])=>({value,set:(next:PDFHexString)=>node.set(key,next)}))
      : node.asArray().map((value,index)=>({value,set:(next:PDFHexString)=>node.set(index,next)}))
    for(const {value,set} of slots){
      if(value instanceof PDFString || value instanceof PDFHexString){
        yield {ref,data:value.asBytes(),isString:true,replace:(data:Uint8Array)=>set(PDFHexString.of(hex(data)))}
      }else if(value instanceof PDFDict || value instanceof PDFArray){
        yield* strings(ref,value)
      }
    }
  }
  const context=doc.context
  for(const [ref,obj] of context.enumerateIndirectObjects()){
    if(skip?.toString()===ref.toString())continue
    if(obj instanceof PDFStream){
      if(!encryptMetadata&&String(obj.dict.get(PDFName.of('Type')))==='/Metadata')continue
      yield {ref,data:obj.getContents(),isString:false,replace:data=>replaceStream(context,ref,obj,data)}
      yield* strings(ref,obj.dict)
    }else if(obj instanceof PDFDict||obj instanceof PDFArray){
      yield* strings(ref,obj)
    }else if(obj instanceof PDFString||obj instanceof PDFHexString){
      yield {ref,data:obj.asBytes(),isString:true,replace:data=>context.assign(ref,PDFHexString.of(hex(data)))}
    }
  }
}

export function repeatR6Input(password:Uint8Array,key:Uint8Array,user:Uint8Array){
  const length=password.length+key.length+user.length
  const input=new Uint8Array(length*64)
  for(let offset=0;offset<input.length;offset+=length){
    input.set(password,offset)
    input.set(key,offset+password.length)
    input.set(user,offset+password.length+key.length)
  }
  return input
}

export function r6DigestIndex(encrypted:Uint8Array){
  let sum=0
  for(let i=0;i<16;i++)sum+=encrypted[i]!
  return sum%3
}
