import { describe, expect, it } from 'vitest'
import { globalSearchOptions } from '../src/search-tools.ts'

describe('global search provider options', () => {
  it('uses only the configured provider key and disables desktop Genspark auth', () => {
    expect(globalSearchOptions('serper', 'serper-secret')).toEqual({
      useGsk: false,
      serperKey: 'serper-secret',
      serplyKey: '',
      searchapiKey: '',
      tavilyKey: '',
      parallelKey: '',
      exaKey: '',
      firecrawlKey: '',
      keenableKey: '',
      prefer: 'serper',
    })
    expect(globalSearchOptions('tavily', 'tavily-secret')).toEqual({
      useGsk: false,
      serperKey: '',
      serplyKey: '',
      searchapiKey: '',
      tavilyKey: 'tavily-secret',
      parallelKey: '',
      exaKey: '',
      firecrawlKey: '',
      keenableKey: '',
      prefer: 'tavily',
    })
  })

  it('supports the configured keyless provider without reading process environment keys', () => {
    expect(globalSearchOptions('keenable', '')).toEqual({
      useGsk: false,
      serperKey: '',
      serplyKey: '',
      searchapiKey: '',
      tavilyKey: '',
      parallelKey: '',
      exaKey: '',
      firecrawlKey: '',
      keenableKey: '',
      prefer: 'keenable',
    })
  })

  it('rejects providers that are unavailable in the Web runtime', () => {
    expect(() => globalSearchOptions('genspark', '')).toThrow('Search provider unavailable')
    expect(() => globalSearchOptions('unknown', '')).toThrow('Search provider unavailable')
  })
})
