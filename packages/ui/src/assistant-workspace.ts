import { createElement, Fragment, useSyncExternalStore, type ReactNode } from 'react'

import type { MarkdownNav } from './Markdown'

/** Host-owned routing; switching views never replaces the editor's chat loop. */
export interface AssistantWorkspace {
  fileHistory?: {
    subscribe(listener: () => void): () => void
    hasMessages(): boolean
    reset(): void
  }
  panel: ReactNode
  conversation?(children: ReactNode, navs?: readonly MarkdownNav[]): ReactNode
  isOffice(): boolean
  submit(instruction: string, hasExtras: boolean): Promise<'office' | 'sent' | 'failed'>
}

const noHistory = () => false
const noSubscription = () => () => {}

export function useAssistantFileHistory(workspace?: AssistantWorkspace): boolean {
  const history = workspace?.fileHistory
  return useSyncExternalStore(history?.subscribe ?? noSubscription, history?.hasMessages ?? noHistory, noHistory)
}

export function AssistantConversation({
  workspace,
  children,
  navs,
}: {
  workspace?: AssistantWorkspace | undefined
  children: ReactNode
  navs?: readonly MarkdownNav[]
}) {
  return createElement(
    Fragment,
    null,
    workspace?.conversation ? workspace.conversation(children, navs) : children,
  )
}
