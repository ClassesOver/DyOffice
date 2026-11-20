/** Optional document-bound collaboration control; native chat never depends on it. */
export interface AssistantControl {
  resetConversation?(): void
  beginRun?(instruction: string, continuationToken?: string): string | undefined
  endRun?(token: string, result: {text: string; cancelled: boolean; failed?: boolean; yielded?: {taskIds: string[]}}): void
  readonly allowedTools: readonly string[]
  register(executor: {
    execute(instruction: string, signal: AbortSignal): Promise<{ text: string; cancelled: boolean; truncated?: boolean; turnLimit?: boolean }>
    isBusy(): boolean
    cancelRun?(token: string): void
    requestYield(taskIds: readonly string[]): void
    continue(instruction: string, continuationToken?: string): boolean
  }): () => void
  reportYield(taskIds: readonly string[]): void
}
