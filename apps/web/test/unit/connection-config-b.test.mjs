import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import postcss from 'postcss'
const css=readFileSync(new URL('../../src/shell/connection-config-b.css',import.meta.url),'utf8')
const root=postcss.parse(css)
test('B connections and global configuration styles cannot reach other management or editor surfaces',()=>{
 root.walkRules(rule=>{for(const selector of rule.selectors)assert.match(selector,/^section\.(sources-panel-b|global-settings-b)\b/)})
 assert.doesNotMatch(css,/#[0-9a-f]{3,8}\b|\brgba?\(/i)
})
test('database connections load their native styles while global configuration retains its styles',()=>{
 const sources=readFileSync(new URL('../../src/shell/SourcesPanel.tsx',import.meta.url),'utf8')
 assert.ok(sources.includes("import './database-connections.css'"))
 assert.doesNotMatch(sources,/from ['"]antd['"]|from ['"]@ant-design/)
 assert.ok(sources.includes('database-connections'))
 const global=readFileSync(new URL('../../src/shell/GlobalSettingsPanel.tsx',import.meta.url),'utf8')
 assert.ok(global.includes("import './global-settings.css'"))
 assert.ok(global.includes('global-settings-refined'))
})
test('B finishing layer keeps pagination and content visible with focus and narrow-screen wrapping',()=>{
 assert.doesNotMatch(css,/(?:display:\s*none|overflow(?:-y)?:\s*hidden|outline:\s*(?:none|0))/)
 assert.match(css,/:focus-visible[\s\S]*outline: 2px solid var\(--accent\)/)
 assert.match(css,/@media \(max-width: 760px\)/)
 assert.match(css,/\.global-settings-entry-danger \{ flex-wrap: wrap; \}/)
})
