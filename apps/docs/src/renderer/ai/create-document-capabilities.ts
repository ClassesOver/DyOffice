import type { AgentToolDef } from '@genoffice/agent-core'
import type { CreateDocumentType } from '../../shared/ipc'

type ToolSchema = {
  properties?: Record<string, unknown>
  [key: string]: unknown
}

export function toolsForCreateDocumentTypes(
  tools: AgentToolDef[],
  supported?: readonly CreateDocumentType[],
): AgentToolDef[] {
  if (supported === undefined) return tools
  if (supported.length === 0) return tools.filter(tool => tool.name !== 'create_document')

  return tools.map(tool => {
    if (tool.name !== 'create_document') return tool
    const schema = tool.inputSchema as ToolSchema
    const properties = schema.properties ?? {}
    const typeSchema = properties.type && typeof properties.type === 'object'
      ? properties.type as Record<string, unknown>
      : {}
    const filteredTool = { ...tool }
    filteredTool.description = `Create a new standalone file and open it in a new tab. Supported types on this host: ${supported.join(', ')}.`
    filteredTool.inputSchema = {
      ...schema,
      properties: {
        ...properties,
        type: { ...typeSchema, enum: [...supported] },
      },
    }
    return filteredTool
  })
}
