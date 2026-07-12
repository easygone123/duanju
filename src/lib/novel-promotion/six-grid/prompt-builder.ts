import type { PromptLocale } from '@/lib/prompt-i18n'
import { buildPrompt, PROMPT_IDS } from '@/lib/prompt-i18n'
import type { SixGridCellAspectRatio } from './contracts'
import {
  validateAndNormalizeSixGridGroups,
  type SixGridSceneGroup,
} from './scene-planner'

export const SIX_GRID_PROMPT_INVALID = 'SIX_GRID_PROMPT_INVALID'

const MAX_PROMPT_FIELD_LENGTH = 1_000

export type PanelDialogueMetadata = {
  hasDialogue: boolean
  speaker: string | null
  text: string | null
  emotion: string | null
  includeInVideoPrompt: boolean
}

type SixGridPromptOptions = {
  locale: PromptLocale
  cellAspectRatio: SixGridCellAspectRatio
}

export function buildSixGridSheetPrompt(
  group: SixGridSceneGroup | unknown,
  options: SixGridPromptOptions,
): string {
  if (options.cellAspectRatio !== '16:9' && options.cellAspectRatio !== '9:16') {
    throw new Error(SIX_GRID_PROMPT_INVALID)
  }
  if (options.locale !== 'en' && options.locale !== 'zh') {
    throw new Error(SIX_GRID_PROMPT_INVALID)
  }

  const normalized = validateAndNormalizeSixGridGroups([group])[0]
  if (!normalized) throw new Error(SIX_GRID_PROMPT_INVALID)
  const dialogueTexts = collectDialogueTexts(group)
  const continuityBlock = `UNTRUSTED_VISUAL_DATA_CONTINUITY=${serializeUntrustedVisualData({
    scene: sanitizeVisualField(normalized.sceneKey, dialogueTexts),
    incomingContinuity: sanitizeVisualField(normalized.incomingContinuity, dialogueTexts),
    outgoingContinuity: sanitizeVisualField(normalized.outgoingContinuity, dialogueTexts),
  })}`
  const beats = normalized.panels.map((panel, index) => {
    const rawPanel = panel as Record<string, unknown>
    const visualData = {
      description: sanitizeVisualField(panel.description, dialogueTexts),
      action: sanitizeOptionalVisualField(rawPanel.action, dialogueTexts),
      location: sanitizeVisualField(panel.location, dialogueTexts),
      characters: extractVisualList(panel.characters, 'name', dialogueTexts),
      props: extractVisualList(panel.props, null, dialogueTexts),
      shotType: sanitizeOptionalVisualField(panel.shot_type, dialogueTexts),
      cameraMove: sanitizeOptionalVisualField(panel.camera_move, dialogueTexts),
      sceneType: sanitizeOptionalVisualField(panel.scene_type, dialogueTexts),
      wardrobe: sanitizeOptionalVisualField(rawPanel.wardrobe, dialogueTexts),
      lighting: sanitizeOptionalVisualField(rawPanel.lighting, dialogueTexts),
      emotion: sanitizeOptionalVisualField(rawPanel.emotion, dialogueTexts),
    }
    const prefix = options.locale === 'zh' ? `视觉节拍 ${index + 1}：` : `Beat ${index + 1}:`
    return `${prefix} UNTRUSTED_VISUAL_DATA=${serializeUntrustedVisualData(visualData)}`
  }).join('\n')

  return buildPrompt({
    promptId: PROMPT_IDS.NP_SIX_GRID_SHEET_IMAGE,
    locale: options.locale,
    variables: {
      cell_aspect_ratio: options.cellAspectRatio,
      continuity_block: continuityBlock,
      visual_beats: beats,
    },
  })
}

export function normalizePanelDialogue(value: unknown): PanelDialogueMetadata {
  if (!isRecord(value)) return emptyDialogue()
  const candidate = findDialogueCandidates(value).find((item) => readText(
    item.text ?? item.dialogueText ?? item.line ?? item.utterance,
  ))
  if (!candidate) return emptyDialogue()
  const text = readText(candidate.text ?? candidate.dialogueText ?? candidate.line ?? candidate.utterance)
  if (!text) return emptyDialogue()
  const speaker = readText(candidate.speaker ?? candidate.dialogueSpeaker)
  const emotion = readText(candidate.emotion ?? candidate.dialogueEmotion)
  const explicitPreference = firstBoolean(
    value.includeInVideoPrompt,
    value.includeDialogueInVideoPrompt,
    candidate.includeInVideoPrompt,
    candidate.includeDialogueInVideoPrompt,
  ) ?? true
  return {
    hasDialogue: true,
    speaker: speaker ? canonicalizePromptField(speaker) : null,
    text: canonicalizePromptField(text),
    emotion: emotion ? canonicalizePromptField(emotion) : null,
    includeInVideoPrompt: explicitPreference,
  }
}

function emptyDialogue(): PanelDialogueMetadata {
  return {
    hasDialogue: false,
    speaker: null,
    text: null,
    emotion: null,
    includeInVideoPrompt: false,
  }
}

