window.__ModuleLoader__.load({
  id: '@local/dsh-dyoffice',
  factory(require) {
    const {createElement: h, useEffect, useRef, useState, useSyncExternalStore} = require('react')
    const id = '@local/dsh-dyoffice'
    const copy = {
      zh: {messagesLabel:'DSH 与 DyOffice 的消息',textMode:'正文',webPreview:'Office 网页',syncLive:'消息同步中',syncStale:'同步中断',syncEnded:'对话已结束',destination:'消息接收方',savedPreview:'已保存的正文',sending:'正在提交 DyOffice 请求…', elapsed:'已用时 {time}', snapshot:'预览快照',previewRight:'在右侧打开预览', openWindow:'在新窗口打开 DyOffice',snapshotUnavailable:'未能生成缩略图，点击预览文件',skillLabel:'DSH Skill',title: 'DyOffice', description: '查看已保存文档和任务进度', loading: '正在连接 DyOffice…',
        unavailable: '暂时无法预览，请检查频道连接和后台读取权限。', configure: '请先配置 DyOffice 频道连接。',
        authorization: '连接 DyOffice', pairIntro: '连接频道后，即可在 DSH 创建和预览文档。',
        url: 'DyOffice 服务 URL', code: '授权 Token', codeHint: '粘贴频道分享生成的 Token',
        getCode: '前往频道分享获取 Token', getCodeHint: '在 DyOffice 的「频道分享」中生成 Token。',
        updateToken: '更新授权 Token', noDocument: '当前频道没有可预览的文档。',
        canCreate: '此 Token 可创建文档。', cannotCreate: '此 Token 无创建权限。请在频道分享中勾选创建权限，再更新 Token。',
        usage: '例如：/dyoffice word 创建一个活动策划。只需要空白文件时，使用 /dyoffice word 创建空白文件 demo。',
        planning: 'DyOffice 助手已接收交接，正在规划正文…', generating: 'DyOffice 正在撰写…', awaitingSave: 'DyOffice 正在保存正文…', writingFailed: '模型连接中断，请检查 DyOffice 的模型设置后重试。',
        noTool: '模型没有写入文档内容，请重试或切换模型。',
        outputLimit: '正文达到输出上限，请缩短要求或分段撰写。', timedOut: '模型响应超时，请重试。', emptyOutput: '模型没有返回正文，请重试或切换模型。',
        noModel: '请在 DyOffice 配置撰写模型。', waitingWriter: '正在连接文档并启动撰写…', openToWrite: '请在新窗口打开 DyOffice 以开始撰写。',
        reviewing: 'DSH 正在审阅已保存的正文…', reviewReady: 'DSH 审阅意见', reviewFailed: 'DSH 未能完成审阅。', reviewNoModel: '请在 DSH 配置审阅模型。',
        handedOff: '正文已保存，交给 DSH 审阅。', officeChat: '后续消息会发给 DyOffice 助手。', endOfficeChat: '结束 Office 对话',
        reopenForChat: '原文档窗口已断开。可结束 Office 对话或重新发起。', officeBusy: '请等 DyOffice 助手完成当前任务。', officeTextOnly: 'Office 对话支持最多 4,000 字的纯文本。', officeAnswering: 'DyOffice 助手正在处理这条消息…', officeAnswerFailed: 'DyOffice 未能回答，请重试。', you: '你',
        requestDraft: '请在文档中完成以下任务，保存后我来审阅：',
        savedWriting: '正文已写入并保存。', writingConflict: '文档已有改动，自动写入已停止。', writingSaveFailed: '正文已写入草稿，保存未确认。请在编辑器中检查并保存。',
        pausedChannel: '频道已暂停。请先在 DyOffice 恢复协作。',
        created: '已创建文档', dismiss: '返回频道预览', createdUnavailable: '无法预览此文件。可点击文件名，在 DyOffice 打开原文。',
        creating: '正在创建文档…', creationFailed: '创建文档失败', editing: '编辑器已打开', saving: '正在保存新版…', saved: '已保存', dismissNotice: '关闭提示',
        syncEdit: '在 DyOffice 编辑并同步正文',
        syncBlocked: '浏览器没有打开编辑窗口，请允许弹出窗口后重试。', draftText: '实时正文（未保存）',
        invalidUrl: '请输入 HTTPS 地址，或本机回环 HTTP 地址。', connecting: '正在连接…', invalidCode: '授权 Token 无效或已过期，请在 DyOffice 重新生成。',
        pairFailed: '连接未完成，请检查 DyOffice 的频道状态后重试。',
        open: '打开 DyOffice 原文', revision: '已保存版本', taskRevision: '任务读取版本', text: '正文预览', details: '版本、频道任务和授权',
        empty: '当前版本没有可预览的文字。', livePreview:'Office 编辑器', previewLoading:'正在加载文档…',
        previewEmpty:'文档还没有正文', previewEmptyHint:'在 DyOffice 开始编辑，正文会同步到这里。',
        previewUnavailable:'此文档暂时无法预览', previewUnavailableHint:'可在新窗口打开原文。',
        truncated: '正文仅显示前 24,000 字符。', tasks: '任务进度', noTasks: '暂无任务。',
        queued: '排队中', running: '运行中', waiting_peer: '等待协作', cancel_requested: '正在取消',
        succeeded: '已完成', failed: '失败', cancelled: '已取消', unknown_outcome: '结果待核对'},
      en: {messagesLabel:'Messages between DSH and DyOffice',textMode:'Text',webPreview:'Office app',syncLive:'Sync active',syncStale:'Sync interrupted',syncEnded:'Conversation ended',destination:'Message recipient',savedPreview:'Saved text',sending:'Sending the request to DyOffice…', elapsed:'Elapsed {time}', snapshot:'Preview snapshot',previewRight:'Open preview on the right', openWindow:'Open DyOffice in a new window',snapshotUnavailable:'Thumbnail unavailable; open file preview',skillLabel:'DSH Skill',title: 'DyOffice', description: 'Follow the saved document and task progress', loading: 'Connecting to DyOffice…',
        unavailable: 'Preview unavailable. Check the channel connection and saved document permissions.', configure: 'Configure a DyOffice channel connection first.',
        authorization: 'Connect DyOffice', pairIntro: 'Connect a channel to create and preview documents in DSH.',
        url: 'DyOffice service URL', code: 'Authorization token', codeHint: 'Paste the token from channel sharing',
        getCode: 'Get a token from channel sharing', getCodeHint: 'Generate a token in DyOffice channel sharing.',
        updateToken: 'Update authorization token', noDocument: 'This channel has no document to preview.',
        canCreate: 'This token can create documents.', cannotCreate: 'This token cannot create documents. Enable creation in channel sharing and update the token.',
        usage: 'For example, /dyoffice word create an event plan. Use /dyoffice word create blank demo for an empty file.',
        planning: 'DyOffice Assistant accepted the handoff and is preparing a plan…', generating: 'DyOffice is writing…', awaitingSave: 'DyOffice is saving the draft…', writingFailed: 'The model connection failed. Check the model in DyOffice and try again.',
        noTool: 'The model did not write any document content. Try again or switch models.',
        outputLimit: 'The draft reached the output limit. Try a shorter request.', timedOut: 'The model took too long to respond. Try again.', emptyOutput: 'The model returned no document text. Try again or switch models.',
        noModel: 'Configure the writing model in DyOffice.', waitingWriter: 'Connecting the document and starting writing…', openToWrite: 'Open DyOffice in a new window to start writing.',
        reviewing: 'DSH is reviewing the saved draft…', reviewReady: 'DSH review', reviewFailed: 'DSH could not complete the review.', reviewNoModel: 'Configure the review model in DSH.',
        handedOff: 'Draft saved and handed to DSH for review.', officeChat: 'Follow-up messages go to DyOffice Assistant.', endOfficeChat: 'End Office conversation',
        reopenForChat: 'The original editor window is disconnected. End the Office conversation or start again.', officeBusy: 'Wait for DyOffice Assistant to finish its current task.', officeTextOnly: 'Office chat accepts plain text up to 4,000 characters.', officeAnswering: 'DyOffice Assistant is working on this message…', officeAnswerFailed: 'DyOffice could not answer. Please try again.', you: 'You',
        requestDraft: 'Please write about the following topic in the document. I’ll review the saved draft:',
        savedWriting: 'The document was written and saved.', writingConflict: 'Automatic writing stopped because the document already contains changes.', writingSaveFailed: 'The draft was written, but saving was not confirmed. Check and save it in the editor.',
        pausedChannel: 'The channel is paused. Resume it in DyOffice.',
        created: 'Document created', dismiss: 'Back to channel preview', createdUnavailable: 'Preview unavailable. Select the file name to open it in DyOffice.',
        creating: 'Creating document…', creationFailed: 'Could not create document', editing: 'Editor is open', saving: 'Saving a new version…', saved: 'Saved', dismissNotice: 'Dismiss',
        syncEdit: 'Edit in DyOffice and share live text',
        syncBlocked: 'Allow pop-ups and try opening the editor again.', draftText: 'Live text (unsaved)',
        invalidUrl: 'Enter an HTTPS URL or a loopback HTTP URL.', connecting: 'Connecting…', invalidCode: 'The authorization token is invalid or expired. Generate a new one in DyOffice.',
        pairFailed: 'Connection failed. Check the DyOffice channel and try again.',
        open: 'Open document in DyOffice', revision: 'Saved revision', taskRevision: 'Task revision', text: 'Document text', details: 'Revision, channel tasks and authorization',
        empty: 'This revision has no previewable text.', livePreview:'Office editor', previewLoading:'Loading document…',
        previewEmpty:'There’s no text yet', previewEmptyHint:'Start editing in DyOffice to see the text here.',
        previewUnavailable:'Preview unavailable for this document', previewUnavailableHint:'Open the original in a new window.',
        truncated: 'Showing the first 24,000 characters.', tasks: 'Task progress', noTasks: 'No tasks yet.',
        queued: 'Queued', running: 'Running', waiting_peer: 'Waiting for peer', cancel_requested: 'Cancelling',
        succeeded: 'Completed', failed: 'Failed', cancelled: 'Cancelled', unknown_outcome: 'Outcome needs review'},
    }
    const textStyle = {whiteSpace: 'pre-wrap', overflowWrap: 'anywhere'}
    const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu
    const headingStyle = {fontSize: '1em', margin: '12px 0 6px'}
    const paper = {margin: '8px 0 16px', padding: 'clamp(14px, 4vw, 36px)', minHeight: 220, borderRadius: 10,
      border: '1px solid var(--dsw-alias-border-l2, GrayText)', background: 'var(--dsw-alias-bg-layer-2, Canvas)',
      color: 'var(--dsw-alias-label-primary, CanvasText)', lineHeight: 1.75, ...textStyle}
    const pairStyles = {
      form: {display: 'grid', gap: 16, margin: '16px 12px', padding: 16, borderRadius: 14,
        border: '1px solid var(--dsw-alias-border-l2, GrayText)', background: 'var(--dsw-alias-bg-layer-1, Canvas)',
        color: 'var(--dsw-alias-label-primary, CanvasText)', fontSize: 13, lineHeight: 1.5},
      heading: {display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 8px', fontSize: 16, fontWeight: 600},
      badge: {display: 'grid', placeItems: 'center', width: 32, height: 32, flexShrink: 0, borderRadius: 9,
        background: 'color-mix(in srgb, var(--dsw-alias-brand-primary, Highlight) 14%, transparent)',
        color: 'var(--dsw-alias-brand-primary, Highlight)'},
      hint: {margin: 0, color: 'var(--dsw-alias-label-secondary, GrayText)', fontSize: 12, overflowWrap: 'anywhere'},
      field: {display: 'grid', gap: 6, minWidth: 0, fontWeight: 500},
      input: {width: '100%', minWidth: 0, boxSizing: 'border-box', minHeight: 36, padding: '7px 10px',
        border: '1px solid var(--dsw-alias-border-l3, GrayText)', borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-2, Field)', color: 'var(--dsw-alias-label-primary, FieldText)', font: 'inherit', fontWeight: 400},
      link: {color: 'var(--dsw-alias-brand-primary, LinkText)', textUnderlineOffset: 3},
      button: {minHeight: 36, padding: '7px 12px', border: 0, borderRadius: 8, font: 'inherit', fontWeight: 600,
        background: 'var(--dsw-alias-button-primary-fill, Highlight)', color: 'var(--dsw-alias-label-primary-foreground, HighlightText)'},
      error: {margin: 0, padding: '8px 10px', borderRadius: 8, fontSize: 12, overflowWrap: 'anywhere',
        color: 'var(--dsw-alias-state-error-primary, #b42318)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #b42318) 9%, transparent)'},
    }
    function WorkStatus({label,started,t}) {
      const [now,setNow]=useState(Date.now)
      useEffect(()=>{
        const timer=setInterval(()=>setNow(Date.now()),1000)
        return ()=>clearInterval(timer)
      },[])
      const seconds=Math.max(0,Math.floor((now-started)/1000))
      const time=Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0')
      return h('div',{style:{display:'grid',gap:6,minWidth:0}},
        h('div',{style:{display:'flex',gap:12,alignItems:'baseline',justifyContent:'space-between',flexWrap:'wrap'}},
          h('span',{role:'status'},label),
          h('small',{style:{...pairStyles.hint,fontVariantNumeric:'tabular-nums'}},t('elapsed',{time}))),
        h('progress',{'aria-label':label,style:{width:'100%',maxWidth:240,height:6,accentColor:'var(--dsw-alias-brand-primary, Highlight)'}}))
    }
    const previewUrl = () => new URL('../dyoffice-preview', window.location.href)
    const allowsEmbed = (connection, origin) => connection?.origin === origin &&
      (connection?.dshEditorOrigins ?? [connection?.dshEditorOrigin]).includes(window.location.origin)
    const studioStyles = `
      .dsh-office-studio{--dsh-office-party-dsh:#8265d0;--dsh-office-party-office:#32827c;container-type:inline-size;box-sizing:border-box;min-width:0;border:1px solid var(--dsw-alias-border-l2,#ccd2da);border-radius:14px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--dsw-alias-label-primary,CanvasText);font:inherit}
      .dsh-office-studio *{box-sizing:border-box}
      .dsh-office-studio header,.dsh-office-footer{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:12px 16px}
      .dsh-office-studio header{border-bottom:1px solid var(--dsw-alias-border-l2,#ccd2da)}
      .dsh-office-filetype{display:grid;place-items:center;min-width:38px;height:36px;border-radius:7px;background:var(--dsw-alias-brand-primary,Highlight);color:var(--dsw-alias-label-on-brand,HighlightText);font-size:10px;font-weight:700;letter-spacing:.04em}
      .dsh-office-name{flex:1 1 130px;min-width:0}.dsh-office-name strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px}
      .dsh-office-studio small{color:var(--dsw-alias-label-secondary,GrayText);font-size:12px}
      .dsh-office-studio button{cursor:pointer;font:inherit;font-size:12px;color:inherit;background:var(--dsw-alias-bg-layer-1,Canvas);border:1px solid var(--dsw-alias-border-l2,#ccd2da);border-radius:7px;padding:5px 9px;min-height:30px}
      .dsh-office-studio button:focus-visible,.dsh-office-paper:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,Highlight);outline-offset:-2px}
      .dsh-office-grid{display:grid;grid-template-columns:minmax(0,1fr)}
      .dsh-office-grid:has(>.dsh-office-canvas:only-child){grid-template-columns:1fr}
      .dsh-office-canvas{min-width:0;background:color-mix(in srgb,var(--dsw-alias-label-secondary,GrayText) 8%,var(--dsw-alias-bg-layer-1,Canvas));padding:12px}
      .dsh-office-tools{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-bottom:9px}
      .dsh-office-paper,.dsh-office-frame{min-width:0;border:1px solid var(--dsw-alias-border-l2,#ccd2da);border-radius:5px;background:var(--dsw-alias-bg-layer-1,Canvas)}
      .dsh-office-paper{min-height:145px;max-height:340px;overflow:auto;padding:16px 18px;line-height:1.7;font-size:14px;overflow-wrap:anywhere}.dsh-office-paper p,.dsh-office-paper h3{margin:0 0 .6em}
      .dsh-office-frame{position:relative;height:65vh;min-height:480px;max-height:800px;overflow:hidden}
      .dsh-office-log{min-width:0;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l2,#ccd2da)}
      .dsh-office-message{position:relative;border-inline-start:1px solid var(--dsw-alias-border-l2,#ccd2da);margin-inline-start:4px;padding:0 0 12px 13px;font-size:13px;line-height:1.55;overflow-wrap:anywhere}
      .dsh-office-message:last-child{padding-bottom:0;border-color:transparent}
      .dsh-office-message:before{content:'';position:absolute;inset-inline-start:-4px;top:6px;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-secondary,GrayText)}
      .dsh-office-message[data-party="DSH"]:before{background:var(--dsh-office-party-dsh)}.dsh-office-message[data-party="DyOffice"]:before{background:var(--dsh-office-party-office)}
      .dsh-office-message strong{font-size:12px}.dsh-office-message-body{white-space:pre-wrap}
      .dsh-office-footer{justify-content:space-between;border-top:1px solid var(--dsw-alias-border-l2,#ccd2da);font-size:12px}
      @container(max-width:570px){.dsh-office-grid{grid-template-columns:1fr}.dsh-office-log{border-inline-start:0;border-top:1px solid var(--dsw-alias-border-l2,#ccd2da)}}
    `
    function DocumentExcerpt({entry,pending,t}) {
      const draft=entry?.draft,snapshot=entry?.snapshot
      const text=(draft?draft.text:snapshot?.text)?.trim()??''
      const empty=snapshot||draft?'previewEmpty':pending?'previewLoading':'previewUnavailable'
      return h('article',{className:'dsh-office-paper',tabIndex:0,'aria-label':t(draft?'draftText':'savedPreview'),dir:'auto'},
        text?text.split(/\r?\n/u).filter(line=>line.trim()).map((line,i)=>{
          const heading=/^#{1,6} (.+)$/u.exec(line)
          return heading?h('h3',{key:i},heading[1]):h('p',{key:i},line.startsWith('- ')?'• '+line.slice(2):line)
        }):h('div',{role:'status'},h('p',null,t(empty)),empty!=='previewLoading'&&h('small',null,t(empty+'Hint'))))
    }
    function stateStore() {
      const listeners = new Set()
      let value = null
      return {
        read: () => value,
        subscribe(listener) {listeners.add(listener);return () => listeners.delete(listener)},
        set(next) {if (value === next) return; value = next; for (const listener of listeners) listener()},
      }
    }
    function serviceOrigin(value) {
      try {
        const address = new URL(value.trim())
        if (!address.username && !address.password && address.pathname === '/' && !address.search && !address.hash &&
            (address.protocol === 'https:' || (address.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)))) {
          return address.origin
        }
      } catch {}
      return null
    }
    function creationReceipt(text) {
      const match = /^已创建 ([^\r\n]+)\n([^\r\n]+)\/#\/file\/([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/iu.exec(text)
      if (!match) return null
      const origin = serviceOrigin(match[2])
      return origin ? {name: match[1], origin, fileId: match[3], href: origin + '/#/file/' + match[3]} : null
    }
    function Authorization({origin: defaultOrigin, t, onConnected}) {
      const [origin, setOrigin] = useState(defaultOrigin ?? '')
      const address = serviceOrigin(origin)
      const [code, setCode] = useState('')
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const pending = useRef(null)
      useEffect(() => () => pending.current?.abort(), [])
      async function connect(event) {
        event.preventDefault()
        if (pending.current || !code.trim()) return
        if (!address) {
          setError('invalidUrl')
          return
        }
        const controller = new AbortController()
        pending.current = controller
        setBusy(true)
        setError(null)
        try {
          const result = await fetch(previewUrl(), {
            method: 'POST', headers: {'X-DyOffice-Pair': '1', 'Content-Type': 'application/json'},
            body: JSON.stringify({origin: address, token: code.trim()}), signal: controller.signal,
          })
          if (result.ok) {
            setCode('')
            onConnected()
          } else {
            setError([400, 401, 410].includes(result.status) ? 'invalidCode' : 'pairFailed')
          }
        } catch {
          if (!controller.signal.aborted) setError('pairFailed')
        } finally {
          pending.current = null
          if (!controller.signal.aborted) setBusy(false)
        }
      }
      const disabled = busy || !code.trim() || !origin.trim()
      return h('form', {onSubmit: connect, style: pairStyles.form},
        h('header', null,
          h('h2', {style: pairStyles.heading},
            h('span', {'aria-hidden': true, style: pairStyles.badge},
              h('svg', {width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round'},
                h('path', {d: 'M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6 M9 16h6'}))),
            t('authorization')),
          h('p', {style: pairStyles.hint}, t('pairIntro'))),
        h('label', {style: pairStyles.field}, t('url'), h('input', {
          type: 'url', autoComplete: 'url', spellCheck: false, value: origin,
          onChange: event => setOrigin(event.target.value), disabled: busy,
          placeholder: 'https://office.example.com', 'aria-invalid': error === 'invalidUrl' || undefined, style: pairStyles.input,
        })),
        h('div', {style: pairStyles.field},
          h('label', {style: pairStyles.field}, t('code'), h('input', {
            type: 'password', autoComplete: 'off', spellCheck: false, maxLength: 2048,
            value: code, onChange: event => setCode(event.target.value), disabled: busy,
            placeholder: t('codeHint'), 'aria-invalid': error === 'invalidCode' || undefined, style: pairStyles.input,
          })),
          h('p', {style: pairStyles.hint}, address
            ? h('a', {href: address + '/?panel=channels', target: '_blank', rel: 'noopener noreferrer', style: pairStyles.link}, t('getCode'), ' ↗')
            : t('getCodeHint'))),
        error && h('p', {role: 'alert', style: pairStyles.error}, t(error)),
        h('button', {type: 'submit', disabled, style: {...pairStyles.button, opacity: disabled ? 0.55 : 1, cursor: disabled ? 'default' : 'pointer'}},
          t(busy ? 'connecting' : 'authorization')))
    }

    function finishInterruptedTurn(turns) {
      const turn=turns.at(-1)
      if(turn?.state!=='pending'&&turn?.state!=='answering')return turns
      return [...turns.slice(0,-1),{...turn,state:'failed'}]
    }

    function RemoteViewport({anchor,children}) {
      const host=useRef(null)
      useEffect(()=>{
        const el=host.current,target=anchor?.element
        if(!target)return
        let lastStyle={},animation
        const refresh=()=>{
          const r=target.getBoundingClientRect()
          let top=Math.max(0,r.top),left=Math.max(0,r.left),bottom=Math.min(window.innerHeight,r.bottom),right=Math.min(window.innerWidth,r.right)
          for(let parent=target.parentElement;parent&&parent!==document.documentElement;parent=parent.parentElement){
            const style=getComputedStyle(parent)
            if(style.overflowX==='visible'&&style.overflowY==='visible')continue
            const bounds=parent.getBoundingClientRect()
            if(style.overflowY!=='visible'){
              const scale=parent.offsetHeight?bounds.height/parent.offsetHeight:1
              const innerTop=bounds.top+parent.clientTop*scale
              top=Math.max(top,innerTop)
              bottom=Math.min(bottom,innerTop+parent.clientHeight*scale)
            }
            if(style.overflowX!=='visible'){
              const scale=parent.offsetWidth?bounds.width/parent.offsetWidth:1
              const innerLeft=bounds.left+parent.clientLeft*scale
              left=Math.max(left,innerLeft)
              right=Math.min(right,innerLeft+parent.clientWidth*scale)
            }
          }
          const nextStyle={left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px',
            visibility:target.isConnected&&bottom>top&&right>left?'visible':'hidden',
            clipPath:'inset('+[top-r.top,r.right-right,r.bottom-bottom,left-r.left].map(v=>Math.max(v,0)+'px').join(' ')+')'}
          for(const key of Object.keys(nextStyle)){
            if(nextStyle[key]!==lastStyle[key])el.style[key]=nextStyle[key]
          }
          lastStyle=nextStyle
        }
        // An ancestor's computed clip can change while the card stays still.
        const followPosition=()=>{
          refresh()
          animation=requestAnimationFrame(followPosition)
        }
        const observer=new IntersectionObserver(entries=>{
          cancelAnimationFrame(animation)
          refresh()
          if(entries[entries.length-1].isIntersecting)animation=requestAnimationFrame(followPosition)
        })
        observer.observe(target);refresh()
        window.addEventListener('scroll',refresh,true)
        return ()=>{
          observer.disconnect();cancelAnimationFrame(animation)
          window.removeEventListener('scroll',refresh,true)
          el.style.visibility='hidden'
        }
      },[anchor])
      return h('div',{ref:host,style:{position:'fixed',overflow:'hidden',visibility:'hidden',
        borderRadius:'0 0 11px 11px',pointerEvents:'auto',zIndex:1}},children)
    }
    function Preview({useTabInfo, t, createdDocuments, creationStatus, editorWindows, collaboration, updateCollaboration, connectionStatus, syncOnly=false, remote=false, anchor}) {
      const {tab} = useTabInfo()
      const [value, setValue] = useState(null)
      const [error, setError] = useState(null)
      const [authorizationOrigin, setAuthorizationOrigin] = useState(null)
      const [updating, setUpdating] = useState(false)
      const [refreshToken, setRefreshToken] = useState(0)
      const linkedEditor = useSyncExternalStore(editorWindows.subscribe, editorWindows.read)
      const [liveDraft, setLiveDraft] = useState(null)
      const [writingReceipt, setWritingReceipt] = useState(null)
      const [popupBlocked, setPopupBlocked] = useState(false)
      const created = useSyncExternalStore(createdDocuments.subscribe, createdDocuments.read)
      const creation = useSyncExternalStore(creationStatus.subscribe, creationStatus.read)
      const connection = useSyncExternalStore(connectionStatus.subscribe, connectionStatus.read)
      const frame = useRef(null)
      const selectedFile = created?.fileId ?? null
      const eligible = !!created && value?.preview?.fileId === selectedFile && !updating && allowsEmbed(connection,created.origin)
      const [mounted,setMounted]=useState(false)
      useEffect(()=>{if(eligible)setMounted(true)},[eligible])
      const embedded = !syncOnly && (remote ? eligible || mounted : eligible)
      const followEditor = tab.visible || embedded
      const writing = value?.selectedFile === selectedFile ? value?.writing : null
      const latestWriting = useRef(null)
      latestWriting.current = writing
      const editing = linkedEditor && !updating && value?.selectedFile === selectedFile &&
        selectedFile === linkedEditor.fileId && value.preview?.fileId === linkedEditor.fileId && value.origin === linkedEditor.origin ? linkedEditor : null

      useEffect(()=>{
        const popup=embedded&&frame.current?.contentWindow
        if(!popup)return
        const editor={fileId:selectedFile,origin:created.origin,popup,embedded:true,automatic:true}
        editorWindows.set(editor)
        return ()=>{if(editorWindows.read()===editor)editorWindows.set(null)}
      },[embedded,selectedFile,created?.origin])

      useEffect(() => {
        setLiveDraft(null)
        if (!followEditor || !editing) return
        const controller = new AbortController()
        let expiry, renewal, ticket, reviewRequested
        function clearLiveDraft() {
          setLiveDraft(null)
          updateCollaboration(editing.fileId,entry=>entry.draft===undefined&&entry.syncState!=='live'?entry:{...entry,draft:undefined,syncState:entry.syncState==='live'?'stale':entry.syncState})
        }
        async function authorize() {
          const url = previewUrl()
          url.searchParams.set('draftSync', editing.fileId)
          try {
            const response = await fetch(url, {method: 'POST', headers: {'X-DyOffice-Draft': '1'}, signal: AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])})
            const next=response.ok&&(await response.json()).ticket
            if(next)ticket=next
            if (!controller.signal.aborted) renewal=setTimeout(authorize,next?25000:3000)
          } catch {
            if (!controller.signal.aborted) renewal=setTimeout(authorize,3000)
          }
        }
        const onDraft = event => {
          if (editorWindows.read() !== editing || event.origin !== editing.origin ||
              (event.source !== editing.popup && event.source?.parent !== editing.popup) ||
              event.data?.type !== 'dsh-dyoffice:draft' || event.data.fileId !== editing.fileId) return
          const draft = event.data.draft
          if (draft !== null && (typeof draft?.text !== 'string' || draft.text.length > 24000 || typeof draft.truncated !== 'boolean')) return
          updateCollaboration(editing.fileId,entry=>entry.syncState==='live'&&entry.draft?.text===draft?.text&&entry.draft?.truncated===draft?.truncated
            ?entry:{...entry,draft:draft??undefined,syncState:'live'})
          const receipt = event.data.writing
          if (typeof receipt?.id === 'string' && receipt.id === latestWriting.current?.id && ['planning','writing','saving','saved','conflict','saveFailed','failed','noModel','outputLimit','timedOut','emptyOutput','noTool'].includes(receipt?.state)) {
            setWritingReceipt(previous => previous?.id === receipt.id && previous.state === receipt.state ? previous : receipt)
            const reply = typeof receipt.reply==='string' ? receipt.reply.slice(0,4000) : undefined
            updateCollaboration(editing.fileId,entry=>!entry.disconnected&&entry.state===receipt.state&&entry.reply===reply?
              entry:{...entry,state:receipt.state,reply,disconnected:false})
            if (receipt.state === 'saved' && uuid.test(receipt.revision ?? '') &&
                !latestWriting.current.review && reviewRequested !== receipt.id) {
              reviewRequested = receipt.id
              const url = previewUrl()
              url.searchParams.set('review',editing.fileId)
              url.searchParams.set('job',receipt.id)
              url.searchParams.set('revision',receipt.revision)
              void fetch(url,{method:'POST',headers:{'X-DyOffice-Draft':'1'},signal:controller.signal})
                .then(response=>{if(!response.ok)reviewRequested=undefined},()=>{reviewRequested=undefined})
            }
          }
          const answer = event.data.followup
          if (answer && ['answering','ready','failed'].includes(answer.state) &&
              typeof answer.answer==='string' && answer.answer.length<=8000) {
            updateCollaboration(editing.fileId,entry=>{
              const turn=entry.turns.at(-1)
              if(turn?.id!==answer.id || !['pending','answering'].includes(turn.state) ||
                  turn.state===answer.state && turn.answer===answer.answer)return entry
              return {...entry,turns:[...entry.turns.slice(0,-1),{...turn,state:answer.state,answer:answer.answer}]}
            })
          }
          setLiveDraft({editor: editing, draft})
          clearTimeout(expiry)
          expiry = setTimeout(clearLiveDraft, 2600)
        }
        const request = () => {
          if (editing.popup.closed) {
            if (editorWindows.read() !== editing) return
            editorWindows.set(null)
            updateCollaboration(editing.fileId,entry=>({...entry,disconnected:true,draft:undefined,
              turns:finishInterruptedTurn(entry.turns)}))
            return
          }
          if (editing.automatic && !ticket) return
          const turn=collaboration.read()?.get(editing.fileId)?.turns.at(-1)
          editing.popup.postMessage({type: 'dsh-dyoffice:draft-request', fileId: editing.fileId, ticket,
            writing: editing.automatic ? latestWriting.current : null,
            followup:turn && ['pending','answering'].includes(turn.state) ? {id:turn.id,question:turn.question}:undefined}, editing.origin)
        }
        window.addEventListener('message', onDraft)
        request()
        if (editing.automatic) void authorize()
        const timer = setInterval(request, 750)
        return () => {controller.abort();window.removeEventListener('message', onDraft);clearInterval(timer);clearTimeout(expiry);clearTimeout(renewal);clearLiveDraft()}
      }, [followEditor, editing])

      useEffect(() => {
        if (!followEditor) return
        const controller = new AbortController()
        let timer, current
        async function refresh() {
          try {
            const url = previewUrl()
            if (selectedFile) url.searchParams.set('file', selectedFile)
            if (current) url.searchParams.set('after', current.revision)
            const result = await fetch(url, {signal: controller.signal, cache: 'no-store'})
            if (result.status === 409) return
            if (!result.ok) {
              const authorization = result.status === 428 ? await result.json() : null
              if (controller.signal.aborted) return
              setAuthorizationOrigin(authorization ? (authorization.origin ?? '') : null)
              current = undefined
              if(result.status===428)setValue(null)
              setError(result.status === 503 ? 'configure' : 'unavailable')
              return
            }
            const payload = await result.json()
            if (controller.signal.aborted) return
            if (connectionStatus.read()?.origin !== payload.origin || connectionStatus.read()?.dshEditorOrigin !== payload.dshEditorOrigin || JSON.stringify(connectionStatus.read()?.dshEditorOrigins) !== JSON.stringify(payload.dshEditorOrigins)) {
              connectionStatus.set({origin:payload.origin,dshEditorOrigin:payload.dshEditorOrigin,dshEditorOrigins:payload.dshEditorOrigins})
            }
            const {preview} = payload
            current = preview && current && preview.fileId === current.fileId && preview.revision === current.revision ? {...current, ...preview} : preview
            setValue({...payload, preview: current, selectedFile})
            if(selectedFile&&current?.fileId===selectedFile&&uuid.test(current.revision??'')){
              const snapshot={revision:current.revision,text:current.text}
              updateCollaboration(selectedFile,e=>e.snapshot?.revision===snapshot.revision&&e.snapshot.text===snapshot.text?e:{...e,snapshot})
            }
            if(selectedFile)updateCollaboration(selectedFile,entry=>{
              const {topic,review,skill}=payload.writing??{}
              const skillName=skill?.name
              return entry.checked===true && entry.topic===topic && entry.skillName===skillName && entry.review?.state===review?.state && entry.review?.text===review?.text ?
                entry:{...entry,checked:true,topic,review,skillName}
            })
            setAuthorizationOrigin(null)
            setError(null)
          } catch {
            if (!controller.signal.aborted) {
              current = undefined
              setError('unavailable')
              setAuthorizationOrigin(null)
            }
          } finally {
            if (!controller.signal.aborted) timer = setTimeout(refresh, latestWriting.current?.review?.state === 'reviewing' ? 1000 : 2000)
          }
        }
        void refresh()
        return () => {
          controller.abort()
          clearTimeout(timer)
        }
      }, [followEditor, refreshToken, selectedFile])

      if(remote){
        if(!embedded)return null
        const url=new URL(created.href)
        url.searchParams.set('dshEmbed','1')
        return h(RemoteViewport,{anchor},h('iframe',{ref:frame,title:created.name,src:url.href,
          style:{width:'100%',height:'100%',border:0}}))
      }
      if(syncOnly)return null
      const progress = creation && h('p', {role: creation.error ? 'alert' : 'status',
        style: {...(creation.error ? pairStyles.error : pairStyles.hint), padding: '8px 12px'}},
        t(creation.error ? 'creationFailed' : 'creating'), creation.error && ': ' + creation.error,
        creation.error && h('button', {onClick: () => creationStatus.set(null)}, t('dismissNotice')))
      if (!embedded && (authorizationOrigin !== null || updating)) return h('div', null, progress, h(Authorization, {
        origin: value?.origin ?? authorizationOrigin, t,
        onConnected: () => {createdDocuments.set(null);connectionStatus.set(null);setUpdating(false);setRefreshToken(value => value + 1)},
      }))
      if (embedded) {
        const url=new URL(created.href)
        url.searchParams.set('dshEmbed','1')
        return h('section',{style:{height:'100%',minHeight:0,display:'flex',flexDirection:'column'}},
          h('header',{style:{minWidth:0,display:'flex',justifyContent:'space-between',gap:8,padding:'6px 10px',fontSize:12}},
            h('strong',{style:{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},created.name),
            h('a',{href:created.href,target:'_blank',rel:'noopener noreferrer',style:{...pairStyles.link,whiteSpace:'nowrap'}},t('open'))),
          h('iframe',{ref:frame,src:url.href,title:created.name,style:{width:'100%',flex:1,border:0,minHeight:0,background:'Canvas'}}))
      }
      if (!value || value.selectedFile !== selectedFile) return h('div', null, progress,
        h('p', {role: 'status', style: {padding: 16}}, t(error ?? 'loading')))
      const {preview, tasks, href, canCreate, paused} = value
      const reviewState = writing?.review && {reviewing:'reviewing',ready:'reviewReady',failed:'reviewFailed',noModel:'reviewNoModel'}[writing.review.state]
      const writeState = writing && (writingReceipt?.id === writing.id ?
        {planning:'planning',writing:'generating',saving:'awaitingSave',saved:'savedWriting',conflict:'writingConflict',saveFailed:'writingSaveFailed',failed:'writingFailed',noModel:'noModel',outputLimit:'outputLimit',timedOut:'timedOut',emptyOutput:'emptyOutput',noTool:'noTool'}[writingReceipt.state] :
        'waitingWriter')
      const draft = liveDraft?.editor === editing ? liveDraft?.draft : null
      function openLinkedEditor() {
        const origin = serviceOrigin(value.origin)
        if (!origin || !uuid.test(preview.fileId)) return
        const popup = window.open(origin + '/#/file/' + preview.fileId, '_blank')
        setPopupBlocked(!popup)
        if (popup) editorWindows.set({origin, popup, fileId: preview.fileId, automatic: selectedFile === preview.fileId})
      }
      const receipt = created?.origin === value.origin && h('p', {role: 'status', style: textStyle},
        t('created'), '：', h('a', {href: created.href, target: '_blank', rel: 'noopener noreferrer'}, created.name), ' ',
        h('button', {onClick: () => createdDocuments.set(null)}, t('dismiss')))
      const updateToken = h('button', {onClick: () => setUpdating(true)}, t('updateToken'))
      const createPermission = typeof canCreate === 'boolean' && !paused && h('p', null, t(canCreate ? 'canCreate' : 'cannotCreate'))
      if (!preview) return h('section', {style: {padding: 16}}, progress, receipt, h('p', null, t(paused ? 'pausedChannel' : receipt ? 'createdUnavailable' : 'noDocument')), createPermission, updateToken, h('p', null, t('usage')))
      const visible = draft ?? preview
      return h('section', {style: {height: '100%', boxSizing: 'border-box', overflow: 'auto', padding: 16}},
        progress, receipt, writeState && h('p', {role:'status'}, t(writeState)),
        reviewState && h('p', {role:'status'}, t(reviewState)),
        h('header', {style: textStyle},
          h('strong', null, preview.name), ' · ',
          h('a', {href, target: '_blank', rel: 'noopener noreferrer'}, t('open')),
          (preview.format === 'docx' || writing) && !editing && h('div',null,
            h('button',{onClick:openLinkedEditor},t('syncEdit')),
            (popupBlocked || created?.popupBlocked) && h('p',{role:'status',style:pairStyles.hint},t('syncBlocked')))),
        h('section',{'aria-label':t('text')},
          h('h2',{style:headingStyle},t(draft ? 'draftText' : 'text')),
          h('article',{style:paper,dir:'auto'},
            visible.text ? visible.text.split(/\r?\n/u).filter(line=>line.trim()).map((line,index)=>{
              const title = /^#{1,6}\s+(.+)$/u.exec(line)
              return title ? h('h3',{key:index,style:{margin:'12px 0 6px'}},title[1])
                : h('p',{key:index,style:{margin:'0 0 8px'}},line)
            }) : t('empty')),
          visible.truncated && h('p',{style:pairStyles.hint},t('truncated'))),
        writing?.review?.state === 'ready' && h('p',{style:textStyle},writing.review.text),
        h('details',null,h('summary',null,t('details')),
          ['editing','saving','saved'].includes(preview.activity) && h('p',{role:'status'},t(preview.activity)),
          h('div',null,t('revision'),' ',h('code',null,preview.revision)),
          h('h2',{style:headingStyle},t('tasks')),
          tasks.length ? h('ul',{style:{margin:0,paddingInlineStart:18}},
            tasks.map(task=>h('li',{key:task.taskId,style:textStyle},
              h('strong',null,t(task.state)),' · ',task.instruction,
              task.savedRevision && h('div',null,t('taskRevision'),' ',h('code',null,task.savedRevision)),
              task.summary && h('div',null,task.summary)))) : h('div',null,t('noTasks')),
          createPermission,updateToken,h('p',null,t('usage'))))
    }

    return {
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'uiConversation'],
      apply(ctx) {
        const namespace = 'dyofficePreview'
        const t = ctx.locale.bind(namespace)
        const channelSelection = stateStore()
        const creationStatus = stateStore()
        const editorWindows = stateStore()
        const connectionStatus = stateStore()
        const collaboration = stateStore()
        const officeSessions = new Map()
        const runners = stateStore()
        const anchors = stateStore()
        const noSubscribe=()=>()=>{}
        const emptyValue=()=>null
        function stopRunner(fileId){
          const next=new Map(runners.read())
          if(next.delete(fileId))runners.set(next)
        }
        function startRunner(receipt,embedded,popup){
          const previous=runners.read()??new Map(), old=previous.get(receipt.fileId)
          const created=old?.created??stateStore(),editor=old?.editor??stateStore()
          if(old?.embedded&&editor.read()&&!editor.read().popup.closed)return
          created.set(receipt)
          if(popup)editor.set({...receipt,popup,automatic:true})
          runners.set(new Map(previous).set(receipt.fileId,{created,editor,embedded}))
        }
        ctx.effect(()=>ctx.slots.inject('shell.overlay',()=>ctx.slots.register({
          name:'shell.overlay',id:'dyoffice-live-documents',locale:namespace,
        },function OfficeRunners({t}){
          const jobs=useSyncExternalStore(runners.subscribe,runners.read)
          const locations=useSyncExternalStore(anchors.subscribe,anchors.read)
          return Array.from(jobs??[],([fileId,job])=>h(Preview,{key:fileId,useTabInfo:()=>({tab:{visible:true}}),
            remote:job.embedded,syncOnly:!job.embedded,anchor:locations?.get(fileId),t,
            createdDocuments:job.created,editorWindows:job.editor,creationStatus,collaboration,updateCollaboration,connectionStatus}))
        })))
        const activityTarget = 'dyoffice-command-activity'
        // DSH keeps ordinary command-only sessions on the empty screen.
        ctx.effect(() => ctx.uiConversation.views.register({
          target:activityTarget,
          create() {
            let active = false
            return {empty:false, replace:({nodes})=>active=nodes.length>0,
              apply:({upserts})=>active=active||upserts.length>0}
          },
          isActive:active=>active,
        }))
        ctx.effect(() => ctx.uiConversation.events.register({
          kind:activityTarget, target:activityTarget,
          match:event=>event.type==='command/run'&&event.data.name==='dyoffice'
            ? {id:String(event.data.commandId), role:'start'} : null,
          start:()=>true,
          update:context=>context.state,
          buildViewNode:({key,kind,id})=>({key,kind,id,target:activityTarget,data:true}),
        }))
        function updateCollaboration(fileId,update) {
          const previous = collaboration.read() ?? new Map()
          const current = previous.get(fileId)
          if (!current) return
          const next=update(current)
          if(next!==current)collaboration.set(new Map(previous).set(fileId,next))
        }
        ctx.on('conversation/route-message', ({sessionId,text,attachmentCount})=>{
          const fileId=officeSessions.get(sessionId), entry=collaboration.read()?.get(fileId)
          if(!entry?.topic || entry.ended || entry.disconnected)return
          if(!['saved','planning','writing','saving'].includes(entry.state))return
          const editor=runners.read()?.get(fileId)?.editor.read()
          if(editor?.fileId!==fileId || editor.popup.closed)return
          const reject=message=>({kind:'error',text:t(message)})
          if(entry.state==='planning')return reject('officeBusy')
          if(attachmentCount || !text.trim() || text.length>4000)return reject('officeTextOnly')
          if(entry.state!=='saved' || ['pending','answering'].includes(entry.turns.at(-1)?.state))return reject('officeBusy')
          const id=crypto.randomUUID()
          updateCollaboration(fileId,current=>({...current,turns:[...current.turns.slice(-19),{id,question:text,state:'pending'}]}))
          setTimeout(()=>updateCollaboration(fileId,current=>{
            const turn=current.turns.at(-1)
            return turn?.id===id && turn.state==='pending' ?
              {...current,turns:[...current.turns.slice(0,-1),{...turn,state:'failed'}]} : current
          }),135000)
          return {kind:'success'}
        })
        ctx.effect(() => ctx.locale.register(namespace, copy))
        ctx.on('command/executed', (sessionId, name, result) => {
          if(name!=='dyoffice')return
          if(creationStatus.read()?.sessionId===sessionId)creationStatus.set(null)
          if(result?.kind!=='success'||typeof result.text!=='string')return
          const receipt=creationReceipt(result.text)
          if(!receipt)return
          const entries=collaboration.read()??new Map()
          startRunner(receipt,true)
          officeSessions.set(sessionId,receipt.fileId)
          if(!entries.has(receipt.fileId))collaboration.set(new Map(entries).set(receipt.fileId,{turns:[],sessionId}))
        })
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id, kind: 'dyoffice-preview', title: () => t('title'), keepMounted:true,
          guide: [{id: 'open', order: 31, title: () => t('title'), description: () => t('description')}],
        }))
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: id, locale: namespace,
        }, props => h(Preview, {...props, createdDocuments:channelSelection, creationStatus, editorWindows, collaboration, updateCollaboration, connectionStatus}))))
        function FileThumbnail({sessionId,path,openFile,t}){
          const url=previewUrl();url.searchParams.set('session',sessionId);url.searchParams.set('snapshot',path)
          const [failed,setFailed]=useState(false)
          return h('button',{type:'button',title:t('previewRight'),onClick:()=>openFile(path),style:{display:'grid',gap:6,padding:8,maxWidth:260,textAlign:'start',cursor:'pointer'}},
            !failed&&h('img',{src:url.href,alt:t('snapshot'),loading:'lazy',onError:()=>setFailed(true),style:{maxWidth:'100%',maxHeight:180,objectFit:'contain'}}),
            h('strong',null,path.split('/').at(-1)),h('small',null,t(failed?'snapshotUnavailable':'previewRight')))
        }
        ctx.effect(()=>ctx.slots.inject('conversation.chat.turnTail',()=>ctx.slots.register({
          name:'conversation.chat.turnTail',id:'dyoffice-snapshot',locale:namespace,
        },function SnapshotTail({turn,sessionId,openFile,t}){
          const data=turn.data.get('deliverables')
          const paths=[...(data?.presented??[]),...(data?.produced??[])].map(file=>file.path)
          if(!paths.some(path=>typeof path==='string'&&/\.(docx|xlsx|pptx|pdf)$/iu.test(path))){
            const blocks=turn.steps.map(step=>step.data.get('assistant-step')).filter(step=>step?.finalNode).at(-1)?.blocks??[]
            for(const block of blocks)if(block.kind==='text')for(const match of block.text.matchAll(/\[[^\]\n]*\]\(<?([^<>\n)]+?\.(?:docx|xlsx|pptx|pdf))>?\)/giu)){
              try{const path=decodeURIComponent(match[1].replace(/^sandbox:(?=\/[^/])/iu,''));if(!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(path))paths.push(path)}catch{}
            }
          }
          const files=[...new Set(paths.filter(path=>typeof path==='string'&&/\.(docx|xlsx|pptx|pdf)$/iu.test(path)))].slice(0,4)
          return files.length?h('div',{style:{display:'flex',gap:8,flexWrap:'wrap'}},...files.map(path=>h(FileThumbnail,{key:path,path,sessionId,openFile,t}))):null
        })))
        ctx.effect(() => ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
          name:'conversation.chat.commandview', key:'dyoffice', locale:namespace,
        }, function OfficeCommand({node,sessionId,t}) {
          const creation=useSyncExternalStore(creationStatus.subscribe,creationStatus.read)
          const entries=useSyncExternalStore(collaboration.subscribe,collaboration.read)
          const receipt=node.outcome?.kind==='success'&&creationReceipt(node.outcome.text??'')
          const entry=receipt ? entries?.get(receipt.fileId) : undefined
          const fileId=receipt?.fileId
          const jobs=useSyncExternalStore(runners.subscribe,runners.read)
          const job=jobs?.get(fileId)
          useEffect(()=>{
            if(!receipt||job||!entry?.topic||!entry.inlineChecked||entry.state||entry.ended||
                !entry.snapshot||entry.snapshot.text?.trim())return
            officeSessions.set(sessionId,fileId)
            startRunner(receipt,true)
          },[fileId,job,entry?.topic,entry?.inlineChecked,entry?.state,entry?.ended,entry?.snapshot,sessionId])
          const editor=useSyncExternalStore(job?.editor.subscribe??noSubscribe,job?.editor.read??emptyValue)
          useEffect(()=>{
            if(!fileId||entry?.snapshot)return
            const controller=new AbortController(),url=previewUrl()
            url.searchParams.set('file',fileId)
            url.searchParams.set('inlinePreview','1')
            const update=payload=>{
              const {preview,writing}=payload??{}
              if(controller.signal.aborted)return
              const entries=collaboration.read()??new Map()
              const current=entries.get(fileId)??{turns:[],sessionId}
              const snapshot=preview?.fileId===fileId&&uuid.test(preview?.revision??'')?{revision:preview.revision,text:preview.text}:undefined
              collaboration.set(new Map(entries).set(fileId,{...current,snapshot:current.snapshot??snapshot,topic:current.topic??writing?.topic,inlineChecked:true}))
            }
            void fetch(url,{signal:controller.signal,cache:'no-store'})
              .then(async response=>update(response.ok?await response.json():null)).catch(()=>update(null))
            return ()=>controller.abort()
          },[fileId,sessionId])
          const row=(author,body,key)=>h('article',{key,className:'dsh-office-message','data-party':author},
            h('strong',null,author),h('div',{className:'dsh-office-message-body',dir:'auto'},body))
          const stage={planning:'planning',writing:'generating',saving:'awaitingSave',saved:'handedOff',conflict:'writingConflict',saveFailed:'writingSaveFailed',failed:'writingFailed',noModel:'noModel',outputLimit:'outputLimit',timedOut:'timedOut',emptyOutput:'emptyOutput',noTool:'noTool'}[entry?.state]
          const review=entry?.review
          const inProgress = label=>h(WorkStatus,{label:t(label),started:node.time,t})
          const connection=useSyncExternalStore(connectionStatus.subscribe,connectionStatus.read)
          const remote=job?.embedded
          const opening=editor?.fileId===fileId&&!!fileId
          const canPreview=remote&&opening&&!entry?.disconnected
          const [showText,setShowText]=useState(false)
          const liveFrame=canPreview&&!showText
          const previewAnchor=useRef(null)
          useEffect(()=>{
            const element=previewAnchor.current
            if(!element||!remote)return
            const anchor={element}
            anchors.set(new Map(anchors.read()).set(fileId,anchor))
            return ()=>{
              const locations=new Map(anchors.read())
              if(locations.get(fileId)===anchor){locations.delete(fileId);anchors.set(locations)}
            }
          },[fileId,remote,liveFrame])
          const external=useRef(null)
          const openWindow=()=>{
            if(entry?.ended || remote&&editor?.embedded&&opening){
              if(external.current&&!external.current.closed){external.current.focus();return}
              external.current=window.open(receipt.href,'_blank','popup,width=1200,height=850')
              updateCollaboration(fileId,e=>({...e,popupBlocked:!external.current}))
              return
            }
            if(opening&&!editor.popup.closed){editor.popup.focus();return}
            const popup=window.open(receipt.href,'_blank','popup,width=1200,height=850')
            if(!popup){updateCollaboration(fileId,e=>({...e,popupBlocked:true}));return}
            const entries=collaboration.read()??new Map()
            const current=entries.get(fileId)
            collaboration.set(new Map(entries).set(fileId,{...current,sessionId,turns:finishInterruptedTurn(current?.turns??[]),
              popupBlocked:false,disconnected:false,state:undefined,draft:undefined,syncState:undefined}))
            officeSessions.set(sessionId,fileId)
            startRunner(receipt,false,popup)
          }
          const active=!entry?.disconnected&&['planning','writing','saving'].includes(entry?.state)
          if(!receipt)return node.outcome?h('div',{role:node.outcome.kind==='error'?'alert':undefined,style:textStyle},node.outcome.text)
            :inProgress(creation?.id&&creation.sessionId===sessionId?'creating':'sending')
          const syncLabel=entry?.ended?'syncEnded':entry?.disconnected||entry?.syncState==='stale'?'syncStale':entry?.syncState==='live'?'syncLive':null
          const revision=entry?.snapshot?.revision
          const ownsSession=entry&&!entry.ended&&officeSessions.get(entry.sessionId)===fileId
          const canChat=ownsSession&&opening&&!entry.disconnected&&entry.state==='saved'
          const needsWindow=remote&&entry?.checked&&entry.topic&&!stage&&!opening&&!allowsEmbed(connection,receipt.origin)
          const waitingForReceipt=opening&&entry?.topic&&!stage
          const canEnd=canChat||(ownsSession&&(needsWindow||waitingForReceipt||entry.disconnected))
          let waitingMessage
          if(job&&entry?.topic&&!stage&&!entry.ended){
            if(entry.disconnected)waitingMessage=h('span',{role:'status'},t('reopenForChat'))
            else if(needsWindow)waitingMessage=t('openToWrite')
            else waitingMessage=inProgress('waitingWriter')
          }
          // An ended conversation no longer needs directions for reconnecting.
          const interrupted=entry?.disconnected&&entry.state!=='saved'
          const showStage=stage&&!(interrupted&&entry.ended)
          const messages=[
            entry?.topic&&row('DSH',t('requestDraft')+' '+entry.topic,'request'),
            showStage&&row('DyOffice',active?inProgress(stage):h('span',{role:'status'},t(interrupted?'reopenForChat':stage)),'writing'),
            waitingMessage&&row('DyOffice',waitingMessage,'waiting'),
            receipt&&entry?.checked&&!entry.topic&&!stage&&row('DyOffice',t('created'),'created'),
            entry?.reply&&row('DyOffice',entry.reply,'office-reply'),
            review&&row('DSH',review.state==='reviewing'?inProgress('reviewing'):
              h('div',null,h('strong',null,t({ready:'reviewReady',failed:'reviewFailed',noModel:'reviewNoModel'}[review.state])),review.text&&h('div',null,review.text)),'review'),
            entry?.turns?.flatMap(turn=>[
              row(t('you'),turn.question,turn.id+'-question'),
              row('DyOffice',turn.state==='failed'?t('officeAnswerFailed'):turn.answer||inProgress('officeAnswering'),turn.id+'-answer'),
            ]),
          ].flat().filter(Boolean)
          return h('section',{'aria-label':'DyOffice',className:'dsh-office-studio'},
            h('style',null,studioStyles),
            h('header',null,h('span',{className:'dsh-office-filetype'},receipt.name.split('.').at(-1)?.toUpperCase()),
              h('div',{className:'dsh-office-name'},h('strong',{title:receipt.name},receipt.name),
                revision&&h('small',{title:revision},t('revision'),' · ',revision.slice(0,8))),
              h('button',{type:'button',onClick:openWindow},t('openWindow'),' ↗')),
            entry?.popupBlocked&&h('p',{role:'status',style:pairStyles.hint},t('syncBlocked')),
            h('div',{className:'dsh-office-grid'},
              h('div',{className:'dsh-office-canvas'},
                h('div',{className:'dsh-office-tools'},
                  h('small',null,t(liveFrame?'livePreview':entry?.draft?'draftText':'savedPreview')),
                  canPreview&&h('button',{type:'button',onClick:()=>setShowText(value=>!value)},t(liveFrame?'textMode':'webPreview'))),
                liveFrame?h('div',{ref:previewAnchor,className:'dsh-office-frame'})
                  :h(DocumentExcerpt,{entry,pending:!entry?.inlineChecked&&!entry?.checked,t})),
              messages.length>0&&h('section',{className:'dsh-office-log','aria-label':t('messagesLabel')},messages)),
            (syncLabel||canEnd||entry?.skillName)&&h('footer',{className:'dsh-office-footer'},
              syncLabel&&h('span',{role:'status'},t(syncLabel)),
              entry?.skillName&&h('small',null,t('skillLabel'),' · ',entry.skillName),
              canChat&&h('span',null,t('destination'),' · DyOffice'),
              canEnd&&h('button',{type:'button',onClick:()=>{
                officeSessions.delete(entry.sessionId)
                stopRunner(receipt.fileId)
                updateCollaboration(receipt.fileId,current=>({...current,ended:true}))
              }},t('endOfficeChat'))))
        })))
        function AuthorizationPrompt({sessionId}) {
          const shown = useRef(null)
          const [origin,setOrigin]=useState(null)
          useEffect(() => {
            ctx.uiConversation.binding(sessionId).activate(activityTarget)
            const controller = new AbortController()
            const url = previewUrl()
            url.searchParams.set('authorizationSession', sessionId)
            let timer
            async function check() {
              try {
                const response = await fetch(url, {cache: 'no-store', signal: controller.signal})
                if (!response.ok) return
                const {requestId, creationId} = await response.json()
                if (controller.signal.aborted) return
                const progress = creationStatus.read()
                if (creationId && progress?.id !== creationId) {
                  creationStatus.set({id: creationId, sessionId})
                } else if (!creationId && progress?.id && progress.sessionId === sessionId) {
                  creationStatus.set(null)
                }
                if (requestId && requestId !== shown.current) {
                  shown.current = requestId
                  const connection=await fetch(previewUrl(),{signal:controller.signal,cache:'no-store'})
                  if(connection.status===428&&!controller.signal.aborted)setOrigin((await connection.json()).origin??'')
                } else if(!requestId&&shown.current) {
                  shown.current=null
                  setOrigin(null)
                }
              } catch {
                // Retry while the composer is mounted.
              } finally {
                if (!controller.signal.aborted) timer = setTimeout(check, 750)
              }
            }
            void check()
            return () => {
              controller.abort()
              clearTimeout(timer)
              if (creationStatus.read()?.id && creationStatus.read().sessionId === sessionId) creationStatus.set(null)
            }
          }, [sessionId])
          return origin===null?null:h(Authorization,{origin,t,onConnected:()=>setOrigin(null)})
        }
        ctx.effect(() => ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name: 'conversation.input.overlay', id: 'dyoffice-authorization', order: 5,
        }, AuthorizationPrompt)))
      },
    }
  },
})
