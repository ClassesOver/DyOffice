/** Derive a safe file stem from the first line of inserted text. */
export function sanitizeAutoRenameBase(raw: string): string | null {
  const cleaned = raw.replace(/[\\/:*?"<>|\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').trim()
  if (!cleaned) return null
  const safe = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned) ? cleaned + '_' : cleaned
  return Array.from(safe).slice(0, 40).join('').trim()
}