function findDialogueCandidates(
  value: Record<string, unknown>,
  seen = new Set<Record<string, unknown>>(),
): Record<string, unknown>[] {
  if (seen.has(value)) return []
  seen.add(value)
  const candidates: Record<string, unknown>[] = []
  if (isRecord(value.dialogue)) candidates.push(value.dialogue)
  if ('dialogueText' in value) candidates.push(value)
  for (const nested of Object.values(value)) {
    if (!isRecord(nested)) continue
    candidates.push(...findDialogueCandidates(nested, seen))
  }
  return candidates
}

function collectDialogueTexts(value: unknown, dialogueContext = false, texts = new Set<string>()): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectDialogueTexts(item, dialogueContext, texts)
    return [...texts]
  }
  if (!isRecord(value)) return [...texts]
  for (const [key, nested] of Object.entries(value)) {
    const nextContext = dialogueContext || key.toLowerCase().includes('dialogue')
    const literalKey = /^(text|line|utterance|content|dialogueText)$/i.test(key)
    if (typeof nested === 'string' && nextContext && literalKey && nested.trim()) {
      texts.add(canonicalizePromptField(nested))
    } else if (typeof nested === 'object' && nested !== null) {
      collectDialogueTexts(nested, nextContext, texts)
    }
  }
  return [...texts]
}

function removeExplicitDialogue(value: string, dialogueTexts: readonly string[]): string {
  return dialogueTexts.reduce((result, literal) => {
    const escaped = escapeRegex(literal)
    const quoted = new RegExp(`(?:[“「\"]${escaped}[”」\"]|[‘']${escaped}[’'])`, 'gu')
    const labeled = new RegExp(
      `(?:dialogue|speech|line|text|台词|对白|对话)\\s*[:：]\\s*(?:[“「\"‘']\\s*)?${escaped}(?:\\s*[”」\"’'])?`,
      'giu',
    )
    const englishAttribution = new RegExp(
      `\\b(?:(?:says?|said|shouts?|shouted|whispers?|whispered|repl(?:y|ies|ied))\\s*(?:that\\s+)?|(?:asks?|asked|tells?|told)(?:\\s+[\\p{L}\\p{N}_-]+)?\\s*)`
        + `(?:[“「\"‘']\\s*)?${escaped}(?:\\s*[”」\"’'])?`,
      'giu',
    )
    const chineseAttribution = new RegExp(
      `(?:低声说|悄声说|说道|喊道|问道|回答|答道|回复|告诉|说|喊|问)\\s*`
        + `(?:[“「\"‘']\\s*)?${escaped}(?:\\s*[”」\"’'])?`,
      'gu',
    )
    const structured = result
      .replace(quoted, '')
      .replace(labeled, '')
      .replace(englishAttribution, '')
      .replace(chineseAttribution, '')
    return removeStandaloneLiteral(structured, escaped)
  }, value)
}

function removeStandaloneLiteral(value: string, escapedLiteral: string): string {
  const boundary = `[\\s:：;；,，.!?。！？"'“”‘’「」()（）]`
  const standalone = new RegExp(`(^|${boundary})${escapedLiteral}(?=$|${boundary})`, 'gu')
  const scrubbed = value.replace(standalone, '$1')
  if (standalone.test(scrubbed)) throw new Error('SIX_GRID_DIALOGUE_RESIDUAL')
  return scrubbed
}

function sanitizeVisualField(value: string | null | undefined, dialogueTexts: readonly string[]): string {
  return removeExplicitDialogue(canonicalizePromptField(value), dialogueTexts)
}

function sanitizeOptionalVisualField(
  value: unknown,
  dialogueTexts: readonly string[],
): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  return sanitizeVisualField(value, dialogueTexts) || null
}

function extractVisualList(
  value: unknown,
  objectKey: string | null,
  dialogueTexts: readonly string[],
): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    if (typeof item === 'string') return sanitizeVisualField(item, dialogueTexts)
    if (objectKey && isRecord(item) && typeof item[objectKey] === 'string') {
      return sanitizeVisualField(item[objectKey], dialogueTexts)
    }
    return ''
  }).filter(Boolean)
}

function serializeUntrustedVisualData(value: Record<string, unknown>): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003C')
    .replace(/>/g, '\\u003E')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export function canonicalizePromptField(value: string | null | undefined): string {
  return (value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
    .replace(/(?:^|\n)\s*#{1,6}\s*/g, ' ')
    .replace(/\bBeat\s+\d+\s*:/giu, 'sequence -')
    .replace(/视觉节拍\s*\d+\s*[:：]/gu, '序列 -')
    .replace(/\{\{?[A-Za-z0-9_]+\}?\}/g, '[field]')
    .replace(/\b(?:instructions?|system|assistant)\s*[:：]/giu, 'note -')
    .replace(/(?:Shared continuity|Six ordered visual beats|共享连续性|六个有序视觉节拍)\s*[:：]/giu, 'note -')
    .replace(/\n/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_PROMPT_FIELD_LENGTH)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  return values.find((value): value is boolean => typeof value === 'boolean')
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
