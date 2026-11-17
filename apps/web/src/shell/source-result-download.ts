/** Called only after the session-bound request completes and the view is still mounted. */
export function offerSourceResultDownload(json: string, resultId: string) {
  const url = URL.createObjectURL(new Blob([json], {type: 'application/json'}))
  try {
    const link = document.createElement('a')
    link.href = url; link.download = resultId + '.json'; link.click()
  } finally { setTimeout(() => URL.revokeObjectURL(url), 0) }
}
