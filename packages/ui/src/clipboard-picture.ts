/** A browser can provide a copied website picture as an image-only HTML fragment. */
export function websitePictureSource(html: string): string | null {
  if (typeof document === 'undefined' || !/<img\b/i.test(html)) return null
  const fragment = document.createElement('template')
  fragment.innerHTML = html
  const images = fragment.content.querySelectorAll('img')
  if (images.length !== 1 || fragment.content.textContent?.trim() || fragment.content.querySelector('table')) return null
  const source = images[0]?.getAttribute('src')?.trim()
  return source && /^https?:\/\//i.test(source) ? source : null
}
