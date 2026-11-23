import { createElement, Fragment, type ReactNode } from 'react'

/** Host-owned routing; switching views never replaces the editor's chat loop. */
export interface AssistantWorkspace {
  panel: ReactNode
  conversation?(children: ReactNode): ReactNode
  isOffice(): boolean
  submit(instruction: string, hasExtras: boolean): Promise<'office' | 'sent' | 'failed'>
}

export function AssistantConversation({
  workspace,
  children,
}: {
  workspace?: AssistantWorkspace | undefined
  children: ReactNode
}) {
  return createElement(
    Fragment,
    null,
    workspace?.conversation ? workspace.conversation(children) : children,
  )
}
