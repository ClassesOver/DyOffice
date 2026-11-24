import { officeSignatureNotice } from './office-signature-notice'
import {readHandoffSkill} from './document-handoff-spec'
import {joinWordCollab,type WordSyncState} from './word-collab'
import type {Editor} from '@tiptap/core'
import {documentHandoffPeer} from './document-handoff-peer'
import {reportDocumentLoading,registerDisplayedRevision} from './document-loading-state'
import {LocalDraftCopy} from './local-draft-copy'
import type {DraftCopyAuthority} from './draft-copy-authority'
import {DocumentNotifications} from './document-notifications'
import {createEditorCloseLifecycle} from './editor-close-lifecycle'
import {createAnalysisDocumentTarget} from '../../../../packages/browser-host/src/analysis-document-target.ts'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App, type DocsNamedCopy } from '../../../docs/src/renderer/App'
import { LocaleProvider, setModuleLang } from '../../../docs/src/renderer/i18n/locale'
import { setAuthorName } from '../../../docs/src/renderer/author-name'
import { applyAiPanelPrefs, AssistantAvatar, installScreenTips } from '@genoffice/ui'
import type { SessionFileHost } from '../../../../packages/browser-host/src/files.ts'
import { createDocsBridge } from './docs-bridge.ts'
import type { DocsEditorHandle, OfficeHandoffRunner } from '../../../docs/src/renderer/file-actions'
import type { DesktopApi } from '../../../docs/src/shared/ipc'
import {AGENT_TOOLS as DOCS_AGENT_TOOLS} from '../../../docs/src/renderer/ai/tools'
import { messages } from './messages.ts'
import {loadEditorAssistant,editorAssistantNotice} from './editor-assistant-status'
import { mountEditorRealtime } from './editor-realtime.ts'
import { confirmWebFileName, suggestWebFileName } from './web-ai-naming'
import { createImageAttachmentReferences } from './web-ai-media-api'
import '@genoffice/ui/tokens.css'
import '@genoffice/ui/screentip.css'
import '@genoffice/ui/ai-model-picker.css'
import '@genoffice/ui/ai-queue-strip.css'
import '@genoffice/ui/ai-usage.css'
import '@genoffice/ui/ai-skills.css'
import '@genoffice/ui/color-picker.css'
import '@genoffice/ui/dropdown.css'
import '@genoffice/ui/ribbon-collapse.css'
import '@genoffice/ui/markdown.css'
import '@genoffice/ui/ai-panel-prefs.css'
import '@genoffice/ui/ai-scope-quote.css'
import '@genoffice/ui/image-viewer.css'
import '../../../docs/src/renderer/styles.css'
import '../../../docs/src/renderer/fonts/fonts.css'
import './docs.css'
import './ai-dock-theme.css'

