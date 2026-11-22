// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { registerAssistantFocusRoot } from '@genoffice/ui'

import { guardEditorBridge } from '../src/renderer/chrome-focus-guard'

let grid: HTMLDivElement
let editor: HTMLDivElement
let tab: HTMLButtonElement
let clock = 0
let unregister: () => void = () => {}
let calls = 0
const bridge = {
  setEditCell(): void {
    calls++
    // Univer focuses its hidden cell editor when no editor is logically focused.
    editor.focus()
  },
}

beforeEach(() => {
  document.body.innerHTML = '<div id="univer-container"><div id="cell-editor" tabindex="0"></div></div><aside class="copilot"><button id="tab">Tasks</button></aside><div class="ribbon"><button id="ribbon">Sort</button></div>'
  grid = document.getElementById('univer-container') as HTMLDivElement
  editor = document.getElementById('cell-editor') as HTMLDivElement
  tab = document.getElementById('tab') as HTMLButtonElement
  unregister = registerAssistantFocusRoot(document.querySelector('aside') as HTMLElement)
  clock = 10_000
  calls = 0
})
afterEach(() => {
  unregister()
  document.body.innerHTML = ''
})

describe('chrome focus guard', () => {
  it('returns focus to the assistant control when Univer re-anchors its editor', () => {
    const guard = guardEditorBridge(bridge, { container: () => grid, now: () => clock })
    tab.focus()
    bridge.setEditCell()
    expect(calls).toBe(1)
    expect(document.activeElement).toBe(tab)
    guard.dispose()
    tab.focus()
    bridge.setEditCell()
    expect(document.activeElement).toBe(editor)
  })

  it('lets a deliberate click into the grid take focus', () => {
    const guard = guardEditorBridge(bridge, { container: () => grid, now: () => clock })
    tab.focus()
    editor.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    clock += 100
    bridge.setEditCell()
    expect(document.activeElement).toBe(editor)
    // A stale click no longer counts as intent.
    tab.focus()
    clock += 5_000
    bridge.setEditCell()
    expect(document.activeElement).toBe(tab)
    guard.dispose()
  })

  it('does nothing when focus is already in the workbook or on the page body', () => {
    const guard = guardEditorBridge(bridge, { container: () => grid, now: () => clock })
    editor.focus()
    bridge.setEditCell()
    expect(document.activeElement).toBe(editor)
    ;(document.activeElement as HTMLElement).blur()
    bridge.setEditCell()
    expect(document.activeElement).toBe(editor)
    guard.dispose()
  })
})

it('leaves ribbon buttons to their own hand-back so commands that move the selection reach the grid', () => {
  const guard = guardEditorBridge(bridge, { container: () => grid, now: () => clock })
  const ribbon = document.getElementById('ribbon') as HTMLButtonElement
  ribbon.focus()
  bridge.setEditCell()
  expect(document.activeElement).toBe(editor)
  guard.dispose()
})

it('keeps focus in an assistant only through the shared focus contract, not its class name', () => {
  const guard = guardEditorBridge(bridge, { container: () => grid, now: () => clock })
  unregister()
  tab.focus()
  bridge.setEditCell()
  expect(document.activeElement).toBe(editor)
  // Any registered assistant root is protected, whatever its markup.
  const dock = document.createElement('div')
  dock.innerHTML = '<button id="card">Task</button>'
  document.body.append(dock)
  unregister = registerAssistantFocusRoot(dock)
  const card = document.getElementById('card') as HTMLButtonElement
  card.focus()
  bridge.setEditCell()
  expect(document.activeElement).toBe(card)
  guard.dispose()
})

it('still protects plain text entry outside the assistant', () => {
  const guard = guardEditorBridge(bridge, { container: () => grid, now: () => clock })
  unregister()
  const input = document.createElement('input')
  document.body.append(input)
  input.focus()
  bridge.setEditCell()
  expect(document.activeElement).toBe(input)
  guard.dispose()
})
