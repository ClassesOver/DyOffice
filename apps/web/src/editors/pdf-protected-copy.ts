import {PDFDocument,PDFHexString} from 'pdf-lib'
import type {PdfEncryptionInput} from '../../../pdf/src/shared/ipc'
import {
  encryptDictFor,hex,passwordBytes,pdfCryptoPayloads,permissionsToP,r6DigestIndex,repeatR6Input,
} from '../../../pdf/src/shared/pdf-crypto-objects'
import {assertPdfEditStructure} from '../../shared/pdf-edit-structure.mjs'

const maxBytes=64*1024*1024
const zeroBlock=new Uint8Array(16)
const empty=new Uint8Array()

export function isCopyPasswordValid(password:string):boolean {
  return password.length>0&&!password.includes('\0')&&new TextEncoder().encode(password).length<=127
}

export function needsDistinctOwnerPassword(settings:PdfEncryptionInput):boolean {
  return settings.userPassword===settings.ownerPassword&&Object.values(settings.permissions).some(allowed=>!allowed)
}

function concat(...parts:Uint8Array[]){
  const joined=new Uint8Array(parts.reduce((bytes,part)=>bytes+part.length,0))
  let offset=0
  for(const part of parts){
    joined.set(part,offset)
    offset+=part.length
  }
  return joined
}

const random=(size:number)=>crypto.getRandomValues(new Uint8Array(size))
const importKey=(bytes:Uint8Array)=>crypto.subtle.importKey('raw',new Uint8Array(bytes),'AES-CBC',false,['encrypt'])

async function encrypt(key:CryptoKey,iv:Uint8Array<ArrayBuffer>,bytes:Uint8Array,padding=true){
  const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-CBC',iv},key,new Uint8Array(bytes)))
  // Web Crypto adds one block even for already aligned input. CBC's previous
  // blocks are unaffected and used as-is by the PDF key derivation.
  return padding?ciphertext:ciphertext.subarray(0,bytes.length)
}

async function r6Hash(password:Uint8Array,salt:Uint8Array,user:Uint8Array,signal?:AbortSignal){
  let digest=new Uint8Array(await crypto.subtle.digest('SHA-256',concat(password,salt,user)))
  let last=0
  for(let i=0;i<64||last>i-32;i++){
    signal?.throwIfAborted()
    const input=repeatR6Input(password,digest,user)
    const key=await importKey(digest.subarray(0,16))
    const encoded=await encrypt(key,digest.subarray(16,32),input,false)
    const algorithm=(['SHA-256','SHA-384','SHA-512'] as const)[r6DigestIndex(encoded)]!
    digest=new Uint8Array(await crypto.subtle.digest(algorithm,encoded))
    last=encoded[encoded.length-1]!
  }
  return digest.subarray(0,32)
}

/** Writes the standard AES-256 revision 6 security handler entirely in the browser. */
export async function createProtectedPdfCopy(bytes:Uint8Array,settings:PdfEncryptionInput,signal?:AbortSignal){
  signal?.throwIfAborted()
  if(!isCopyPasswordValid(settings.userPassword)||!isCopyPasswordValid(settings.ownerPassword)){
    throw Error('A PDF password must contain 1 to 127 UTF-8 bytes and no NUL characters.')
  }
  if(needsDistinctOwnerPassword(settings))throw Error('Use a distinct owner password to enforce the requested permissions.')
  if(!bytes.length||bytes.length>maxBytes)throw Error('The PDF exceeds the protected copy size limit of 64 MiB.')
  const doc=await PDFDocument.load(bytes,{updateMetadata:false,throwOnInvalidObject:true})
  assertPdfEditStructure(doc,{allowAcroForm:true})
  await doc.flush()
  const fileKey=random(32),aes=await importKey(fileKey)
  const makeEntry=async(password:string,user=empty)=>{
    const encoded=passwordBytes(password),validationSalt=random(8),keySalt=random(8)
    const hash=await r6Hash(encoded,validationSalt,user,signal)
    const key=await importKey(await r6Hash(encoded,keySalt,user,signal))
    return {entry:concat(hash,validationSalt,keySalt),encryptedKey:await encrypt(key,zeroBlock,fileKey,false)}
  }
  const user=await makeEntry(settings.userPassword)
  const owner=await makeEntry(settings.ownerPassword,user.entry)
  const permissions=permissionsToP(settings.permissions)
  const permissionBlock=new Uint8Array(16)
  new DataView(permissionBlock.buffer).setInt32(0,permissions,true)
  permissionBlock.set([0xff,0xff,0xff,0xff,0x54,0x61,0x64,0x62],4)
  permissionBlock.set(random(4),12)
  // Encrypting a single block with zero IV is the ECB block the /Perms entry requires.
  const perms=await encrypt(aes,zeroBlock,permissionBlock,false)
  const context=doc.context,encryptRef=context.nextRef()
  context.assign(encryptRef,encryptDictFor(context,{
    filter:'Standard',v:5,r:6,length:256,p:permissions,o:owner.entry,u:user.entry,
    oe:owner.encryptedKey,ue:user.encryptedKey,perms,stmF:'StdCF',strF:'StdCF',
    cf:{StdCF:{cfm:'AESV3',authEvent:'DocOpen',lengthBytes:32}},encryptMetadata:true,
  }))
  context.trailerInfo.Encrypt=encryptRef
  if(!context.trailerInfo.ID){
    const id=PDFHexString.of(hex(random(16)))
    context.trailerInfo.ID=context.obj([id,id])
  }
  let encryptedSize=0
  for(const payload of pdfCryptoPayloads(doc,encryptRef)){
    signal?.throwIfAborted()
    const iv=random(16),data=concat(iv,await encrypt(aes,iv,payload.data))
    encryptedSize+=data.length*(payload.isString?2:1)
    if(encryptedSize>maxBytes)throw Error('The protected PDF exceeds its download size limit of 64 MiB.')
    payload.replace(data)
  }
  const result=await doc.save({useObjectStreams:false,updateFieldAppearances:false,addDefaultPage:false})
  signal?.throwIfAborted()
  if(result.byteLength>maxBytes)throw Error('The protected PDF exceeds its download size limit of 64 MiB.')
  return new Uint8Array(result)
}
