import { createHttpEditorHost } from '../../../../packages/browser-host/src/http-editor.ts'
import { mountDocsEditor, type DocsEditorHandle } from '../../../../packages/browser-host/src/files.ts'

/** Browser entry for one DOCX file. The desktop Docs ribbon is not mounted here. */
export async function mountWebDocs(element: HTMLElement, fileId: string): Promise<DocsEditorHandle> {
  return mountDocsEditor(createHttpEditorHost(), element, fileId)
}
