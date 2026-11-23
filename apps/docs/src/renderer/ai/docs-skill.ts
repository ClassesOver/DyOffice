import { placeholderInstruction } from './redact'
import { redactLabelsOf } from './redact-view'
import type { Editor } from '@tiptap/core'
import type { CreateDocumentType } from '../../shared/ipc'
import type { AgentImage, AgentSkill } from '@genoffice/agent-core'
import {
  AGENT_SYSTEM_PROMPT,
  buildDocContext,
  buildDocumentContext,
  getSelectionScope,
  type AiTrack,
  type NumIds,
} from './protocol'
import type { AiDocWriter } from './doc-writer'
import type { AiPageSetupAccess } from './page-setup'
import {
  AGENT_TOOLS,
  DOCS_MUTATION_TOOLS,
  docsToolCanWrite,
  executeTool,
  markDocSeen,
  type AiCommentsAccess,
  type AiHeaderFooterAccess,
  type FrozenSelection,
  type AiDocExtras,
} from './tools'
import type { AiNotesAccess } from './note-ops'
import { toolsForCreateDocumentTypes } from './create-document-capabilities'

const IMAGE_GEN_OFF_NOTE =
  '\n\nNote: generate_image is currently unavailable (no image provider: signed out of Genspark or cloud tools off, and no media API key in Settings). Do not call or promise it; use image_search for imagery.'

const MEDIA_ANALYSIS_OFF_NOTE =
  '\n\nNote: analyze_media is currently unavailable (no media provider: signed out of Genspark or cloud tools off, and no media API key in Settings). You cannot see what a picture inside the document shows — tell the user that instead of guessing at its content.'

export type RunAttachmentImages = Map<number, { name: string; image: AgentImage }>

/**
 * The docx capability as an AgentSkill: document skeleton context, the five
 * document tools, and the local executor. Future apps register their own
 * skills (Excel / PPT) against the same agent loop.
 */
