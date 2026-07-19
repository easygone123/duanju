export const PANEL_NARRATION_MODES = ['auto', 'on', 'off'] as const

export type PanelNarrationMode = (typeof PANEL_NARRATION_MODES)[number]

export function parseNarrationMode(value: unknown): PanelNarrationMode {
  if (
    typeof value !== 'string'
    || !PANEL_NARRATION_MODES.includes(value as PanelNarrationMode)
  ) {
    throw new Error('PANEL_NARRATION_MODE_INVALID')
  }
  return value as PanelNarrationMode
}

export function resolveNarrationEnabled(input: {
  mode: PanelNarrationMode
  recommended: boolean
}) {
  if (input.mode === 'on') return true
  if (input.mode === 'off') return false
  return input.recommended
}

export function validateManualNarration(input: {
  mode: PanelNarrationMode
  text: string | null
}) {
  if (input.mode === 'on' && !input.text?.trim()) {
    throw new Error('PANEL_NARRATION_TEXT_REQUIRED')
  }
}

export function resolveNarrationContent(input: {
  mode: PanelNarrationMode
  suggestedText: string | null
  suggestedEmotion: string | null
  manualText: string | null
  manualEmotion: string | null
}) {
  return input.mode === 'auto'
    ? { text: input.suggestedText, emotion: input.suggestedEmotion }
    : { text: input.manualText, emotion: input.manualEmotion }
}