export async function mountDocsEditor(host: SessionFileHost,element: HTMLElement,fileId: string,draftAuthority:DraftCopyAuthority={current:()=>false,verify:async()=>false},citationMode=false) {
  element.textContent = messages.zh.opening
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) throw new Error(messages.zh.failed)
  let closing=false
  let changed = () => {}
  let disposed = false, downloading = false, actionError = ''
  let authorizedDraft: {origin:string;ticket:string;expires:number;write:boolean} | undefined
  type WriteState = 'planning'|'writing'|'saving'|'saved'|'conflict'|'saveFailed'|'failed'|'noModel'|'outputLimit'|'timedOut'|'emptyOutput'|'noTool'
  type Review = {state:'reviewing'|'ready'|'failed'|'noModel';text?:string}
  type Followup = {id:string;question:string;state:'answering'|'ready'|'failed';answer:string}
  let externalWriting: {id:string;topic:string;state:WriteState;reply?:string;tool?:'running'|'done'|'failed';revision?:string;review?:Review} | undefined
  const followupScope=crypto.randomUUID()
  const followups:Followup[] = []
  let stopFollowup: (()=>void) | undefined
  let grantExpiry:ReturnType<typeof setTimeout>|undefined
  let stopExternalWriting: (()=>void) | undefined
  let officeHandoff: OfficeHandoffRunner | null = null
  let pendingHandoff: ((runner: OfficeHandoffRunner) => void) | undefined
  const registerOfficeHandoff = (runner: OfficeHandoffRunner | null) => {
    officeHandoff = runner
    if(runner&&pendingHandoff) {
      const resume=pendingHandoff
      pendingHandoff=undefined
      queueMicrotask(()=>{if(!disposed&&!closing)resume(runner)})
    }
  }
  let editorHandle: DocsEditorHandle | null = null
  const registerEditor = (handle: DocsEditorHandle | null) => {
    if (disposed) return
    const readinessChanged = !!editorHandle !== !!handle
    editorHandle = handle
    if (readinessChanged) changed()
  }
  // Every registration gets a fresh local-copy identity, including detach/rebind
  // of the same renderer handle. Keep the readiness callback semantics unchanged.
  let draftEditor:Pick<DocsEditorHandle,'serialize'>|null=null
  const registerDraftEditor=(handle:DocsEditorHandle|null)=>{draftEditor=handle?{serialize:()=>handle.serialize()}:null;registerEditor(handle)}
  const unsubscribe = host.subscribe(() => changed())
  let continuationRevision:()=>string|undefined=()=>undefined
  const assistantResult = await loadEditorAssistant({fileId,editorId:host.getEditorId()!,generation:()=>1,continuationRevision:()=>continuationRevision()},false,'docx',new Set([...DOCS_AGENT_TOOLS.map(tool=>tool.name),'read_attachment','read_knowledge_file','search_knowledge_base']))
  const assistant = assistantResult.assistant
  const opened = await host.open(fileId)
  if (opened.format !== 'docx') throw new Error(messages.zh.failed)
  const signed=opened.officeSignatureProtected===true
  const prefs = await host.getPreferences(), locale = prefs.language === 'en' ? 'en' : 'zh', text = messages[locale]
  setModuleLang(locale); document.documentElement.lang = locale
  if (prefs.theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = prefs.theme
  setAuthorName(prefs.authorName ?? '')
  let wordSync:ReturnType<typeof joinWordCollab>|undefined, syncState:WordSyncState=signed?'unavailable':'joining'
  let peerSaveTimer:ReturnType<typeof setTimeout>|undefined
  let checkingWriter=false,nextWriterCheck=0,reopenToSave=false, journalAhead=false, lastSynced=-1
  let syncedSavedRevision:string|undefined
  async function syncBody(){try{await wordSync?.checkpoint();return true}catch{return false}}
  async function checkWriter({version,savedVersion,savedRevision}:{version:number;savedVersion:number;savedRevision:string}){
    const ahead=version>savedVersion
    syncedSavedRevision=savedRevision
    if(!disposed&&(version!==lastSynced||ahead!==journalAhead)){lastSynced=version;journalAhead=ahead;changed()}
    if(disposed||closing||version<=savedVersion||checkingWriter||host.getState(fileId).lease||Date.now()<nextWriterCheck)return
    checkingWriter=true;nextWriterCheck=Date.now()+4500
    try{
      if(await host.wordLeaseActive(fileId)||disposed||closing)return
      if(savedRevision!==host.getState(fileId).revision.revision){
        // The DOCX may contain new metadata outside the shared body model.
        // Reopen its updated bytes before attempting to serialize it.
        if(!reopenToSave){reopenToSave=true;changed()}
        return
      }
      await host.acquireLease(fileId)
      if(disposed||closing||!await host.isCurrentRevision(fileId)){await host.releaseLease(fileId);return}
      if(editorHandle?.isDirty())setTimeout(()=>{if(!disposed&&!closing&&host.getState(fileId).lease)void editorHandle?.save()},0)
    }catch{/* Another editor may have acquired the lease first. */}finally{checkingWriter=false}
  }
  function onCollabEditor(editor:Editor|null){
    if(citationMode)return
    wordSync?.dispose();wordSync=undefined;clearTimeout(peerSaveTimer)
    syncedSavedRevision=undefined
    if(!editor||disposed||signed)return
    syncState='joining'
    wordSync=joinWordCollab(editor,opened.file.revision,host.getEditorId()!,
      data=>host.wordCollab(fileId,data),next=>{syncState=next;changed()},()=>{
        clearTimeout(peerSaveTimer)
        // 第二个浏览器从不抢占整文件写锁，收到远端正文的租约持有者落盘。
        peerSaveTimer=setTimeout(()=>{if(!disposed&&!closing&&host.getState(fileId).lease&&editorHandle?.isDirty())void editorHandle.save()},1200)
      },checkWriter)
  }
  const bridge = createDocsBridge(host,fileId,prefs,() => changed(),undefined,{
    knowledgeRequest:assistant?.request,
    wordCheckpoint:async()=>wordSync?.checkpoint(),
    onSourceOpenFailed:()=>{
      if(disposed)return
      actionError=prefs.language==='en'?'The cited source is unavailable. Search the knowledge base again.':'引用的来源或版本已失效，请重新检索知识库。'
      changed()
    },
  })
  let documentLoaded=false
  continuationRevision=()=>{
    if(!documentLoaded||disposed||closing||downloading||!editorHandle||!wordSync||
      !['active','unavailable'].includes(syncState)||journalAhead||
      (syncState==='active'&&wordSync.pending())||editorHandle.isDirty())return
    const current=host.getState(fileId),local=bridge.getState()
    const saved=bridge.getReceipt()??opened.file
    if(current.lease&&current.status==='idle'&&!local.dirty&&local.status==='idle'&&!local.takingOver&&
      local.nativeSaveOutcome!=='pending'&&current.revision.revision===saved.revision)return saved.revision
  }
  const analysisTarget=createAnalysisDocumentTarget({fileId,format:'docx',state:()=>host.getState(fileId),verifyAuthority:async()=>{await host.renewLease(fileId)},
    editor:()=>editorHandle?.analysis??null,receipt:()=>bridge.getReceipt(),
    save:check=>bridge.guardedSave(check,async()=>!!editorHandle&&await editorHandle.save()&&!editorHandle.isDirty()&&bridge.getState().nativeSaveOutcome==='accepted')})
  const unregisterAnalysis=assistant?.documents.register(analysisTarget)
  const assistantNotice = editorAssistantNotice(assistantResult,prefs.showAssistant,locale)
  const assistantAvailable = Boolean(assistant?.available && prefs.showAssistant !== false)
  const copyLifetime = new AbortController()
  let naming = false, copyNotice: {message:string;failed:boolean} | undefined
  const nameCopy: DocsNamedCopy = async propose => {
    const editor = draftEditor, modelId = assistant?.selected(), signal = copyLifetime.signal
    const active = () => !signal.aborted && !closing && editor === draftEditor && draftAuthority.current() &&
      !!host.getState(fileId).lease && host.getState(fileId).status === 'idle'
    if (!assistant?.available || !modelId || !editor || naming || !active()) return
    naming = true
    copyNotice = undefined
    changed()
    const en = locale === 'en'
    let upload: string | undefined, finishStarted = false
    try {
      if (!await draftAuthority.verify() || !active()) {
        if (!signal.aborted) copyNotice = {message:en?'Could not verify this workspace session. Your draft is still open.':'无法验证当前工作区会话，草稿仍保留在此页。',failed:true}
        return
      }
      const proposed = await propose(({content}) => suggestWebFileName(content,{modelId,proof:assistant.sessionProof,format:'docx',locale,signal}))
      if (!proposed || !active()) return
      const chosen = await confirmWebFileName(proposed,{locale,signal})
      if (!chosen) return
      const name = chosen.replace(/\.docx$/i,'')+'.docx'
      if (!await draftAuthority.verify() || !active()) throw Error('Draft session ended')
      const bytes = await editor.serialize()
      if (!bytes?.byteLength || bytes.byteLength > 32*1024*1024 || !await draftAuthority.verify() || !active()) throw Error('Draft snapshot unavailable')
      const blob = new Blob([bytes.slice().buffer as ArrayBuffer])
      const {uploadId} = await assistant.request<{uploadId:string}>('/api/v1/files/uploads','POST',{name,size:blob.size},signal)
      upload = '/api/v1/uploads/'+encodeURIComponent(uploadId)
      if (!active()) throw Error('Draft session ended')
      await assistant.request(upload+'/content','PUT',blob,signal)
      if (!active()) throw Error('Draft session ended')
      finishStarted = true
      await assistant.request(upload+'/finish','POST',undefined,signal)
      copyNotice = {message:en?`Saved copy: ${name}`:`已保存副本：${name}`,failed:false}
    } catch {
      // Before /finish nothing can have been created: drop the staged upload and say so plainly.
      if (upload && !finishStarted && !signal.aborted) await assistant.request(upload,'DELETE',undefined,signal).catch(()=>{})
      if (!signal.aborted) copyNotice = {message:finishStarted
        ? (en?'Could not confirm the copy. Check your workspace before retrying.':'无法确认副本是否已保存。请先在工作区核对，再决定是否重试。')
        : (en?'Could not save the copy. The source document and its unsaved changes are still intact.':'无法保存副本。原文档和未保存的修改仍保留。'),failed:true}
    } finally {
      naming = false
      if (!disposed) changed()
    }
  }
  const panelPrefs = {...await bridge.api.getAiPanelPrefs(), showAiSidebar: assistantAvailable}
  // The media gateway also returns WebP; the DOCX serializer embeds PNG, JPEG and GIF.
  const media = assistant?.mediaApi
  const imageAttachments = createImageAttachmentReferences()
  const setImageAttachments = (files: Parameters<typeof imageAttachments.set>[0]) => {
    const references = imageAttachments.set(files)
    return references ? 'Current message image attachments (insert_image / insert_picture URL | file name):\n'+references+
      '\nUse the listed reference as url to insert the original attached picture. Do not search for or regenerate it.' : ''
  }
  const normalizeWebp = async (base64: string) => {
    const {normalizePdfGeneratedImage} = await import('./pdf-generated-image')
    return normalizePdfGeneratedImage({mime:'image/webp',base64})
  }
  const imageBridge: Partial<DesktopApi> = media ? {
    async aiGenerateImage(input) {
      const result = await media.aiGenerateImage(input)
      const prefix = 'data:image/webp;base64,'
      if (!result.url?.startsWith(prefix)) return result
      try {
        const image = await normalizeWebp(result.url.slice(prefix.length))
        return {url:`data:${image.mime};base64,${image.base64}`}
      } catch { return {error:'The generated WebP image could not be converted for Word.'} }
    },
    async fetchImage(url) {
      if (imageAttachments.matches(url)) return imageAttachments.fetch(url)
      const image = await media.fetchImage(url)
      if (image?.mime !== 'image/webp') return image
      try { return await normalizeWebp(image.base64) } catch { return null }
    },
  } : {}
  window.desktop = {...bridge.api,...assistant?.api,...imageBridge, getAiPanelPrefs: async () => ({...await bridge.api.getAiPanelPrefs(),showAiSidebar:assistantAvailable})} as unknown as DesktopApi
  applyAiPanelPrefs(panelPrefs); installScreenTips()
  let initialLease = !signed&&!citationMode
  if(initialLease)try { await host.acquireLease(fileId) } catch { initialLease = false }
  const stop = host.startRenewal(fileId)
  const realtime = mountEditorRealtime(host, fileId, () => changed(),channels=>assistant?.channel?.observe(channels))
  async function saveAndDownload() {
    const editor = editorHandle
    if (!editor || disposed || downloading) return
    downloading = true; actionError = ''; changed()
    try {
      const receipt = await bridge.prepareDownload(editor)
      if (disposed || editorHandle !== editor) return
      const current = host.getState(fileId), local = bridge.getState()
      if (editor.isDirty() || local.dirty || local.status !== 'idle' || local.nativeSaveOutcome !== 'accepted' || current.status !== 'idle' || !current.lease || current.revision.fileId !== receipt.fileId || current.revision.revision !== receipt.revision || current.revision.sha256 !== receipt.sha256 || current.revision.size !== receipt.size) throw new Error(text.saveFailed)
      const anchor = document.createElement('a')
      anchor.href = `/api/v1/files/${fileId}/content?revision=${receipt.revision}&download=1`
      anchor.download = host.getState(fileId).name
      anchor.hidden = true; element.append(anchor); anchor.click(); anchor.remove()
    } catch { if (!disposed) actionError = text.saveFailed }
    finally { downloading = false; if (!disposed) changed() }
  }
  async function takeOver(){
    if(!editorHandle||disposed||bridge.getState().takingOver)return
    const wasInert=element.inert;actionError='';element.inert=true
    try{await bridge.takeover(editorHandle);initialLease=true}
    catch(error){if(!disposed)actionError=error instanceof Error&&(error.message===text.takeoverDirty||error.message===text.takeoverStale)?error.message:text.takeoverFailed}
    finally{if(!disposed){element.inert=wasInert;changed()}}
  }
  const boundedReply=(value:string,max:number)=>value.slice(0,max).replace(/[\uD800-\uDBFF]$/u,'')
  function startExternalWriting(id:string,topic:string,skill:ReturnType<typeof readHandoffSkill>) {
    const job:NonNullable<typeof externalWriting> = externalWriting = {id,topic,state:'planning'}
    function report(state:WriteState) {job.state=state;changed()}
    if(!assistant?.available){report('noModel');return}
    if(officeHandoff) void runWriting(officeHandoff)
    else { pendingHandoff=runWriting;changed() }

    async function runWriting(run:OfficeHandoffRunner) {
      const editor=editorHandle
      if(!editor?.beginExternalWrite?.()){report('conflict');return}
      const controller=new AbortController()
      stopExternalWriting=()=>controller.abort()
      const active=()=>!controller.signal.aborted&&!disposed&&!closing&&!!host.getState(fileId).lease
      changed()
      try {
        const result=await run({mode:'write',instruction:topic,...(skill&&{skill}),signal:controller.signal,onWriteTool:tool=>{
          if(!active())return
          job.tool=tool
          report('writing')
        }})
        if(disposed||closing)return
        if(!active()||result.failure) {
          if(job.tool==='running')job.tool='failed'
          report(result.failure??'conflict');return
        }
        job.reply=boundedReply(result.text,4000)
        report('saving')
        const saved=await bridge.guardedSave(active,async()=>await editor.save()&&!editor.isDirty()&&bridge.getState().nativeSaveOutcome==='accepted').catch(()=>false)
        const receipt=bridge.getReceipt()
        if(disposed||closing)return
        if(saved&&receipt){job.revision=receipt.revision;report('saved')}
        else report('saveFailed')
      } catch {if(!disposed&&!closing)report('failed')}
    }
  }
  function followUp(id:string,question:unknown) {
    const previous=followups.find(turn=>turn.id===id)
    if(previous)return previous
    if(question===undefined)return {id,state:'unknown',answer:''}
    if(typeof question!=='string'||!question.trim()||question.length>4000)return
    if(followups.at(-1)?.state==='answering')return
    const run=officeHandoff
    const turn:Followup={id,question,state:'answering',answer:''}
    followups.push(turn)
    if(followups.length>20)followups.shift()
    changed()
    if(!run||!assistant?.available){turn.state='failed';changed();return turn}
    const controller=new AbortController()
    stopFollowup=()=>controller.abort()
    void run({mode:'followup',instruction:question,
      signal:controller.signal,onText:text=>{
        if(!disposed){turn.answer=boundedReply(text,8000);changed()}
      }}).then(async result=>{
      if(result.mutated&&!result.failure){const editor=editorHandle;const active=()=>!disposed&&!closing&&!controller.signal.aborted&&!!host.getState(fileId).lease;
        if(!editor||!await bridge.guardedSave(active,async()=>await editor.save()&&!editor.isDirty()&&bridge.getState().nativeSaveOutcome==='accepted').catch(()=>false))result.failure='failed'
      }
      if(disposed)return
      turn.answer=boundedReply(result.text,8000)
      turn.state=result.failure||!turn.answer.trim()?'failed':'ready'
      changed()
    },()=>{if(!disposed){turn.state='failed';changed()}})
    return turn
  }
  function NativeDocument() {
    const [,tick] = useState(0), [loaded,setLoaded] = useState(false), [failed,setFailed] = useState(false)
    const [draftTarget,setDraftTarget] = useState('')
    const [sharingDraft,setSharingDraft] = useState(false)
    const [automaticDraft,setAutomaticDraft] = useState(false)
    const [draftPaused,setDraftPaused] = useState(false)
    useEffect(()=>{if(loaded&&!failed)reportDocumentLoading('ready')},[loaded,failed])
    const state = host.getState(fileId)
    changed = () => {if(!closing)tick(value => value + 1)}
    useEffect(() => {
      const focus = () => { if (host.getState(fileId).lease) void host.renewLease(fileId).catch(() => {}) }
      window.addEventListener('focus',focus)
      return () => window.removeEventListener('focus',focus)
    },[])
    useEffect(() => {
      const handoff = documentHandoffPeer()
      if (!handoff || !loaded || failed || !state.lease) return
      const {shell,peer,embedded} = handoff
      const controller = new AbortController()
      let checking = false
      async function authorize(origin:string,ticket:string) {
        checking = true
        const signal = controller.signal
        try {
          const challenge = await fetch('/api/v1/auth/csrf',{signal,cache:'no-store'})
          if (!challenge.ok) return
          const proof = (await challenge.json()).csrfToken
          const result = await fetch('/api/v1/assistant-channels/documents/'+fileId+'/draft-sync',{
            method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':proof},
            body:JSON.stringify({origin,ticket}),signal,
          })
          if (!result.ok) return
          const {expires,write} = await result.json()
          if (signal.aborted || !Number.isSafeInteger(expires) || expires <= Date.now()) return
          authorizedDraft = {origin,ticket,expires,write:write===true}
          clearTimeout(grantExpiry)
          grantExpiry=setTimeout(()=>{stopExternalWriting?.();stopFollowup?.()},expires-Date.now())
          if(!write){stopExternalWriting?.();stopFollowup?.()}
          setAutomaticDraft(true)
        } catch { /* Retry on the next signed request. */ }
        finally {checking = false}
      }
      const onRequest = (event: MessageEvent) => {
        if (event.source !== peer || event.data?.type !== 'dsh-dyoffice:draft-request' || event.data.fileId !== fileId) return
        if (!/^https:\/\//u.test(event.origin) && !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/u.test(event.origin)) return
        const ticket = event.data.ticket
        if (typeof ticket === 'string') {
          if (draftPaused) return
          if (authorizedDraft?.origin !== event.origin || authorizedDraft.ticket !== ticket || authorizedDraft.expires <= Date.now()) {
            if (!checking && /^\d{13}\.[A-Za-z0-9_-]{43}$/u.test(ticket)) void authorize(event.origin,ticket)
            return
          }
        } else if (embedded) return
        else if (event.origin !== draftTarget) {
          setSharingDraft(false)
          setDraftTarget(event.origin)
          return
        } else if (!sharingDraft) return
        if (disposed || closing || !host.getState(fileId).lease || host.getState(fileId).status === 'unauthorized') return
        const incoming = event.data.writing
        let writing, followup
        if (authorizedDraft?.write && authorizedDraft.ticket === ticket && incoming &&
            typeof incoming.id === 'string' && /^[a-f\d-]{36}$/u.test(incoming.id) &&
            typeof incoming.topic === 'string' && incoming.topic.length <= 255 && incoming.topic.trim() && editorHandle) {
          if(!externalWriting&&!['active','unavailable'].includes(syncState))return
          if (!externalWriting) startExternalWriting(incoming.id,incoming.topic,readHandoffSkill(incoming.skill))
          const job = externalWriting
          if (!job || job.id !== incoming.id) writing = {id:incoming.id,state:'conflict'}
          else {
            const review = incoming.review
            if (job.state==='saved' && review && ['reviewing','ready','failed','noModel'].includes(review.state) &&
                (review.text===undefined || typeof review.text==='string' && review.text.length<=4000) &&
                (job.review?.state!==review.state || job.review?.text!==review.text)) {
              job.review={state:review.state,text:review.text}
              changed()
            }
            writing = {id:job.id,state:job.state,revision:job.revision,reply:job.reply}
            const ask=event.data.followup
            if(typeof ask?.id==='string' && /^[a-f\d-]{36}$/u.test(ask.id) && (job.state==='saved'||ask.question===undefined)) {
              const answer=ask.scope!==undefined&&ask.scope!==followupScope
                ? {id:ask.id,state:'unknown',answer:''} : followUp(ask.id,ask.question)
              if(answer)followup={id:answer.id,state:answer.state,answer:answer.answer}
            }
          }
        }
        const draft=editorHandle?.readDraftText?.(false,externalWriting?.tool==='running')??null
        peer.postMessage({type:'dsh-dyoffice:draft',fileId,draft,writing,followup,followupScope}, event.origin)
      }
      shell.addEventListener('message',onRequest)
      return () => {controller.abort();shell.removeEventListener('message',onRequest)}
    },[loaded,failed,state.lease,draftTarget,sharingDraft,draftPaused])
    const job = externalWriting, en=locale==='en'
    const message = (author:'DyOffice'|'DSH'|'You'|'你',body:string,key:string,reply?:string) =>
      <article key={key} className="assistant-chat-row assistant-chat-row-assistant dyoffice-collaboration-message">
        <AssistantAvatar id={author==='DSH'?'dsh':undefined} name={author} origin={author==='DyOffice'?'office':'external'}/>
        <div className="assistant-chat-message">
          <div className="assistant-team-author"><strong>{author}</strong></div>
          <p dir="auto">{body}</p>
          {reply&&<p dir="auto">{reply}</p>}
        </div>
      </article>
    const externalAssistant = job && {id:job.id,activity:<>
      {job.state==='outputLimit'&&message('DyOffice',en?'The draft reached the output limit. Try a shorter request.':'正文达到输出上限，请缩短要求或分段撰写。','output-limit')}
      {job.state==='noModel'&&message('DyOffice',en?'Configure a model in DyOffice.':'请在 DyOffice 配置模型。','no-model')}
      {job.review && message('DSH',({
          reviewing:en?'Reviewing the saved draft…':'正在审阅已保存的正文…',
          ready:job.review.text || (en?'Review complete':'审阅完成'),
          failed:en?'Review could not be completed.':'未能完成审阅。',
          noModel:en?'Configure a model in DSH to review.':'请在 DSH 配置模型后审阅。',
        })[job.review.state],'dsh-review')}
    </>}
    const local = bridge.getState()
    const bodyFollower=loaded&&!failed&&!state.lease&&state.status!=='unauthorized'&&syncState==='active'
    const syncWarning=syncState==='offline'||syncState==='stale'?(locale==='zh'?'共同编辑暂停，保留本地草稿。': 'Collaboration paused; your local draft is preserved.'):''
    const warning = syncWarning || (failed ? text.failed : state.status === 'unknown' ? text.unknown : state.status === 'unauthorized' ? text.unauthorized : !citationMode && !signed && !state.lease && loaded && !bodyFollower ? (actionError || (initialLease ? text.conflict : text.readOnly)) : actionError)
    const notice = bodyFollower?(locale==='zh'?'正文共同编辑中，整文件由主编辑器保存。':'Co-editing the body; the primary editor saves the file.'):realtime.notice(locale)
    const status = signed ? officeSignatureNotice[locale].title : bodyFollower ? wordSync?.pending() ? (en?'Syncing…':'正在同步…') : journalAhead ? (en?'Synced; awaiting file save':'已同步，等待写入文件') : (en?'Saved':'已保存') : !loaded ? text.opening : downloading ? text.downloadSaving : state.status === 'saving' || local.status === 'saving' ? (locale === 'zh' ? '正在保存…' : 'Saving…') : local.dirty ? (locale === 'zh' ? '未保存' : 'Unsaved') : text.ready
    const saveStatus = <>
      <span className="dyoffice-docs-persistence-state" role="status" data-attention={Boolean(warning || notice)} data-native-save={local.nativeSaveOutcome} data-incomplete-reasons={local.nativeSaveReasons.join(',')} data-dirty={String(local.dirty)} title={warning || [status, notice].filter(Boolean).join(' · ')}>{warning ? (locale === 'zh' ? '需要处理' : 'Needs attention') : status}</span>
      {bodyFollower&&reopenToSave&&<button type="button" onClick={()=>{void syncBody().then(ok=>{if(ok&&!wordSync?.pending())location.reload()})}}>{locale==='zh'?'重新打开并接续保存':'Reopen and resume saving'}</button>}
      {automaticDraft&&state.lease&&<button type="button" onClick={()=>setDraftPaused(value=>!value)}>
        {draftPaused ? (locale==='zh'?'恢复同步正文':'Resume live text') : (locale==='zh'?'暂停同步正文':'Pause live text')}
      </button>}
      {!automaticDraft&&draftTarget&&state.lease&&<button type="button" title={draftTarget} onClick={()=>setSharingDraft(value=>!value)}>
        {sharingDraft ? (locale==='zh'?'停止同步正文':'Stop sharing draft') : (locale==='zh'?'同步未保存正文到 DSH':'Share unsaved text with DSH')}
      </button>}
    </>
    const fileActions = <>
      <div className="file-menu-sep" />
      <button className="dyoffice-docs-save-download" title={text.saveDownloadVersionHint} disabled={!loaded || failed || !editorHandle || !state.lease || state.status !== 'idle' || downloading} onClick={() => { void saveAndDownload() }}>{text.saveDownload}</button>
      {!signed&&<LocalDraftCopy name={state.name} locale={locale} authority={draftAuthority} getEditor={()=>!disposed&&!closing&&loaded&&!failed&&host.getState(fileId).status!=='unauthorized'?draftEditor:null}/>}
      <a className="dyoffice-docs-download" href={`/api/v1/files/${fileId}/content?revision=${state.revision.revision}&download=1`} download>{text.download}</a>
    </>
    return <div className="dyoffice-native-docs">
      <DocumentNotifications locale={locale} items={[
        ...(citationMode ? [{id:'citation',level:'info' as const,title:en?'Cited version':'引用版本',message:en?'The saved source is open in read-only mode.':'当前引用展示已保存的只读版本。'}] : []),
        ...(signed ? [{id:'office-signature',level:'info' as const,...officeSignatureNotice[locale]}] : []),
        ...(assistantNotice ? [{id:'assistant',level:prefs.showAssistant === false ? 'info' as const : 'warning' as const,title:locale === 'zh' ? 'AI 助手' : 'AI Assistant',message:assistantNotice}] : []),
        ...(warning ? [{id:'document-state',level:'error' as const,title:locale === 'zh' ? '文档需要处理' : 'Document needs attention',message:warning,actions:<>
        {!citationMode && !signed && !state.lease && !failed && state.status !== 'unauthorized' && <button data-takeover-blockers={[!loaded && 'loading', !editorHandle && 'no-handle', local.takingOver && 'taking-over', downloading && 'downloading', local.dirty && 'dirty', local.status !== 'idle' && 'local-busy', state.status === 'unknown' && 'host-unknown', state.status === 'saving' && 'host-saving'].filter(Boolean).join(',')} disabled={!loaded || !editorHandle || local.takingOver || downloading || local.dirty || local.status !== 'idle' || state.status === 'unknown' || state.status === 'saving'} onClick={() => { void takeOver() }}>{text.takeover}</button>}
        {state.status === 'unknown' && <button onClick={() => { void host.reconcile(fileId).then(() => changed()).catch(() => {}) }}>{text.retry}</button>}
      </>}] : []),
        ...(notice ? [{id:'version',level:'info' as const,title:locale === 'zh' ? '版本同步' : 'Version updates',message:notice}] : []),
        ...(copyNotice ? [{id:'named-copy',level:copyNotice.failed?'error' as const:'info' as const,title:locale==='zh'?'AI 命名':'AI file naming',message:copyNotice.message}] : []),
      ]} />
      <App host={{ fileActions,saveStatus,setImageAttachments,desktopActionsAvailable:false,getSupportedCreateDocumentTypes:()=>bridge.supportedCreateDocumentTypes,resolveKnowledgeCitation:bridge.resolveKnowledgeCitation,namedCopy:loaded&&!failed&&assistant?.available&&state.lease&&state.status==='idle'&&!naming&&draftAuthority.current()?nameCopy:undefined,onCollabEditor,syncBody,bodyCollaboration:bodyFollower,readOnly: !loaded || failed || !state.lease || local.takingOver || !['active','unavailable'].includes(syncState),assistantAvailable:!citationMode&&(assistantAvailable||!!(job&&assistant?.available)),assistant,recoveryRevision:continuationRevision(),externalAssistant,preferenceScope: fileId,onEditorReady: registerDraftEditor,onHandoffReady:registerOfficeHandoff,lifecycle: { ...bridge.lifecycle,wordSyncActive:()=>syncState==='active',documentOpened() { bridge.lifecycle.documentOpened(); documentLoaded=true; setLoaded(true) } },onDocumentEdited: bridge.lifecycle.edited,onOpenFailed: () => {documentLoaded=false; setFailed(true); reportDocumentLoading('error')} }} />
    </div>
  }
  reportDocumentLoading('rendering')
  const root = createRoot(element)
  root.render(<LocaleProvider initial={locale}><NativeDocument /></LocaleProvider>)
  const closeState=()=>({dirty:!host.getState(fileId).lease&&syncState==='active'&&wordSync ? wordSync.pending() : !!editorHandle?.isDirty()||bridge.getState().dirty,blocked:downloading||bridge.getState().takingOver||['unknown','saving'].includes(host.getState(fileId).status)||!!bridge.waitForSave()})
  registerDisplayedRevision(()=>{
    const state=closeState(),current=host.getState(fileId)
    const revision=current.revision.revision
    const savedBody=citationMode||signed||syncState==='unavailable'||(syncState==='active'&&syncedSavedRevision===revision)
    return documentLoaded&&savedBody&&!state.dirty&&!state.blocked&&!journalAhead&&current.status!=='unauthorized'?revision:undefined
  })
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (closeState().dirty || closeState().blocked) { event.preventDefault(); event.returnValue = '' }
  }
  window.addEventListener('beforeunload',beforeUnload)
  const cleanup=()=>{if(disposed)return;disposed=true;clearTimeout(grantExpiry);copyLifetime.abort();clearTimeout(peerSaveTimer);wordSync?.dispose();stopFollowup?.();stopExternalWriting?.();unregisterAnalysis?.();analysisTarget.dispose();window.removeEventListener('beforeunload',beforeUnload);imageAttachments.set([]);assistant?.dispose();realtime.dispose();stop();unsubscribe();root.unmount();bridge.dispose()}
  const lifecycle=createEditorCloseLifecycle({state:closeState,waitForSave:bridge.waitForSave,save:()=>editorHandle?.save()??Promise.resolve(false),release:()=>host.releaseLease(fileId),cleanup,setClosing:value=>{closing=value;element.inert=value;if(!value)changed()},confirm:()=>window.confirm('文档有未保存的更改，是否保存后关闭？取消将保留当前页签。'),notify:()=>window.alert('保存仍在进行或结果待确认，请先在文档中核对后再关闭。')})
  return {
    canClose:lifecycle.canClose,
    dispose:lifecycle.dispose,
    unload(){void host.releaseLease(fileId,true).catch(()=>{});cleanup()},
    getSelection: () => editorHandle?.getSelection() ?? null,
    serialize: () => editorHandle ? editorHandle.serialize() : Promise.reject(new Error(text.opening)),
    save: () => editorHandle ? editorHandle.save() : Promise.resolve(false),
  }
}
