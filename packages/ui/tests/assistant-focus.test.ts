// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'

import { assistantHoldsKeyboard, registerAssistantFocusRoot } from '../src/assistant-focus'

afterEach(() => {
  document.body.innerHTML = ''
})

it('reports keyboard ownership only for focus inside a registered, connected root', () => {
  document.body.innerHTML = '<div id="dock"><textarea id="composer"></textarea></div><div id="editor" tabindex="0"></div>'
  const dock = document.getElementById('dock')!
  const composer = document.getElementById('composer') as HTMLTextAreaElement
  composer.focus()
  expect(assistantHoldsKeyboard()).toBe(false)
  const release = registerAssistantFocusRoot(dock)
  expect(assistantHoldsKeyboard()).toBe(true)
  ;(document.getElementById('editor') as HTMLElement).focus()
  expect(assistantHoldsKeyboard()).toBe(false)
  expect(assistantHoldsKeyboard(composer)).toBe(true)
  dock.remove()
  expect(assistantHoldsKeyboard(composer)).toBe(false)
  release()
})

it('treats the page body as nobody holding the keyboard', () => {
  const release = registerAssistantFocusRoot(document.body)
  expect(assistantHoldsKeyboard(document.body)).toBe(false)
  release()
})

it('keeps the native panel ref and focus registry in sync across root replacement', async () => {
  const { createElement, act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useAssistantFocusRoot } = await import('../src/assistant-focus')
  const hostRef = { current: null as HTMLElement | null }
  function Panel({ name }: { name: string }) {
    const ref = useAssistantFocusRoot(hostRef)
    return createElement('aside', { key: name, ref }, createElement('textarea'))
  }
  const mount = document.body.appendChild(document.createElement('div'))
  const root = createRoot(mount)
  await act(() => root.render(createElement(Panel, { name: 'first' })))
  const previous = hostRef.current!
  previous.querySelector('textarea')!.focus()
  expect(assistantHoldsKeyboard()).toBe(true)
  await act(() => root.render(createElement(Panel, { name: 'next' })))
  expect(hostRef.current).not.toBe(previous)
  document.body.append(previous)
  previous.querySelector('textarea')!.focus()
  expect(assistantHoldsKeyboard()).toBe(false)
  hostRef.current!.querySelector('textarea')!.focus()
  expect(assistantHoldsKeyboard()).toBe(true)
  await act(() => root.unmount())
  expect(hostRef.current).toBeNull()
})
