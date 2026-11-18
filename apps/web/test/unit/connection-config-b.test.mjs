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
test('both actual panels opt in without replacing the shared styles',()=>{
 for(const [file,base,marker] of [['SourcesPanel','workspace-panels','sources-panel-b'],['GlobalSettingsPanel','global-settings','global-settings-b']]){
  const source=readFileSync(new URL(`../../src/shell/${file}.tsx`,import.meta.url),'utf8')
  assert.ok(source.includes(`import './${base}.css'`));assert.ok(source.includes("import './connection-config-b.css'"));assert.ok(source.includes(marker))
 }
})
test('B finishing layer keeps pagination and content visible with focus and narrow-screen wrapping',()=>{
 assert.doesNotMatch(css,/(?:display:\s*none|overflow(?:-y)?:\s*hidden|outline:\s*(?:none|0))/)
 assert.match(css,/:focus-visible[\s\S]*outline: 2px solid var\(--accent\)/)
 assert.match(css,/@media \(max-width: 760px\)/)
 assert.match(css,/\.global-settings-entry-danger \{ flex-wrap: wrap; \}/)
})
