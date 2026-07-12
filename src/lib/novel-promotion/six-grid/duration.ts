export const VIDEO_DURATION_INVALID = 'VIDEO_DURATION_INVALID'
export const VIDEO_DURATION_TOO_SHORT = 'VIDEO_DURATION_TOO_SHORT'

export const PANEL_DURATION_FORMULA = Object.freeze({
  minimumSeconds: 2,
  maximumSeconds: 15,
  charactersPerSecond: 4,
  actingMarginSeconds: 0.8,
  actionSecondsPerPoint: 0.65,
  cameraSecondsPerPoint: 0.45,
})

export type PanelDurationInput = {
  dialogueText?: string | null
  actionComplexity?: number
  cameraComplexity?: number
  durationOverride?: number | null
  charactersPerSecond?: number
  actingMarginSeconds?: number
}

export type PanelDuration = {
  estimatedDuration: number
  durationOverride: number | null
}

export function estimatePanelDuration(input: PanelDurationInput): PanelDuration {
  const actionComplexity = nonNegativeFinite(input.actionComplexity)
  const cameraComplexity = nonNegativeFinite(input.cameraComplexity)
  const charactersPerSecond = positiveFinite(
    input.charactersPerSecond ?? PANEL_DURATION_FORMULA.charactersPerSecond,
  )
  const actingMargin = nonNegativeFinite(
    input.actingMarginSeconds ?? PANEL_DURATION_FORMULA.actingMarginSeconds,
  )
  const durationOverride = input.durationOverride == null
    ? null
    : positiveFinite(input.durationOverride)

  const actionSeconds = PANEL_DURATION_FORMULA.minimumSeconds
    + actionComplexity * PANEL_DURATION_FORMULA.actionSecondsPerPoint
    + cameraComplexity * PANEL_DURATION_FORMULA.cameraSecondsPerPoint
  const dialogueLength = countReadableCharacters(input.dialogueText)
  const dialogueSeconds = dialogueLength > 0
    ? dialogueLength / charactersPerSecond + actingMargin
    : 0
  const estimatedDuration = clamp(roundToTenth(Math.max(actionSeconds, dialogueSeconds)))
  return { estimatedDuration, durationOverride }
}

export function resolveSupportedDuration(
  requested: number,
  supported: readonly number[],
): number {
  positiveFinite(requested)
  if (!Array.isArray(supported) || supported.length === 0) {
    throw new Error(VIDEO_DURATION_INVALID)
  }
  const normalized = [...new Set(supported.map((value) => positiveFinite(value)))]
    .sort((a, b) => a - b)
  const resolved = normalized.find((duration) => duration >= requested)
  if (resolved === undefined) throw new Error(VIDEO_DURATION_TOO_SHORT)
  return resolved
}

function countReadableCharacters(value: string | null | undefined): number {
  if (typeof value !== 'string') return 0
  return value.replace(/[\s\p{P}\p{S}]/gu, '').length
}

function positiveFinite(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(VIDEO_DURATION_INVALID)
  return value
}

function nonNegativeFinite(value: number | undefined): number {
  if (value === undefined) return 0
  if (!Number.isFinite(value) || value < 0) throw new Error(VIDEO_DURATION_INVALID)
  return value
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10
}

function clamp(value: number): number {
  return Math.max(
    PANEL_DURATION_FORMULA.minimumSeconds,
    Math.min(PANEL_DURATION_FORMULA.maximumSeconds, value),
  )
}
