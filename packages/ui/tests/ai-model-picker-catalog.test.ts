/** @vitest-environment jsdom */
import {act, createElement, useState} from 'react'
import {createRoot} from 'react-dom/client'
import {afterEach, beforeEach, expect, test, vi} from 'vitest'
import {AiModelPicker} from '../src/AiModelPicker'

;(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const setSettings = vi.fn()
const entries = [
  {id: 'model-a', label: '团队默认', model: 'deepseek-chat', providerId: 'deepseek'},
  {id: 'model-b', label: '备用模型', model: 'deepseek-reasoner', providerId: 'deepseek'},
]
const bridge = {getSettings: vi.fn(async () => {throw new Error('catalog mode does not read device settings')}), setSettings}

function Host() {
  const [selected, setSelected] = useState('model-a')
  return createElement(AiModelPicker, {bridge, lang: 'zh', catalogEntries: entries, selectedId: selected, onCatalogSelect: setSelected})
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.clearAllMocks()
})

test('uses the official composer chip and provider-grouped menu for server-managed models', async () => {
  await act(async () => root.render(createElement(Host)))
  expect(host.querySelector('.ai-model-chip')?.textContent).toContain('deepseek-chat')
  expect(bridge.getSettings).not.toHaveBeenCalled()
  await act(async () => host.querySelector<HTMLButtonElement>('.ai-model-chip')!.click())
  expect(host.querySelector('.ai-model-pop .ai-model-group-head')?.textContent).toContain('DeepSeek')
  const option = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(item => item.textContent?.includes('deepseek-reasoner'))
  expect(option).toBeDefined()
  await act(async () => option!.click())
  expect(host.querySelector('.ai-model-chip')?.textContent).toContain('deepseek-reasoner')
  expect(setSettings).not.toHaveBeenCalled()
})
