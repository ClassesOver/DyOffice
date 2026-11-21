import { useSyncExternalStore, type ReactNode } from 'react'
import type { AiChatMessage } from './AiChatPanel'

type ChatUpdate = readonly AiChatMessage[] | ((previous: readonly AiChatMessage[]) => readonly AiChatMessage[])

/** Chat messages outside React state: a streamed token re-renders only the chat panel,
 * not the whole workbook App and ExcelShell (ribbon, grid chrome, dialogs). */
export interface ChatStore {
  get(): readonly AiChatMessage[]
  /** Same contract as a useState setter (value or updater). */
  set(update: ChatUpdate): void
  subscribe(listener: () => void): () => void
}

export function createChatStore(): ChatStore {
  let chat: readonly AiChatMessage[] = []
  const listeners = new Set<() => void>()
  return {
    get: () => chat,
    set(update) {
      const next = typeof update === 'function' ? update(chat) : update
      if (Object.is(next, chat)) return
      chat = next
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** Renders `children` with the store's current messages, subscribing only this subtree. */
export function ChatFromStore({
  store,
  children,
}: {
  store: ChatStore
  children: (chat: readonly AiChatMessage[]) => ReactNode
}): ReactNode {
  return children(useSyncExternalStore(store.subscribe, store.get))
}
