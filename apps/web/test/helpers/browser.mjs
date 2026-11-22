import {chromium} from '@playwright/test'
import {appendFileSync} from 'node:fs'

// The default remains Playwright's pinned browser. Managed local verification may
// name an installed Chromium explicitly; record that version in the evidence.
export function recordVerifiedOfficeEffect(format, verifiedEffect) {
  const tracePath = process.env.DYOFFICE_TEST_AI_TOOL_TRACE
  if (tracePath) appendFileSync(tracePath, JSON.stringify({format, verifiedEffect})+'\n', {mode:0o600})
}

export async function launchTestBrowser() {
  const browser = await chromium.launch({
    ...(process.env.DYOFFICE_TEST_CHROMIUM_PATH ? {executablePath: process.env.DYOFFICE_TEST_CHROMIUM_PATH} : {}),
  })
  const tracePath = process.env.DYOFFICE_TEST_AI_TOOL_TRACE
  if (!tracePath) return browser

  const tracked = new WeakSet()
  const toolName = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value)
  function track(context) {
    if (tracked.has(context)) return context
    tracked.add(context)
    context.on('request', request => {
      if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/v1/ai/turns') return
      let input
      try { input = request.postDataJSON()?.request } catch { return }
      if (!input || !Array.isArray(input.tools) || !Array.isArray(input.messages)) return
      const format = ['docx','xlsx','pptx','pdf'].includes(input.format) ? input.format : 'workspace'
      const offered = input.tools.map(tool => tool?.name).filter(toolName)
      const results = input.messages.flatMap(message => message?.role === 'tool' && Array.isArray(message.results) ? message.results : [])
        .filter(result => toolName(result?.name)).map(result => ({name:result.name,error:result.isError===true}))
      // Record tool names and outcomes only. Prompts, arguments, results, URLs and credentials stay out of the trace.
      appendFileSync(tracePath, JSON.stringify({format,offered,results})+'\n', {mode:0o600})
    })
    return context
  }
  const newContext = browser.newContext.bind(browser)
  const newPage = browser.newPage.bind(browser)
  browser.newContext = async (...options) => track(await newContext(...options))
  browser.newPage = async (...options) => {
    const page = await newPage(...options)
    track(page.context())
    return page
  }
  return browser
}

