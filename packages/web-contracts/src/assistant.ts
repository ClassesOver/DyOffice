/** T13 reads only; document mutation waits for the T14 approval boundary. */
export const ASSISTANT_READ_TOOLS = new Set([
  'get_document_context','read_blocks','read_revisions','read_comments','read_notes',
  'get_workbook_context','read_range','aggregate_range','load_guide','read_formats',
  'read_sheet_features','read_cells','find_cells','trace_precedents','trace_dependents',
])
export function assistantReadTools(sourceCatalog = false): ReadonlySet<string> {
  return new Set([...ASSISTANT_READ_TOOLS, ...(sourceCatalog ? ['sources_list'] : [])])
}
export interface AssistantModel {id: string; label: string; model: string}
export const ASSISTANT_DELEGATION_TOOLS = new Set(['list_agents', 'list_agent_data', 'delegate_agent_task','list_channel_agents','delegate_channel_task'])
export interface AssistantCatalog {
  entries: AssistantModel[]; defaultId: string | null
  agents?: {id: string; name: string; origin: 'builtin' | 'external'; capabilities: readonly string[]}[]
  defaultAgentId?: string
  sourceCatalog?:boolean
  assistantChannels?:boolean
}
