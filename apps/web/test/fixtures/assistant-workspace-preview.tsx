import React, { useState } from 'react'
import { Markdown, SentAttachments } from '@genoffice/ui'
import { createRoot } from 'react-dom/client'
import { AssistantSendButton } from '@genoffice/ui'
import { createEditorAssistant } from '../../src/editors/assistant'
import '@genoffice/ui/tokens.css'
import '@genoffice/ui/ai-model-picker.css'
import '../../../docs/src/renderer/styles.css'
import '../../src/editors/ai-dock-theme.css'

// Isolated browser fixture: no real session or model request leaves this page.
let previewOutcome: 'succeeded' | 'failed' | 'unknown_outcome' = 'succeeded'
let advanceOutput: () => void
let finishOutput: () => void
window.fetch = async (path, init) => {
  if (String(path) === '/api/v1/auth/session-proof')
    return Response.json({ csrfToken: 'p'.repeat(43) })
  if (String(path) === '/api/v1/auth/me') return Response.json({ user: { username: 'lin' } })
  if (String(path) === '/api/v1/settings/public') return Response.json({})
  if (String(path) === '/api/v1/ai/catalog')
    return Response.json({
      entries: [
        { id: 'ds', label: 'ds', model: 'ds' },
        {
          id: 'long',
          label: 'Very long model name for overflow verification',
          model: 'Very long model name for overflow verification',
        },
      ],
      defaultId: 'ds',
      agents: [
        { id: 'codex', name: 'Codex', origin: 'builtin', capabilities: ['coding'] },
        { id: 'external', name: 'Research', origin: 'external', capabilities: ['coding'] },
      ],
      defaultAgentId: 'codex',
    })
  if (String(path) === '/api/v1/agents/tasks') {
    const outcome = previewOutcome
    if (outcome === 'failed') return new Response(null, { status: 403 })
    const body = JSON.parse(init!.body as string)
    const output = JSON.stringify({
      summary: 'Analysis ready',
      output: JSON.parse(body.request.messages[0].text).instruction + '\nComputed: 42',
    })
    return new Response(
      new ReadableStream({
        start(controller) {
          const emit = (event: string, value: unknown) =>
            controller.enqueue(
              new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`),
            )
          emit('progress', { kind: 'status', text: 'Executing command' })
          emit('progress', { kind: 'output', text: 'Checking the calculation…' })
          advanceOutput = () => emit('progress', { kind: 'output', text: '\nVerified the result.' })
          finishOutput = () => {
            if (outcome === 'unknown_outcome') emit('error', { message: 'Harness task failed. Check server diagnostics.' })
            else emit('delta', { text: output })
            emit('done', {})
            controller.close()
          }
          if (outcome === 'unknown_outcome') setTimeout(finishOutput, 600)
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }
  throw Error('Unexpected preview request')
}

async function mount() {
  const assistant = await createEditorAssistant()
  Object.assign(window, {
    advancePreviewOutput: () => advanceOutput(),
    finishPreviewOutput: () => finishOutput(),
    runPreviewHarness: (outcome: typeof previewOutcome = 'succeeded', instruction = '分析当前巡检记录') => {
      if (!assistant.coding) throw Error('Harness preview is unavailable')
      previewOutcome = outcome
      void assistant.coding.run({ agentId: 'codex', instruction }, undefined, assistant.selected(), 'user').catch(() => {})
    },
  })
  function Preview() {
    const showAttachment = new URLSearchParams(location.search).has('attachment')
    const shortMessage = new URLSearchParams(location.search).has('short')
    const filename = '季度巡检记录_' + 'regional_summary_'.repeat(5) + '2026.xlsx'
    const [draft, setDraft] = useState('分析当前巡检记录')
    return (
      <aside
        className="ai-panel"
        style={{
          width: '100%',
          height: '100vh',
          maxWidth: 400,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <header className="ai-panel-header">
          <strong>AI 助手</strong>
        </header>
        {assistant.workspace.panel}
        <div className="ai-chat">
          {assistant.workspace.conversation(
            <>
              <div key="user" className="ai-msg ai-msg-user">
                {showAttachment && <SentAttachments atts={[{ path: filename, name: filename, ext: 'xlsx', sizeBytes: 18432 }]} previews={{}} />}
                {shortMessage ? <span dir="auto">水印 junge</span> : <div dir="auto"><Markdown text={showAttachment ? '请核对以下附件。\n\n文件名：' + filename : '帮我分析巡检记录，整理异常要点。'} /></div>}
              </div>
              <div key="office" className="ai-msg ai-msg-assistant">
                我会先核对记录，再交给 Codex 分析并汇总结果。
              </div>
            </>,
          )}
        </div>
        <div className="ai-composer">
          <div className="ai-input-box">
            <textarea
              aria-label="草稿"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="ai-input-footer">
              {assistant.modelPicker}
              <AssistantSendButton label="发送" disabled={!draft.trim()} onClick={() => void assistant.workspace.submit(draft, false)} />
            </div>
          </div>
        </div>
      </aside>
    )
  }
  createRoot(document.getElementById('root')!).render(<Preview />)
}
void mount()
