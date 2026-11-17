import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import ts from 'typescript'

test('Shell typechecking includes PPTX bidi declaration required by the native slides bridge',()=>{
 const configPath=fileURLToPath(new URL('../tsconfig.shell.json',import.meta.url))
 const read=ts.readConfigFile(configPath,ts.sys.readFile)
 assert.equal(read.error,undefined)
 const parsed=ts.parseJsonConfigFileContent(read.config,ts.sys,fileURLToPath(new URL('../',import.meta.url)))
 assert.deepEqual(parsed.errors,[])
 const declaration=fileURLToPath(new URL('../../../packages/pptx-render/src/bidi-js.d.ts',import.meta.url))
 assert.ok(parsed.fileNames.includes(declaration),'native slides requires the existing typed bidi API, not implicit any')
})
