/** Start from the show command's user gesture and settle from the show's lifecycle. */
export function createBrowserSlideFullscreen(document: Document) {
  let pending: Promise<void> | undefined
  let wanted = false
  const exit = async () => {
    if (wanted || document.fullscreenElement !== document.documentElement) return
    await document.exitFullscreen?.().catch(() => {})
  }
  return {
    requestShowFullScreen() {
      wanted = true
      const root = document.documentElement
      if (pending || document.fullscreenElement || document.fullscreenEnabled === false || !root.requestFullscreen) return
      try {
        pending = root.requestFullscreen().catch(() => {}).finally(() => { pending = undefined })
      } catch { /* Keep the in-frame presentation available. */ }
    },
    setShowFullScreen(on: boolean): Promise<void> {
      if (on) return pending ?? Promise.resolve()
      wanted = false
      return pending ? pending.then(exit) : exit()
    },
  }
}
