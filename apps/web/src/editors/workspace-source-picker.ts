import type { SettingsRequest } from '../../../../packages/browser-host/src/preferences'
import { isRevisionRef, type OpenFileResult, type WorkspaceFileFormat } from '../../../../packages/web-contracts/src/api'
import type { WorkspaceFileList, WorkspaceFolderList } from '../../../../packages/web-contracts/src/workspace'
import { folderChoices } from '../workspace-folder-options'
import { pickLocalFiles } from './pick-local-files'
import './web-ai-naming.css'

const formatLabels = { xlsx: 'Excel (.xlsx)', xlsm: 'Excel (.xlsm)', csv: 'CSV (.csv)', docx: 'Word (.docx)', pptx: 'PowerPoint (.pptx)', pdf: 'PDF (.pdf)' } satisfies Record<WorkspaceFileFormat,string>
type WorkspaceChoice = { id: string; format: WorkspaceFileFormat }
type Choice = 'local' | WorkspaceChoice[]
const PAGE_SIZE = 50
export type WorkspaceSourceAccess = {
  request: SettingsRequest
  verify(): Promise<boolean>
  readBytes(id: string, revision: string): Promise<Uint8Array>
}
type PickerOptions = {
  title: string
  formats: readonly WorkspaceFileFormat[]
  language: string
  maxBytes: number
  maxTotalBytes?: number
  localAccept?: string
  allowLocal?: boolean
  readAsAttachment?: boolean
  excludeFileId?: string
}
type SourceListOptions = Pick<PickerOptions, 'title' | 'formats' | 'language' | 'allowLocal' | 'excludeFileId'>

