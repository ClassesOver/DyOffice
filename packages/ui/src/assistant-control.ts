/** Optional document-bound collaboration control; native chat never depends on it. */
export interface AssistantControl {
  resetConversation?(): void
  readonly allowedTools: readonly string[]
  register(executor: {
    execute(instruction: string, signal: AbortSignal): Promise<{ text: string; cancelled: boolean }>
    isBusy(): boolean
    requestYield(taskIds: readonly string[]): void
    continue(instruction: string): boolean
  }): () => void
  reportYield(taskIds: readonly string[]): void
}
