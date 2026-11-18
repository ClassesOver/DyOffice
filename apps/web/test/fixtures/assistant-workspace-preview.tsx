import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createEditorAssistant } from '../../src/editors/assistant'
import '@genoffice/ui/tokens.css'
import '@genoffice/ui/ai-model-picker.css'
import '../../../docs/src/renderer/styles.css'

// Isolated browser fixture: no real session or model request leaves this page.
window.fetch = async (path, init) => {
  if (String(path) === '/api/v1/auth/session-proof')
    return Response.json({ csrfToken: 'p'.repeat(43) })
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
          setTimeout(() => {
            emit('progress', { kind: 'output', text: '\nVerified the result.' })
            emit('delta', { text: output })
            emit('done', {})
            controller.close()
          }, 600)
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }
  throw Error('Unexpected preview request')
}

async function mount() {
  const assistant = await createEditorAssistant()
  function Preview() {
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
                帮我分析巡检记录，整理异常要点。
              </div>
              <div key="office" className="ai-msg ai-msg-assistant">
                我会先核对记录，再交给 Codex 分析并汇总结果。
              </div>
            </>,
          )}
        </div>
        <div
          className="ai-composer"
          onKeyDownCapture={(event) =>
            assistant.workspace.handleComposerKeyDown(event, draft, setDraft)
          }
        >
          {assistant.workspace.renderRecipient(draft, setDraft)}
          <div className="ai-input-box">
            <textarea
              aria-label="草稿"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="ai-input-footer">
              {assistant.modelPicker}
              <button type="button" onClick={() => void assistant.workspace.submit(draft, false)}>
                发送
              </button>
            </div>
          </div>
        </div>
      </aside>
    )
  }
  createRoot(document.getElementById('root')!).render(<Preview />)
}
void mount()
