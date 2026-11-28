import {randomUUID} from 'node:crypto'
import {authError,tokenHash} from '../auth/sessions.ts'
import type {FileRow} from './queries.ts'
import {uuid} from './queries.ts'

type Grant={
  sessionHash:string; editorId:string; fileId:string; revision:string; sha256:string; password:string
  prepared:Set<string>; passwordChanges:Set<string>; expiresAt:number; timer?:NodeJS.Timeout
}

export function createDocumentEditGrants(){
  const grants=new Map<string,Grant>()
  const lifetime=10*60_000
  function remove(id:string){
    clearTimeout(grants.get(id)?.timer)
    grants.delete(id)
  }
  function touch(id:string,grant:Grant){
    clearTimeout(grant.timer)
    grant.expiresAt=Date.now()+lifetime
    grant.timer=setTimeout(()=>remove(id),lifetime)
    grant.timer.unref()
  }
  function boundGrant(token:string,fileId:string,editorId:string,id?:string){
    const grant=id?grants.get(id):undefined
    if(!id||!grant||grant.expiresAt<=Date.now()||grant.sessionHash!==tokenHash(token)||grant.fileId!==fileId||grant.editorId!==editorId)throw authError(423)
    return {id,grant}
  }
  function authorize(token:string,file:FileRow,editorId:string,unlockId?:string){
    const {id,grant}=boundGrant(token,file.id,editorId,unlockId)
    if(grant.revision!==file.current_revision){
      if(!grant.prepared.has(file.sha256))throw authError(423)
      grant.revision=file.current_revision;grant.sha256=file.sha256;grant.prepared.clear();grant.passwordChanges.clear()
    }
    if(grant.sha256!==file.sha256)throw authError(423)
    touch(id,grant)
    return grant
  }
  return {
    open(token:string,file:FileRow,editorId:string|undefined,password:string){
      if(!editorId||file.office_signature_protected)return
      const editor=uuid(editorId),sessionHash=tokenHash(token)
      let sessionGrants=0
      for(const [id,grant] of grants){
        if(grant.expiresAt<=Date.now()){remove(id);continue}
        if(grant.sessionHash!==sessionHash)continue
        if(grant.fileId===file.id&&grant.editorId===editor){
          if(grant.revision===file.current_revision&&grant.sha256===file.sha256){
            touch(id,grant)
            return id
          }
          remove(id)
          continue
        }
        sessionGrants++
      }
      if(sessionGrants>=8||grants.size>=32)throw authError(429)
      const id=randomUUID()
      const grant:Grant={sessionHash,editorId:editor,fileId:file.id,revision:file.current_revision,sha256:file.sha256,password,prepared:new Set(),passwordChanges:new Set(),expiresAt:0}
      grants.set(id,grant);touch(id,grant)
      return id
    },
    authorize,
    recoveryGrant:(token:string,fileId:string,editorId:string,id:string)=>boundGrant(token,fileId,editorId,id).grant,
    assertPrepared(token:string,file:FileRow,editorId:string,sha256:string,passwordChange=false){
      const sessionHash=tokenHash(token)
      for(const grant of grants.values()){
        if(grant.expiresAt>Date.now()&&grant.sessionHash===sessionHash&&grant.fileId===file.id&&grant.editorId===editorId&&grant.revision===file.current_revision&&grant.sha256===file.sha256&&(passwordChange?grant.passwordChanges:grant.prepared).has(sha256))return
      }
      throw authError(423)
    },
    remember(grant:Grant,sha256:string,passwordChange=false){
      if(grant.prepared.size+grant.passwordChanges.size>=32)throw authError(429)
      const candidates=passwordChange?grant.passwordChanges:grant.prepared
      candidates.add(sha256)
    },
    close(token:string,fileId:string,id:string){
      const grant=grants.get(uuid(id))
      if(grant?.sessionHash!==tokenHash(token)||grant.fileId!==uuid(fileId))throw authError(404)
      remove(id)
    },
  }
}
