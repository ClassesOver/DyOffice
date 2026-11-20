// The AI panel stays mounted while collapsed (rail only),
// so the conversation, draft, and in-flight runs survive collapse/expand.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { AiPanel } from '../src/renderer/ai/AiPanel'
import { AI_PROVIDERS, type AiSettings } from '../src/shared/ipc'
import type { AgentStreamRequest, AgentTransport, HarnessCheckpoint } from '@genoffice/agent-core'

const settings: AiSettings = {
  provider: 'anthropic',
  providers: Object.fromEntries(
    AI_PROVIDERS.map((p) => [p.id, { apiKey: '', model: p.defaultModel }]),
  ) as AiSettings['providers'],
}

function createEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: [
        {
          type: 'docParagraph',
          attrs: { docxIndex: 0 },
          content: [{ type: 'text', text: 'EVs market research' }],
        },
      ],
    },
  })
}

function mount(element: React.ReactElement): {
  container: HTMLElement
  root: Root
  cleanup: () => void
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(element))
  return {
    container,
    root,
    cleanup: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

function panelProps(editor: Editor, overrides: Record<string, unknown> = {}) {
  return {
    editor,
    blocks: [],
    settings,
    open: true,
    onExpand: () => {},
    onCollapse: () => {},
    ...overrides,
  }
}

/** Simulate typing into React's controlled textarea */
function typeInto(textarea: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeAll(() => {
  // jsdom has no scrollTo; the panel auto-scrolls its chat log
  Element.prototype.scrollTo ??= () => {}
})

describe('AiPanel collapse', () => {
  it('keeps the draft input across a collapse/expand cycle', () => {
    const editor = createEditor()
    const { container, root, cleanup } = mount(createElement(AiPanel, panelProps(editor)))

    const textarea = container.querySelector<HTMLTextAreaElement>('.ai-input-box textarea')
    expect(textarea).not.toBeNull()
    typeInto(textarea!, 'unsent draft')
    expect(textarea!.value).toBe('unsent draft')

    // collapse: only the rail is rendered, but the component stays mounted
    act(() => root.render(createElement(AiPanel, panelProps(editor, { open: false }))))
    expect(container.querySelector('.ai-input-box textarea')).toBeNull()
    expect(container.querySelector('.ai-rail')).not.toBeNull()

    // expand: the draft is still there
    act(() => root.render(createElement(AiPanel, panelProps(editor, { open: true }))))
    const restored = container.querySelector<HTMLTextAreaElement>('.ai-input-box textarea')
    expect(restored).not.toBeNull()
    expect(restored!.value).toBe('unsent draft')

    cleanup()
    editor.destroy()
  })

  it('expands back through the rail button', () => {
    const editor = createEditor()
    const onExpand = vi.fn()
    const { container, cleanup } = mount(
      createElement(AiPanel, panelProps(editor, { open: false, onExpand })),
    )

    const rail = container.querySelector<HTMLButtonElement>('.ai-rail')
    expect(rail).not.toBeNull()
    act(() => rail!.click())
    expect(onExpand).toHaveBeenCalledTimes(1)

    cleanup()
    editor.destroy()
  })
})

describe('AiPanel Harness continuation', () => {
  const call = { id: 'call-1', name: 'delegate_agent_task', input: { instruction: 'Calculate total' } }
  const checkpoint: HarnessCheckpoint = {
    chatTurnId: 'original-turn', turns: 0, userIndex: 0, executedCalls: [],
    messages: [{ role: 'user', text: 'Calculate total' }, { role: 'assistant', text: '', toolCalls: [call] }],
  }
  const result = { id: call.id, name: call.name, output: '{"total":42}' }

  it.each([
    ['waits for a clean loaded revision and completes the original reply only once', false],
    ['does not resume after the document becomes dirty during a claim', true],
  ])('%s', async (_, dirtyDuringClaim) => {
    const editor = createEditor(), requests: AgentStreamRequest[] = []
    const finish = vi.fn(), beginRun = vi.fn(), claimed = vi.fn()
    let listener = () => {}, revision: string | undefined
    let releaseClaim!: () => void
    const claimGate = new Promise<void>(resolve => { releaseClaim = resolve })
    const transport: AgentTransport = {
      beginRun,
      stream(request, callbacks) {
        requests.push(request)
        queueMicrotask(() => { callbacks.onDelta('The total is 42.'); callbacks.onDone() })
        return { cancel() {} }
      },
    }
    const assistantRecovery = {
      continuationRevision: () => revision,
      catalog: { entries: [{ id: 'original-model' }] },
      coding: {
        snapshot: () => [
          { id: 'removed-1', continuationModelId: 'retired-model' },
          { id: 'removed-2', continuationModelId: 'retired-model' },
          { id: 'expired', continuationModelId: 'original-model' },
          { id: 'original-task', continuationModelId: 'original-model' },
        ],
        subscribe(next: () => void) { listener = next; return () => { listener = () => {} } },
        async resume(id: string) {
          claimed(id)
          if (id === 'expired') throw Error('Harness continuation unavailable')
          await claimGate
          return { checkpoint, result, modelId: 'original-model', revision: 'saved-v1' }
        },
      },
      fileChat: {
        async resume(turnId: string) {
          if (turnId !== 'original-turn') throw Error('Unexpected new chat turn')
          return { turnId, history: async () => [], text() {}, finish }
        },
      },
    }
    const render = () => createElement(AiPanel, panelProps(editor, { transport, assistantRecovery, recoveryRevision: revision }))
    const panel = mount(render())
    try {
      expect(claimed).not.toHaveBeenCalled()
      revision = 'saved-v1'
      await act(async () => panel.root.render(render()))
      expect(claimed.mock.calls).toEqual([['expired'], ['original-task']])
      await act(async () => { listener(); listener() })
      if (dirtyDuringClaim) {
        revision = undefined
        await act(async () => panel.root.render(render()))
      }
      await act(async () => { releaseClaim() })
      if (dirtyDuringClaim) {
        expect(beginRun).not.toHaveBeenCalled()
        expect(requests).toHaveLength(0)
        expect(finish).not.toHaveBeenCalled()
      } else {
        expect(beginRun).toHaveBeenCalledExactlyOnceWith('original-model')
        expect(requests).toHaveLength(1)
        expect(requests[0]?.messages).toEqual([...checkpoint.messages, { role: 'tool', results: [result] }])
        expect(finish).toHaveBeenCalledExactlyOnceWith('The total is 42.', false)
      }
      // The workspace transcript owns the original reply after refresh.
      expect(panel.container.querySelector('.ai-msg-assistant')).toBeNull()
      expect(panel.container.querySelector('.ai-msg-user')).toBeNull()
    } finally {
      panel.cleanup()
      editor.destroy()
    }
  })
})
