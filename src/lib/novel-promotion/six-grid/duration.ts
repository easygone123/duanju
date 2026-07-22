export const VIDEO_DURATION_INVALID = 'VIDEO_DURATION_INVALID'
export const VIDEO_DURATION_TOO_SHORT = 'VIDEO_DURATION_TOO_SHORT'

export const PANEL_DURATION_FORMULA = Object.freeze({
  minimumSeconds: 2.5,
  maximumSeconds: 15,
  cjkCharactersPerSecond: 3.3,
  latinWordsPerSecond: 2.5,
  actingMarginSeconds: 1,
  actionSecondsPerPoint: 0.65,
  inferredActionSecondsPerBeat: 0.55,
  cameraSecondsPerPoint: 0.45,
  commaPauseSeconds: 0.18,
  sentencePauseSeconds: 0.35,
})

export type PanelDurationInput = {
  dialogueText?: string | null
  narrationText?: string | null
  sourceText?: string | null
  description?: string | null
  videoPrompt?: string | null
  cameraMove?: string | null
  shotType?: string | null
  actionComplexity?: number
  cameraComplexity?: number
  plannerDuration?: number | null
  durationOverride?: number | null
  /** @deprecated Prefer language-aware defaults. Retained for callers that explicitly tune speech rate. */
  charactersPerSecond?: number
  actingMarginSeconds?: number
}

export type PanelDuration = {
  estimatedDuration: number
  durationOverride: number | null
}

type StoryboardPanelLike = Record<string, unknown>

/**
 * Resolves a storyboard duration from the analysis model output.
 *
 * A valid planner duration is authoritative: the code must not second-guess the
 * analysis model with a fixed formula. Semantic estimation exists only as a
 * fail-safe for legacy or malformed outputs that omitted duration entirely.
 */
export function estimatePanelDuration(input: PanelDurationInput): PanelDuration {
  const actionComplexity = nonNegativeFinite(input.actionComplexity)
  const cameraComplexity = nonNegativeFinite(input.cameraComplexity)
  const actingMargin = nonNegativeFinite(
    input.actingMarginSeconds ?? PANEL_DURATION_FORMULA.actingMarginSeconds,
  )
  const durationOverride = input.durationOverride == null
    ? null
    : positiveFinite(input.durationOverride)
  const plannerDuration = optionalPositiveFinite(input.plannerDuration)
  if (plannerDuration !== null) {
    return {
      estimatedDuration: plannerDuration,
      durationOverride,
    }
  }

  const visualText = pickRicherText(input.description, input.videoPrompt)
  const inferredActionBeats = inferActionBeats(visualText)
  const inferredCameraComplexity = inferCameraComplexity(input.cameraMove)
  const shotHoldSeconds = inferShotHoldSeconds(input.shotType)
  const actionSeconds = PANEL_DURATION_FORMULA.minimumSeconds
    + actionComplexity * PANEL_DURATION_FORMULA.actionSecondsPerPoint
    + inferredActionBeats * PANEL_DURATION_FORMULA.inferredActionSecondsPerBeat
    + (cameraComplexity + inferredCameraComplexity) * PANEL_DURATION_FORMULA.cameraSecondsPerPoint
    + shotHoldSeconds

  const explicitSpeech = joinText(input.dialogueText, input.narrationText)
  const speechText = explicitSpeech || extractSpeechFromSource(input.sourceText)
  const speechSeconds = estimateSpeechSeconds(speechText, input.charactersPerSecond)
  const performanceTail = speechSeconds > 0
    ? actingMargin + Math.min(1.2, inferredActionBeats * 0.25)
    : 0
  const deterministicFloor = Math.max(actionSeconds, speechSeconds + performanceTail)
  const estimatedDuration = clamp(roundToTenth(deterministicFloor))
  return { estimatedDuration, durationOverride }
}

