// Test-only observer. Never retain text, HTML, event data, URLs or error messages.
// Self-contained so Playwright can serialize it into the page before navigation.
export function installInputDiagnostics() {
  const events = [], limit = 128
  let sequence = 0, lastState = ''
  const integer = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000) : null
  const editor = () => document.querySelector('.tiptap.doc-page')
  const position = (node, offset, root) => {
    if (!node || !root || !root.contains(node)) return null
    const path = []; let current = node
    while (current !== root && path.length < 12) {
      const parent = current.parentNode
      if (!parent) return null
      path.unshift(integer(Array.prototype.indexOf.call(parent.childNodes, current))); current = parent
    }
    return {path, truncated: current !== root, nodeType: integer(node.nodeType), offset: integer(offset)}
  }
  const snapshot = () => {
    const root = editor(), selection = document.getSelection()
    // Tiptap Editor.createView explicitly assigns view.dom.editor. No React
    // private fields, document content or arbitrary object serialization.
    const pm = root?.editor?.state?.selection
    return {
      ready: !!root, editable: root?.getAttribute('contenteditable') === 'true',
      documentReady: ['loading','interactive','complete'].includes(document.readyState) ? document.readyState : 'other',
      focused: !!root && (document.activeElement === root || root.contains(document.activeElement)),
      selection: selection ? {ranges: integer(selection.rangeCount), collapsed: selection.isCollapsed,
        anchor: position(selection.anchorNode, selection.anchorOffset, root), focus: position(selection.focusNode, selection.focusOffset, root)} : null,
      pm: pm ? {from: integer(pm.from), to: integer(pm.to), anchor: integer(pm.anchor), head: integer(pm.head)} : null,
    }
  }
  const record = (kind, detail = {}) => {
    events.push({sequence: sequence++, kind, ...detail, ...snapshot()})
    if (events.length > limit) events.shift()
  }
  const inputTypes = new Set(['insertText','insertCompositionText','insertFromComposition','insertParagraph','insertLineBreak','insertFromPaste','insertFromDrop','deleteContentBackward','deleteContentForward','deleteWordBackward','deleteWordForward','historyUndo','historyRedo'])
  const keydown = event => record('keydown', {keyCategory:
    ['Home','End','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','PageUp','PageDown'].includes(event.key) ? 'navigation' :
    ['Backspace','Delete','Enter','Tab','Escape'].includes(event.key) ? 'editing' :
    ['Control','Meta','Alt','Shift'].includes(event.key) ? 'modifier' : event.ctrlKey || event.metaKey || event.altKey ? 'shortcut' : event.key?.length === 1 ? 'printable' : 'other',
    control: !!event.ctrlKey, meta: !!event.metaKey, shift: !!event.shiftKey, alt: !!event.altKey})
  const input = event => record(event.type === 'beforeinput' ? 'beforeinput' : 'input', {
    inputType: inputTypes.has(event.inputType) ? event.inputType : 'other', dataLength: typeof event.data === 'string' ? integer(event.data.length) : null, composing: !!event.isComposing})
  const selection = () => record('selectionchange')
  const settled = () => record('phased-settled')
  const state = () => {
    const root = editor(), next = JSON.stringify([!!root, root?.getAttribute('contenteditable') === 'true', document.readyState])
    if (next !== lastState) {lastState = next; record('state')}
  }
  const listeners = [['keydown',keydown],['beforeinput',input],['input',input],['selectionchange',selection],['genoffice:phased-content-settled',settled],['readystatechange',state]]
  for (const [name, listener] of listeners) document.addEventListener(name, listener, true)
  const observer = new MutationObserver(state)
  observer.observe(document, {subtree:true, childList:true, attributes:true, attributeFilter:['contenteditable']})
  state()
  window.__dyofficeInputDiagnostics = {stop() {
    observer.disconnect()
    for (const [name, listener] of listeners) document.removeEventListener(name, listener, true)
    return {limit, total: sequence, events: events.slice()}
  }}
}

export async function withInputDiagnostics(page, action, emit = value => console.error(value)) {
  await page.addInitScript(installInputDiagnostics)
  let failed = false
  try { return await action() }
  catch (error) { failed = true; throw error }
  finally {
    let result
    try { result = await page.evaluate(() => {
      const diagnostics = window.__dyofficeInputDiagnostics
      delete window.__dyofficeInputDiagnostics
      return diagnostics?.stop()
    }) } catch { /* The page may already be gone. Never log the error. */ }
    if (failed) emit(JSON.stringify({inputDiagnostics: result ?? {unavailable:true}}))
  }
}
