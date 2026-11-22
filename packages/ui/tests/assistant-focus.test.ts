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
