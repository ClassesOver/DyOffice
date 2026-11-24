/** Keep full-deck reads below the Web bridge queue limit. */
export async function loadShowData<T>(
  count: number,
  read: (index: number) => Promise<T>,
  isCurrent: () => boolean,
): Promise<T[]> {
  const result: T[] = []
  for (let start = 0; start < count && isCurrent(); start += 8) {
    const batch = Array.from({ length: Math.min(8, count - start) }, (_, offset) => read(start + offset))
    result.push(...await Promise.all(batch))
  }
  return result
}