export function createDocsSkill(
  getEditor: () => Editor,
  getNumIds: () => NumIds,
  getTrack?: () => AiTrack | undefined,
  getComments?: () => AiCommentsAccess | undefined,
  getHf?: () => AiHeaderFooterAccess | undefined,
  /** live predicate (gsk login && cloud-tools toggle, or a BYOK media key); false hides generate_image */
  imageGenAvailable?: () => boolean,
  /** streaming long-form writer behind write_document (panel-owned: progress chip, partial keep/discard) */
  getWriter?: () => AiDocWriter | undefined,
  getPageSetup?: () => AiPageSetupAccess | undefined,
  /** styles.xml catalog + page watermark stores (define_style / applyStyle / set_watermark) */
  getExtras?: () => AiDocExtras | undefined,
  getNotes?: () => AiNotesAccess | undefined,
  /** same as imageGenAvailable, for analyze_media (seeing pictures that are in the document) */
  mediaAnalysisAvailable?: () => boolean,
  /** Successfully loaded images from the foreground Web send, keyed by its original attachment index. */
  getRunImages?: () => RunAttachmentImages,
  getSupportedCreateDocumentTypes?: () => readonly CreateDocumentType[],
): AgentSkill {
  // Selection frozen per run: tools act on the range the prompt described,
  // not on wherever the user's live selection has wandered mid-run. The doc
  // snapshot bounds the freeze's validity (see FrozenSelection).
  let frozen: FrozenSelection | null = null
  /** tools that need a media provider: Genspark login + cloud tools, or a BYOK media key in Settings */
  const mediaToolsOff = (): Set<string> => {
    const hidden = new Set<string>()
    if (imageGenAvailable?.() === false) hidden.add('generate_image')
    if (mediaAnalysisAvailable?.() === false) hidden.add('analyze_media')
    return hidden
  }
  const mediaOffNote = (): string =>
    [...mediaToolsOff()]
      .map((name) => (name === 'generate_image' ? IMAGE_GEN_OFF_NOTE : MEDIA_ANALYSIS_OFF_NOTE))
      .join('')
  return {
    id: 'docx',
    // live: the predicate is re-read before every model request
    get systemPrompt() {
      // only when the open document actually withholds something, so a
      // document without spans pays nothing and the model is not told to
      // look for markers that are not there
      const editor = getEditor()
      const labels = editor
        ? redactLabelsOf(editor.getJSON() as unknown as Parameters<typeof redactLabelsOf>[0])
        : []
      const redact = labels.length > 0 ? `\n\n${placeholderInstruction(labels)}` : ''
      return AGENT_SYSTEM_PROMPT + mediaOffNote() + redact
    },
    get tools() {
      const hidden = mediaToolsOff()
      for(const name of DOCS_MUTATION_TOOLS) if(!docsToolCanWrite(getEditor(),name,getComments?.())) hidden.add(name)
      return toolsForCreateDocumentTypes(AGENT_TOOLS, getSupportedCreateDocumentTypes?.())
        .filter((t) => !hidden.has(t.name))
        .map((tool) => {
          if (tool.name !== 'analyze_media' || !getRunImages) return tool
          const attachmentTool = { ...tool }
          attachmentTool.description = 'Analyze a picture in the document, an image attached to the current message, or image/audio/video at an HTTP(S) URL.'
          attachmentTool.inputSchema = {
            ...tool.inputSchema,
            properties: {
              ...(tool.inputSchema.properties as Record<string, unknown>),
              mediaUrls: { type: 'array', items: { type: 'string' }, description: 'Media HTTP(S) URLs.' },
              attachmentIndex: { type: 'integer', minimum: 0, description: 'One of the current message image attachment indexes listed in the context.' },
            },
          }
          return attachmentTool
        })
    },
    buildContext: () => {
      const editor = getEditor()
      markDocSeen(editor) // the context the model receives is the freshness baseline for index-addressed writes
      frozen = { scope: getSelectionScope(editor), doc: editor.state.doc }
      const context = buildDocContext(
        editor,
        frozen.scope,
        getComments?.()?.list(),
        getHf?.()?.read(),
        getPageSetup?.()?.list(),
      )
      const indexes = getRunImages?.()
      const imageIndexes = indexes?.size
        ? [...indexes].map(([index, { name }]) => `${index} | ${JSON.stringify(name)}`).join('\n')
        : ''
      return imageIndexes ? `${context}\n\nCurrent message image attachments (analyze_media attachmentIndex | file name):\n${imageIndexes}` : context
    },
    executeScopedTool: (call, signal) => {
      if (call.name === 'get_document_context') return {
        output: buildDocumentContext(getEditor(), undefined, getHf?.()?.read(), false),
        summary: 'Document context',
        mutated: false,
      }
      return executeTool(
        getEditor(), call, getNumIds(), undefined, signal, null,
        getComments?.(), getHf?.(), undefined, getPageSetup?.(), getExtras?.(), getNotes?.(),
      )
    },
    executeTool: (call, signal) => {
      if (call.name === 'analyze_media' && call.input.attachmentIndex !== undefined) {
        const { attachmentIndex, mediaUrls, ...input } = call.input
        const image = typeof attachmentIndex === 'number' && Number.isInteger(attachmentIndex)
          ? getRunImages?.().get(attachmentIndex)?.image
          : undefined
        if (!image || signal?.aborted) return {
          output: 'The specified image attachment is not available in the current message.',
          summary: 'Analyze media',
          isError: true,
          mutated: false,
        }
        // The existing media gateway applies its existing per-item and aggregate limits.
        call = { ...call, input: { ...input, mediaUrls: [`data:${image.mime};base64,${image.base64}`, ...(Array.isArray(mediaUrls) ? mediaUrls : [])] } }
      }
      return executeTool(
        getEditor(),
        call,
        getNumIds(),
        getTrack?.(),
        signal,
        frozen,
        getComments?.(),
        getHf?.(),
        getWriter?.(),
        getPageSetup?.(),
        getExtras?.(),
        getNotes?.(),
      )
    },
  }
}
