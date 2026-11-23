export async function completeAiRunSave({
  applies,
  mutated,
  hasPendingEdits,
  autoSave,
  save,
  onUnsaved,
}: {
  applies: readonly Promise<boolean>[]
  mutated: boolean
  hasPendingEdits(): boolean
  autoSave: boolean
  save(): Promise<unknown>
  onUnsaved(): void
}): Promise<boolean> {
  const results = await Promise.all(applies)
  if (!mutated && (applies.length === 0 || !results.some(Boolean))) return false
  if (!hasPendingEdits()) return false
  if (!autoSave) {
    onUnsaved()
    return false
  }
  await save()
  return true
}
