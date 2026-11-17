import {readFileSync} from 'node:fs'
import {afterEach, describe, expect, it} from 'vitest'
import {act, createElement} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {Editor} from '@tiptap/core'
import {chromium} from '@playwright/test'
import {editorExtensions} from '../src/renderer/editor/extensions'
import {computeFormatState} from '../src/renderer/components/ribbon-format-state'
import {Ribbon} from '../src/renderer/components/Ribbon'
import {ribbonProps} from './helpers/ribbon-props'

const css = readFileSync('src/renderer/styles.css', 'utf8')
let root: Root | undefined
let editor: Editor | undefined
let container: HTMLDivElement | undefined
afterEach(() => {
  if (root) act(() => root!.unmount())
  editor?.destroy()
  container?.remove()
})

describe('Web Word ribbon layout', () => {
  it('keeps all top controls reachable at 390px and the desktop row unchanged', async () => {
    editor = new Editor({element: document.createElement('div'), extensions: editorExtensions})
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root!.render(createElement(Ribbon, ribbonProps(editor!, computeFormatState(editor!)))))
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      const measure = async (width: number, web: boolean) => {
        await page.setViewportSize({width, height: 1000})
        await page.setContent(`<style>${css}</style><div class="${web ? 'dyoffice-native-docs' : ''}">${container!.innerHTML}</div>`)
        return page.locator('.ribbon-tabs').evaluate(row => {
          const controls = [...row.querySelectorAll<HTMLElement>('button, .autosave-toggle')]
            .filter(el => el.getClientRects().length)
          return {
            documentWidth: document.documentElement.scrollWidth,
            overflow: controls.filter(el => {
              const box = el.getBoundingClientRect()
              return box.left < 0 || box.right > innerWidth
            }).map(el => el.textContent || el.getAttribute('aria-label')),
            wrap: getComputedStyle(row).flexWrap,
            paddingRight: getComputedStyle(row).paddingRight,
            count: controls.length,
          }
        })
      }
      const desktop = await measure(1440, true)
      expect(desktop.wrap).toBe('nowrap')
      expect(desktop.paddingRight).toBe('150px')
      expect(desktop.overflow).toEqual([])
      const mobile = await measure(390, true)
      expect(mobile.count).toBe(desktop.count)
      expect(mobile.documentWidth).toBe(390)
      expect(mobile.overflow).toEqual([])
      expect(mobile.wrap).toBe('wrap')
      const native = await measure(390, false)
      expect(native.wrap).toBe('nowrap')
      expect(native.paddingRight).toBe('150px')
    } finally {
      await browser.close()
    }
  })
})
