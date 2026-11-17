import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PlaywrightDriver } from '../src/drivers/playwright'

describe('SaaS browser driver boundary', () => {
  it('keeps the server browser driver loadable without an Electron runtime', () => {
    expect(typeof PlaywrightDriver).toBe('function')
    expect(existsSync(new URL('../src/drivers/electron.ts', import.meta.url))).toBe(false)
  })
})