function selectSource(request: SettingsRequest, { title: heading, formats, language, allowLocal = true, excludeFileId }: SourceListOptions, signal: AbortSignal, maxFiles: number): Promise<Choice | null> {
  signal.throwIfAborted()
  const en = language === 'en'
  const multiple = maxFiles > 1
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
  const use = button(en ? (multiple ? 'Use selected files' : 'Use selected file') : '使用所选文件')
  const selected = new Map<string, WorkspaceChoice>()
  const order = document.createElement('ol')
  const orderLabel = en ? 'Merge order' : '合并顺序'
  order.className = 'workspace-source-order'
  order.setAttribute('aria-label', orderLabel)
  const localLabel = en ? (multiple ? 'Choose local files…' : 'Choose local file…') : '选择本机文件…'
  let chooseLocal: HTMLButtonElement | undefined
  const add = button(en ? 'Add selected file' : '添加所选文件', () => {
    const option = files.selectedOptions[0]
    if (!option || add.disabled) return
    const id = option.value
    selected.set(id, {id, format: format.value as WorkspaceFileFormat})
    const item = document.createElement('li')
    const name = document.createElement('span')
    name.textContent = option.textContent
    const remove = button(en ? 'Remove' : '移除', () => {
      selected.delete(id)
      item.remove()
      updateButtons()
      const focusTarget = files.disabled ? search : files
      focusTarget.focus()
    })
    remove.setAttribute('aria-label', en ? 'Remove ' + name.textContent : '移除 ' + name.textContent)
    item.append(name, remove)
    order.append(item)
    updateButtons()
    files.focus()
  })
  function updateButtons() {
    add.disabled = !files.value || selected.has(files.value) || selected.size >= maxFiles
    use.disabled = multiple ? !selected.size : !files.value
    if (chooseLocal) chooseLocal.disabled = !!selected.size
  }
  const folders = request<WorkspaceFolderList>('/api/v1/workspace/folders', 'GET', undefined, lifetime.signal)
    .then(result => new Map(folderChoices(result.folders).map(folder => [folder.id, folder.name])))
    .catch(() => new Map<string, string>())
  function reset() {
    pending?.abort()
    files.replaceChildren()
    files.disabled = back.disabled = next.disabled = true
    updateButtons()
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
          if (file.format !== format.value || file.id === excludeFileId) continue
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
  files.onchange = updateButtons
  const navigation = document.createElement('div')
  navigation.className = 'web-ai-naming-actions'
  navigation.append(back, next)
  const actions = document.createElement('div')
  actions.className = 'web-ai-naming-actions'
  form.append(title, field(en ? 'Search files' : '搜索文件', search))
  if (formats.length > 1) form.append(field(en ? 'File type' : '文件类型', format))
  if (multiple) navigation.append(add)
  form.append(field(en ? 'Workspace files' : '工作区文件', files), status, navigation)
  if (multiple) {
    const selection = document.createElement('div')
    selection.className = 'web-ai-naming-field'
    selection.append(orderLabel, order)
    form.append(selection)
  }
  form.append(actions)
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
    if (allowLocal) {
      chooseLocal = button(localLabel, () => finish('local'))
      actions.append(chooseLocal)
    }
    actions.append(button(en ? 'Cancel' : '取消', cancel), use)
    form.onsubmit = event => {
      event.preventDefault()
      if (use.disabled) return
      finish(multiple ? [...selected.values()] : [{id: files.value, format: format.value as WorkspaceFileFormat}])
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

async function readSourceMetadata(request: SettingsRequest, {id, format}: WorkspaceChoice, en: boolean, signal: AbortSignal) {
  const source = await request<OpenFileResult>('/api/v1/files/' + encodeURIComponent(id), 'GET', undefined, signal)
  if (source.format !== format || !isRevisionRef(source.file) || source.file.fileId !== id || !source.name) {
    throw new Error(en ? 'The selected file is unavailable.' : '所选文件不可用。')
  }
  return {...source, name: source.name}
}

export async function pickWorkspaceSourceRevision(
  access: Pick<WorkspaceSourceAccess, 'request' | 'verify'>, options: Omit<SourceListOptions, 'allowLocal'>, signal: AbortSignal,
) {
  const choice = await selectSource(access.request, {...options, allowLocal: false}, signal, 1)
  if (!choice || choice === 'local') return null
  const en = options.language === 'en'
  const source = await readSourceMetadata(access.request, choice[0]!, en, signal)
  if (!await access.verify()) throw new Error(en ? 'The workspace session changed.' : '工作区会话已变更。')
  signal.throwIfAborted()
  return source.file
}

export async function pickWorkspaceSourceFile(
  access: WorkspaceSourceAccess, options: PickerOptions, signal: AbortSignal,
): Promise<File | null> {
  const [file] = await pickWorkspaceSourceFiles(access, options, signal)
  return file ?? null
}

export async function pickWorkspaceSourceFiles(
  access: WorkspaceSourceAccess,
  options: PickerOptions & {maxFiles?: number},
  signal: AbortSignal,
): Promise<File[]> {
  const en = options.language === 'en'
  const maxFiles = options.maxFiles ?? 1
  const check = async () => {
    signal.throwIfAborted()
    if (!await access.verify()) throw new Error(en ? 'The workspace session changed.' : '工作区会话已变更。')
    signal.throwIfAborted()
  }
  const choice = await selectSource(access.request, options, signal, maxFiles)
  if (!choice) return []
  if (choice === 'local') {
    const accept = options.localAccept ?? options.formats.map(format => '.' + format).join(',')
    return pickLocalFiles(accept, signal, maxFiles > 1)
  }
  await check()
  const sources: {file: OpenFileResult['file']; name: string}[] = []
  let total = 0
  for (const selectedFile of choice) {
    const source = await readSourceMetadata(access.request, selectedFile, en, signal)
    if (!options.readAsAttachment && (source.workbookPasswordProtected || source.documentPasswordProtected)) {
      throw new Error(en ? 'Choose a file without an open password.' : '请选择未设置打开密码的文件。')
    }
    if (source.file.size > options.maxBytes || (!options.readAsAttachment && !source.file.size)) {
      const limit = options.maxBytes / (1024 * 1024)
      if (options.readAsAttachment) throw new Error(en ? `Choose an attachment up to ${limit} MiB.` : `请选择不超过 ${limit} MiB 的附件。`)
      throw new Error(en ? `Choose a nonempty file up to ${limit} MiB.` : `请选择不超过 ${limit} MiB 的非空文件。`)
    }
    total += source.file.size
    if (options.maxTotalBytes !== undefined && total > options.maxTotalBytes) {
      throw new Error(en ? 'The selected files exceed the combined size limit.' : '所选文件超过合计大小上限。')
    }
    sources.push({file: source.file, name: source.name})
  }
  const files: File[] = []
  for (const {file, name} of sources) {
    signal.throwIfAborted()
    const bytes = await access.readBytes(file.fileId, file.revision)
    await check()
    files.push(new File([new Uint8Array(bytes)], name))
  }
  return files
}
