export function browserFileName(value: string, fallback: string): string {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').slice(0, 180).replace(/^[.\s]+|[.\s]+$/g, '') || fallback
}

export function downloadBrowserFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.hidden = true
  document.body.append(link)
  try { link.click() }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0) }
}

export function decodeBrowserBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}
