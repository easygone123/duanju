export function buildFirstLastFramePrompt(
  firstPrompt?: string | null,
  lastPrompt?: string | null,
): string {
  const first = firstPrompt?.trim() || ''
  const last = lastPrompt?.trim() || ''

  if (first && last) return `${first}\n\n然后自然过渡到：${last}`
  return first || last
}
