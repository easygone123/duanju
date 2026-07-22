export function buildFirstLastFramePrompt(
  firstPrompt?: string | null,
  lastPrompt?: string | null,
): string {
  const first = firstPrompt?.trim() || ''
  const last = lastPrompt?.trim() || ''

  if (first && last) return `${first}\n\n然后自然过渡到：${last}`
  return first || last
}

export function buildAdjacentPanelContinuityPrompt(
  currentPrompt?: string | null,
  nextPrompt?: string | null,
): string {
  const current = currentPrompt?.trim() || ''
  const next = nextPrompt?.trim() || ''
  if (!current || !next) return current || next

  return [
    current,
    '[CONTINUITY_HANDOFF] 本镜头结束时，人物位置、朝向、动作趋势、表情、服装、道具状态和场景空间关系必须自然衔接下一镜头的开场。不要提前完整演完下一镜头，只需形成可直接承接的结束状态。',
    `下一镜头开场参考：${next}`,
  ].join('\n\n')
}
