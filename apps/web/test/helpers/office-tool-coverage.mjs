import {readFileSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
import {ASSISTANT_FORMAT_TOOLS, ASSISTANT_DELEGATION_TOOLS, assistantSourceTools} from '../../../../packages/web-contracts/src/assistant.ts'

const toolName = name => typeof name === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(name)
const requiredEffects = new Map([
  ['docx', new Set(['insert_data_result'])],
  ['xlsx', new Set(['insert_data_result'])],
  ['pptx', new Set(['insert_data_result'])],
  ['pdf', new Set(['apply_ops.rotatePages'])],
])
const observations = () => ({offered:new Set(), succeeded:new Set()})

export function summarizeOfficeToolCoverage(trace) {
  const observed = new Map([...Object.keys(ASSISTANT_FORMAT_TOOLS), 'workspace'].map(format => [format, observations()]))
  const shared = observations()
  const verifiedEffects = new Map([...requiredEffects.keys()].map(format => [format, new Set()]))
  for (const [index, line] of trace.split('\n').entries()) {
    if (!line.trim()) continue
    const invalid = () => new Error(`Invalid Office tool trace at line ${index + 1}`)
    let event
    try { event = JSON.parse(line) } catch { throw invalid() }
    if (event && Object.hasOwn(event, 'verifiedEffect')) {
      if (Object.keys(event).length !== 2 || !requiredEffects.get(event.format)?.has(event.verifiedEffect)) throw invalid()
      verifiedEffects.get(event.format).add(event.verifiedEffect)
      continue
    }
    const format = observed.get(event?.format)
    if (!format || !Array.isArray(event.offered) || !event.offered.every(toolName) ||
        !Array.isArray(event.results) || !event.results.every(result => toolName(result?.name) && typeof result.error === 'boolean')) throw invalid()
    for (const name of event.offered) {
      format.offered.add(name)
      shared.offered.add(name)
    }
    for (const {name,error} of event.results) {
      if (error) continue
      format.succeeded.add(name)
      shared.succeeded.add(name)
    }
  }

  const gaps = []
  function coverage(format, names, observed) {
    let registered = 0, executed = 0
    for (const name of names) {
      if (observed.offered.has(name)) registered++
      else gaps.push(`${format}: missing registration for ${name}`)
      if (observed.succeeded.has(name)) executed++
      else gaps.push(`${format}: missing successful execution for ${name}`)
    }
    return {registered,executed,required:names.size}
  }

  const effects = {verified:0,required:0}
  for (const [format,names] of requiredEffects) {
    effects.required += names.size
    for (const name of names) {
      if (verifiedEffects.get(format).has(name)) effects.verified++
      else gaps.push(`${format}: missing saved-artifact verification for ${name}`)
    }
  }

  return {
    formats:Object.fromEntries(Object.entries(ASSISTANT_FORMAT_TOOLS).map(([format,names]) =>
      [format,coverage(format,names,observed.get(format))])),
    shared:coverage('shared',new Set([...ASSISTANT_DELEGATION_TOOLS,...assistantSourceTools('read-only-analysis')]),shared),
    effects,
    gaps,
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const path = process.argv[2]
  if (!path || process.argv.length !== 3) {
    console.error('Usage: node --import tsx apps/web/test/helpers/office-tool-coverage.mjs <trace.jsonl>')
    process.exitCode = 1
  } else {
    try {
      const {formats,shared,effects,gaps} = summarizeOfficeToolCoverage(readFileSync(path,'utf8'))
      for (const [format,result] of Object.entries({...formats,shared})) {
        console.log(`${format}: ${result.registered}/${result.required} registered, ${result.executed}/${result.required} executed`)
      }
      console.log(`saved-artifact effects: ${effects.verified}/${effects.required} verified`)
      for (const gap of gaps) console.error(gap)
      if (gaps.length) process.exitCode = 1
    } catch (error) {
      console.error(error.message.startsWith('Invalid Office tool trace') ? error.message : 'Could not read Office tool coverage trace')
      process.exitCode = 1
    }
  }
}
