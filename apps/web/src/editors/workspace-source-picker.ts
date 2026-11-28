import type { SettingsRequest } from '../../../../packages/browser-host/src/preferences'
import { isRevisionRef, type OpenFileResult } from '../../../../packages/web-contracts/src/api'
import type { WorkspaceFileList, WorkspaceFolderList } from '../../../../packages/web-contracts/src/workspace'
import { folderChoices } from '../workspace-folder-options'
import { pickLocalFiles } from './pick-local-files'
import './web-ai-naming.css'

const formatLabels = { xlsx: 'Excel (.xlsx)', csv: 'CSV (.csv)', docx: 'Word (.docx)', pdf: 'PDF (.pdf)' }
type SourceFormat = keyof typeof formatLabels
type Choice = 'local' | { id: string; format: SourceFormat }
const PAGE_SIZE = 50
export type WorkspaceSourceAccess = {
  request: SettingsRequest
  verify(): Promise<boolean>
  readBytes(id: string, revision: string): Promise<Uint8Array>
}
type PickerOptions = {
  title: string
  formats: readonly SourceFormat[]
  language: string
  maxBytes: number
  localAccept?: string
  allowLocal?: boolean
}

function selectSource(request: SettingsRequest, { title: heading, formats, language, allowLocal = true }: PickerOptions, signal: AbortSignal): Promise<Choice | null> {
  signal.throwIfAborted()
  const en = language === 'en'
  const dialog = document.createElement('dialog')
  dialog.className = 'web-ai-naming-dialog'
  const title = document.createElement('h2')
  title.textContent = heading
  dialog.setAttribute('aria-label', title.textContent)
  const form = document.createElement('form')
  const search = document.createElement('input')
  search.type = 'search'
  search.maxLength = 200
  const format = document.createElement('select')
  for (const value of formats) format.add(new Option(formatLabels[value], value))
  const files = document.createElement('select')
  files.size = 6
  const status = document.createElement('p')
  status.setAttribute('role', 'status')
  const button = (label: string, action?: () => void) => {
    const element = document.createElement('button')
    element.type = action ? 'button' : 'submit'
    element.textContent = label
    if (action) element.onclick = action
    return element
  }
  const field = (label: string, control: HTMLElement) => {
    const element = document.createElement('label')
    element.className = 'web-ai-naming-field'
    element.append(label, control)
    return element
  }
  const lifetime = new AbortController()
  let page = 0, pending: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined
  const back = button(en ? 'Previous page' : '上一页', () => { page--; load() })
  const next = button(en ? 'Next page' : '下一页', () => { page++; load() })
  const use = button(en ? 'Use selected file' : '使用所选文件')
  const folders = request<WorkspaceFolderList>('/api/v1/workspace/folders', 'GET', undefined, lifetime.signal)
    .then(result => new Map(folderChoices(result.folders).map(folder => [folder.id, folder.name])))
    .catch(() => new Map<string, string>())
  function reset() {
    pending?.abort()
    files.replaceChildren()
    files.disabled = back.disabled = next.disabled = use.disabled = true
    status.textContent = en ? 'Loading workspace files…' : '正在读取工作区文件…'
  }
  function load() {
    clearTimeout(timer)
    reset()
    const controller = pending = new AbortController()
    const query = new URLSearchParams({ ext: format.value, q: search.value.trim(), limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) })
    void Promise.all([folders, request<WorkspaceFileList>('/api/v1/workspace/files?' + query, 'GET', undefined, controller.signal)])
      .then(([paths, result]) => {
        if (controller.signal.aborted) return
        for (const file of result.files) {
          if (file.format !== format.value) continue
          const folder = file.folderId && paths.get(file.folderId)
          files.add(new Option(folder ? folder + ' / ' + file.name : file.name, file.id))
        }
        files.selectedIndex = -1
        files.disabled = !files.length
        back.disabled = page === 0
        next.disabled = (page + 1) * PAGE_SIZE >= result.total
        status.textContent = files.length ? '' : en ? 'No matching files.' : '没有匹配的文件。'
      }).catch(() => {
        if (!controller.signal.aborted) status.textContent = en ? 'Could not load workspace files.' : '无法读取工作区文件。'
      })
  }
  search.oninput = () => {
    clearTimeout(timer)
    reset()
    page = 0
    timer = setTimeout(load, 200)
  }
  format.onchange = () => { page = 0; load() }
  files.onchange = () => { use.disabled = !files.value }
  const navigation = document.createElement('div')
  navigation.className = 'web-ai-naming-actions'
  navigation.append(back, next)
  const actions = document.createElement('div')
  actions.className = 'web-ai-naming-actions'
  form.append(title, field(en ? 'Search files' : '搜索文件', search))
  if (formats.length > 1) form.append(field(en ? 'File type' : '文件类型', format))
  form.append(field(en ? 'Workspace files' : '工作区文件', files), status, navigation, actions)
  dialog.append(form)
  return new Promise((resolve, reject) => {
    const finish = (choice: Choice | null) => {
      clearTimeout(timer)
      pending?.abort()
      lifetime.abort()
      signal.removeEventListener('abort', cancel)
      dialog.close()
      dialog.remove()
      resolve(choice)
    }
    const cancel = () => finish(null)
    if (allowLocal) actions.append(button(en ? 'Choose local file…' : '选择本机文件…', () => finish('local')))
    actions.append(button(en ? 'Cancel' : '取消', cancel), use)
    form.onsubmit = event => {
      event.preventDefault()
      if (files.value && !use.disabled) finish({ id: files.value, format: format.value as SourceFormat })
    }
    dialog.addEventListener('keydown', event => event.stopPropagation())
    dialog.oncancel = event => { event.preventDefault(); cancel() }
    document.body.append(dialog)
    try { dialog.showModal() }
    catch (error) { lifetime.abort(); dialog.remove(); reject(error); return }
    signal.addEventListener('abort', cancel, { once: true })
    search.focus()
    load()
  })
}

export async function pickWorkspaceSourceFile(
  access: WorkspaceSourceAccess, options: PickerOptions, signal: AbortSignal,
): Promise<File | null> {
  const en = options.language === 'en'
  const check = async () => {
    signal.throwIfAborted()
    if (!await access.verify()) throw new Error(en ? 'The workspace session changed.' : '工作区会话已变更。')
    signal.throwIfAborted()
  }
  const choice = await selectSource(access.request, options, signal)
  if (!choice) return null
  if (choice === 'local') {
    const accept = options.localAccept ?? options.formats.map(format => '.' + format).join(',')
    return (await pickLocalFiles(accept, signal))[0] ?? null
  }
  await check()
  const source = await access.request<OpenFileResult>('/api/v1/files/' + encodeURIComponent(choice.id), 'GET', undefined, signal)
  if (source.format !== choice.format || !isRevisionRef(source.file) || source.file.fileId !== choice.id || !source.name) {
    throw new Error(en ? 'The selected file is unavailable.' : '所选文件不可用。')
  }
  if (source.workbookPasswordProtected || source.documentPasswordProtected) {
    throw new Error(en ? 'Choose a file without an open password.' : '请选择未设置打开密码的文件。')
  }
  if (!source.file.size || source.file.size > options.maxBytes) {
    const limit = options.maxBytes / (1024 * 1024)
    throw new Error(en ? `Choose a nonempty file up to ${limit} MiB.` : `请选择不超过 ${limit} MiB 的非空文件。`)
  }
  const bytes = await access.readBytes(choice.id, source.file.revision)
  await check()
  return new File([new Uint8Array(bytes)], source.name)
}
