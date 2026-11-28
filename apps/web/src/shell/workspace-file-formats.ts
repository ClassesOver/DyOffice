export const workspaceFileAccept = '.docx,.xlsx,.pptx,.pdf'

export function isWorkspaceFileName(name: string): boolean {
  return /\.(docx|xlsx|pptx|pdf)$/i.test(name)
}
