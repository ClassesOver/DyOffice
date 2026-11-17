import { describe, expect, it } from 'vitest'
import * as shared from '../src/index'

describe('shared SaaS utility entrypoint', () => {
  it('loads without Electron and retains safe URL/image helpers', () => {
    expect(shared.safeExternalUrl('https://example.com')).toBe('https://example.com')
    expect(shared.decodeDataUrl('data:text/plain;base64,aGk=')?.bytes.toString()).toBe('hi')
  })
  it('does not expose retired desktop launch, dialog or protocol APIs', () => {
    for (const key of ['installDropOpenBridge', 'installRendererProtocol', 'registerRendererScheme', 'installContextMenu', 'installNavigationGuard', 'showSaveDialogWithMemory', 'saveImageFromUrl']) {
      expect(shared).not.toHaveProperty(key)
    }
  })
})