/** Normalizes every storyboard persistence path through the same duration rules. */
export function estimateStoryboardPanelDuration(
  panel: StoryboardPanelLike,
  options: Pick<PanelDurationInput, 'dialogueText' | 'narrationText' | 'durationOverride'> = {},
): PanelDuration {
  const nestedDialogue = isRecord(panel.dialogue) ? panel.dialogue : null
  return estimatePanelDuration({
    dialogueText: options.dialogueText
      ?? readText(panel.dialogueText)
      ?? readText(panel.dialogue_text)
      ?? readText(nestedDialogue?.text)
      ?? readText(nestedDialogue?.line),
    narrationText: options.narrationText
      ?? readText(panel.narrationText)
      ?? readText(panel.narration_text),
    sourceText: readText(panel.source_text) ?? readText(panel.sourceText) ?? readText(panel.srtSegment),
    description: readText(panel.description) ?? readText(panel.action),
    videoPrompt: readText(panel.video_prompt) ?? readText(panel.videoPrompt),
    cameraMove: readText(panel.camera_move) ?? readText(panel.cameraMove),
    shotType: readText(panel.shot_type) ?? readText(panel.shotType),
    actionComplexity: readNonNegativeNumber(panel.actionComplexity),
    cameraComplexity: readNonNegativeNumber(panel.cameraComplexity),
    plannerDuration: readPositiveNumber(panel.duration)
      ?? readPositiveNumber(panel.estimatedDuration),
    durationOverride: options.durationOverride,
  })
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

function estimateSpeechSeconds(value: string, customCharactersPerSecond?: number): number {
  if (!value) return 0
  if (customCharactersPerSecond !== undefined) {
    return countReadableCharacters(value) / positiveFinite(customCharactersPerSecond)
  }
  const cjkCount = (value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length
  const latinWordCount = (value.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [])
    .filter((word) => !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(word))
    .length
  const commaPauses = (value.match(/[,，、;；:：]/g) || []).length
  const sentencePauses = (value.match(/[.!?。！？…]/g) || []).length
  return cjkCount / PANEL_DURATION_FORMULA.cjkCharactersPerSecond
    + latinWordCount / PANEL_DURATION_FORMULA.latinWordsPerSecond
    + commaPauses * PANEL_DURATION_FORMULA.commaPauseSeconds
    + sentencePauses * PANEL_DURATION_FORMULA.sentencePauseSeconds
}

function extractSpeechFromSource(value: string | null | undefined): string {
  if (typeof value !== 'string' || !value.trim()) return ''
  const quoted: string[] = []
  const quotePattern = /[「“"]([^」”"]+)[」”"]/gu
  for (const match of value.matchAll(quotePattern)) {
    if (match[1]?.trim()) quoted.push(match[1].trim())
  }
  if (quoted.length > 0) return quoted.join('。')
  const speakingMatch = value.match(/(?:说|说道|喊道|问道|回答|答道|低声说|旁白|画外音|voice\s*over|says?|asks?|repl(?:y|ies|ied))\s*[:：]\s*(.+)$/iu)
  return speakingMatch?.[1]?.trim() || ''
}

function inferActionBeats(value: string): number {
  if (!value) return 0
  const clauses = value
    .split(/[，,；;。.!！？\n]+/u)
    .map((part) => part.trim())
    .filter(Boolean)
  const actionPattern = /(走|跑|转身|起身|坐下|站起|拿起|放下|抬手|伸手|推开|关上|拔出|收回|挥|点头|摇头|回头|靠近|后退|拥抱|抓|扔|跳|落下|打开|合上|端起|喝|拍|指向|move|walk|run|turn|stand|sit|pick|put|raise|open|close|draw|wave|nod|shake|step|grab|throw|jump|hug)/iu
  const sequentialPattern = /(然后|随后|随即|接着|紧接着|继而|同时|最后|after|then|next|before|finally|while)/giu
  const actionClauses = clauses.filter((clause) => actionPattern.test(clause)).length
  const sequentialMarkers = (value.match(sequentialPattern) || []).length
  const baseline = actionClauses > 0 ? actionClauses : clauses.length > 0 ? 0.5 : 0
  return Math.min(8, baseline + Math.min(4, sequentialMarkers * 0.75))
}

function inferCameraComplexity(value: string | null | undefined): number {
  if (!value) return 0
  if (/(固定|静止|static|locked)/iu.test(value)) return 0
  const moves = value.match(/(推近|拉远|摇镜|横摇|平移|跟随|环绕|升起|下降|俯冲|手持|变焦|dolly|zoom|pan|tilt|track|follow|orbit|crane|handheld)/giu)
  return Math.min(4, moves?.length || 0)
}

function inferShotHoldSeconds(value: string | null | undefined): number {
  if (!value) return 0
  return /(特写|close[- ]?up|reaction|反应)/iu.test(value) ? 0.4 : 0
}

function countReadableCharacters(value: string | null | undefined): number {
  if (typeof value !== 'string') return 0
  return value.replace(/[\s\p{P}\p{S}]/gu, '').length
}

function joinText(...values: Array<string | null | undefined>): string {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && !!value.trim())
    .map((value) => value.trim()))].join('\n')
}

function pickRicherText(...values: Array<string | null | undefined>): string {
  return values
    .filter((value): value is string => typeof value === 'string' && !!value.trim())
    .map((value) => value.trim())
    .sort((left, right) => right.length - left.length)[0] || ''
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readPositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveFinite(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(VIDEO_DURATION_INVALID)
  return value
}

function optionalPositiveFinite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
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
