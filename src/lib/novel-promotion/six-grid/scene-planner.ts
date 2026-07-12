import type {
  ActingDirection,
  PhotographyRule,
  StoryboardPanel,
} from '@/lib/storyboard-phases'

export const SIX_GRID_REQUIRES_EXACTLY_SIX_PANELS = 'SIX_GRID_REQUIRES_EXACTLY_SIX_PANELS'
export const SIX_GRID_SCENE_BOUNDARY_VIOLATION = 'SIX_GRID_SCENE_BOUNDARY_VIOLATION'
export const SIX_GRID_CONTINUITY_MISMATCH = 'SIX_GRID_CONTINUITY_MISMATCH'
export const SIX_GRID_SCENE_PLAN_INVALID = 'SIX_GRID_SCENE_PLAN_INVALID'
export const SIX_GRID_PANEL_INVALID = 'SIX_GRID_PANEL_INVALID'
export const SIX_GRID_NUMBERING_INVALID = 'SIX_GRID_NUMBERING_INVALID'
export const SIX_GRID_RULES_INVALID = 'SIX_GRID_RULES_INVALID'
export const SIX_GRID_CLIP_COVERAGE_INVALID = 'SIX_GRID_CLIP_COVERAGE_INVALID'
export const SIX_GRID_CLIP_ORDER_INVALID = 'SIX_GRID_CLIP_ORDER_INVALID'

type SixGridValidationCode =
  | typeof SIX_GRID_REQUIRES_EXACTLY_SIX_PANELS
  | typeof SIX_GRID_SCENE_BOUNDARY_VIOLATION
  | typeof SIX_GRID_CONTINUITY_MISMATCH
  | typeof SIX_GRID_SCENE_PLAN_INVALID
  | typeof SIX_GRID_PANEL_INVALID
  | typeof SIX_GRID_NUMBERING_INVALID
  | typeof SIX_GRID_RULES_INVALID
  | typeof SIX_GRID_CLIP_COVERAGE_INVALID
  | typeof SIX_GRID_CLIP_ORDER_INVALID

export class SixGridValidationError extends Error {
  readonly code: SixGridValidationCode
  readonly rawContext: Readonly<Record<string, string | number>>

  constructor(code: SixGridValidationCode, rawContext: Record<string, string | number> = {}) {
    super(code)
    this.name = 'SixGridValidationError'
    this.code = code
    this.rawContext = Object.freeze({ ...rawContext })
  }
}

export type SixStoryboardPanels = [
  StoryboardPanel,
  StoryboardPanel,
  StoryboardPanel,
  StoryboardPanel,
  StoryboardPanel,
  StoryboardPanel,
]

export interface SixGridSceneGroup {
  sceneKey: string
  clipId: string
  incomingContinuity: string
  outgoingContinuity: string
  panels: SixStoryboardPanels
}

export interface PlannedSixGridSceneGroup extends SixGridSceneGroup {
  groupId: string
  groupKey: string
  groupSequence: number
}

export function validateAndNormalizeSixGridGroups(value: unknown): SixGridSceneGroup[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw validationError(SIX_GRID_SCENE_PLAN_INVALID, { scope: 'groups' })
  }

  const groups = value.map((candidate, groupIndex) => normalizeGroup(candidate, groupIndex))
  for (let index = 1; index < groups.length; index += 1) {
    const previous = groups[index - 1]
    const current = groups[index]
    if (current.sceneKey === previous.sceneKey
      && current.incomingContinuity !== previous.outgoingContinuity) {
      throw validationError(SIX_GRID_CONTINUITY_MISMATCH, { groupIndex: index })
    }
  }
  return groups
}

export function validateSixGridEpisodePlan(
  value: unknown,
  orderedClipIds: readonly string[],
): PlannedSixGridSceneGroup[] {
  const groups = validateAndNormalizeSixGridGroups(value)
  const clipIndexById = new Map(orderedClipIds.map((clipId, index) => [clipId, index]))
  const seenClipIds = new Set<string>()
  const groupCountByClipId = new Map<string, number>()
  let previousClipIndex = -1

  const planned = groups.map((group, index): PlannedSixGridSceneGroup => {
    const clipIndex = clipIndexById.get(group.clipId)
    if (clipIndex === undefined) {
      throw validationError(SIX_GRID_CLIP_COVERAGE_INVALID, { groupIndex: index })
    }
    if (clipIndex < previousClipIndex) {
      throw validationError(SIX_GRID_CLIP_ORDER_INVALID, { groupIndex: index })
    }
    previousClipIndex = clipIndex
    seenClipIds.add(group.clipId)
    const withinClipSequence = (groupCountByClipId.get(group.clipId) || 0) + 1
    groupCountByClipId.set(group.clipId, withinClipSequence)
    const groupSequence = index + 1
    const groupId = `six-grid:${groupSequence}:${group.clipId}:${withinClipSequence}`
    return {
      ...group,
      groupId,
      groupKey: groupId,
      groupSequence,
    }
  })

  if (orderedClipIds.some((clipId) => !seenClipIds.has(clipId))) {
    throw validationError(SIX_GRID_CLIP_COVERAGE_INVALID, {
      expectedClipCount: orderedClipIds.length,
      coveredClipCount: seenClipIds.size,
    })
  }
  return planned
}

export function validateSixGridPhotographyRules(value: unknown): PhotographyRule[] {
  return validateNumberedRows(value, 'photography', (row, rowIndex) => (
    normalizePhotographyRow(row, rowIndex)
  )) as PhotographyRule[]
}

export function validateSixGridActingDirections(value: unknown): ActingDirection[] {
  return validateNumberedRows(value, 'acting', (row, rowIndex) => {
    if (!Array.isArray(row.characters)
      || !row.characters.every((character) => isActingCharacter(character))) {
      throw validationError(SIX_GRID_RULES_INVALID, { rowIndex, scope: 'acting' })
    }
    return row
  }) as ActingDirection[]
}

function normalizeGroup(value: unknown, groupIndex: number): SixGridSceneGroup {
  if (!isRecord(value)) {
    throw validationError(SIX_GRID_SCENE_PLAN_INVALID, { groupIndex })
  }
  if (!Array.isArray(value.panels) || value.panels.length !== 6) {
    throw validationError(SIX_GRID_REQUIRES_EXACTLY_SIX_PANELS, {
      groupIndex,
      panelCount: Array.isArray(value.panels) ? value.panels.length : -1,
    })
  }

  const sceneKey = readRequiredText(value.sceneKey, SIX_GRID_SCENE_PLAN_INVALID, { groupIndex })
  const clipId = readRequiredText(value.clipId, SIX_GRID_SCENE_PLAN_INVALID, { groupIndex })
  const incomingContinuity = readRequiredText(value.incomingContinuity, SIX_GRID_SCENE_PLAN_INVALID, { groupIndex })
  const outgoingContinuity = readRequiredText(value.outgoingContinuity, SIX_GRID_SCENE_PLAN_INVALID, { groupIndex })
  const panels = value.panels.map((panel, panelIndex) => normalizePanel(panel, groupIndex, panelIndex)) as SixStoryboardPanels
  assertSequentialPanelNumbers(panels, { groupIndex })
  const locations = new Set(panels.map((panel) => panel.location))
  if (locations.size !== 1 || !locations.has(sceneKey)) {
    throw validationError(SIX_GRID_SCENE_BOUNDARY_VIOLATION, { groupIndex })
  }

  return { sceneKey, clipId, incomingContinuity, outgoingContinuity, panels }
}

function normalizePanel(value: unknown, groupIndex: number, panelIndex: number): StoryboardPanel {
  if (!isRecord(value)) {
    throw validationError(SIX_GRID_PANEL_INVALID, { groupIndex, panelIndex })
  }
  const context = { groupIndex, panelIndex }
  const panelNumber = value.panel_number
  if (!Number.isInteger(panelNumber)) {
    throw validationError(SIX_GRID_NUMBERING_INVALID, context)
  }
  const description = readRequiredText(value.description, SIX_GRID_PANEL_INVALID, context)
  const location = readRequiredText(value.location, SIX_GRID_PANEL_INVALID, context)
  const sourceText = readRequiredText(value.source_text, SIX_GRID_PANEL_INVALID, context)
  if (!isCharacters(value.characters)) {
    throw validationError(SIX_GRID_PANEL_INVALID, context)
  }
  if (value.props !== undefined
    && (!Array.isArray(value.props)
      || !value.props.every((prop) => typeof prop === 'string' && !!prop.trim()))) {
    throw validationError(SIX_GRID_PANEL_INVALID, context)
  }
  if (value.srt_range !== undefined && !Array.isArray(value.srt_range)) {
    throw validationError(SIX_GRID_PANEL_INVALID, context)
  }
  for (const field of ['scene_type', 'shot_type', 'camera_move', 'video_prompt'] as const) {
    if (value[field] !== undefined) readRequiredText(value[field], SIX_GRID_PANEL_INVALID, context)
  }
  if (value.duration !== undefined
    && (typeof value.duration !== 'number' || !Number.isFinite(value.duration) || value.duration <= 0)) {
    throw validationError(SIX_GRID_PANEL_INVALID, context)
  }
  return {
    ...value,
    panel_number: panelNumber as number,
    description,
    location,
    source_text: sourceText,
    characters: value.characters,
  }
}

function validateNumberedRows(
  value: unknown,
  scope: 'photography' | 'acting',
  validateRow: (row: Record<string, unknown>, rowIndex: number) => Record<string, unknown>,
): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length !== 6) {
    throw validationError(SIX_GRID_RULES_INVALID, {
      scope,
      rowCount: Array.isArray(value) ? value.length : -1,
    })
  }
  const rows = value.map((row, rowIndex) => {
    if (!isRecord(row)) throw validationError(SIX_GRID_RULES_INVALID, { scope, rowIndex })
    return validateRow(row, rowIndex)
  })
  assertSequentialPanelNumbers(rows, { scope })
  return rows
}

function normalizePhotographyRow(
  row: Record<string, unknown>,
  rowIndex: number,
): PhotographyRule {
  const context = { rowIndex, scope: 'photography' }
  if (row.composition !== undefined) {
    return {
      panel_number: row.panel_number as number,
      composition: readRequiredText(row.composition, SIX_GRID_RULES_INVALID, context),
      lighting: readRequiredText(row.lighting, SIX_GRID_RULES_INVALID, context),
      color_palette: readRequiredText(row.color_palette, SIX_GRID_RULES_INVALID, context),
      atmosphere: readRequiredText(row.atmosphere, SIX_GRID_RULES_INVALID, context),
      technical_notes: readRequiredText(row.technical_notes, SIX_GRID_RULES_INVALID, context),
    }
  }

  const sceneSummary = readRequiredText(row.scene_summary, SIX_GRID_RULES_INVALID, context)
  const depthOfField = readRequiredText(row.depth_of_field, SIX_GRID_RULES_INVALID, context)
  const colorTone = readRequiredText(row.color_tone, SIX_GRID_RULES_INVALID, context)
  if (!isRecord(row.lighting)) throw validationError(SIX_GRID_RULES_INVALID, context)
  const lightingDirection = readRequiredText(row.lighting.direction, SIX_GRID_RULES_INVALID, context)
  const lightingQuality = readRequiredText(row.lighting.quality, SIX_GRID_RULES_INVALID, context)
  if (!Array.isArray(row.characters)
    || !row.characters.every((character) => isPhotographyCharacter(character))) {
    throw validationError(SIX_GRID_RULES_INVALID, context)
  }
  const characterComposition = row.characters
    .map((character) => {
      const item = character as Record<string, string>
      return `${item.name}: ${item.screen_position}, ${item.posture}, ${item.facing}`
    })
    .join('; ')

  return {
    panel_number: row.panel_number as number,
    composition: characterComposition ? `${sceneSummary}; ${characterComposition}` : sceneSummary,
    lighting: `${lightingDirection}; ${lightingQuality}`,
    color_palette: colorTone,
    atmosphere: sceneSummary,
    technical_notes: depthOfField,
  }
}

function assertSequentialPanelNumbers(
  rows: Array<{ panel_number?: unknown }>,
  context: Record<string, string | number>,
) {
  for (let index = 0; index < 6; index += 1) {
    if (rows[index]?.panel_number !== index + 1) {
      throw validationError(SIX_GRID_NUMBERING_INVALID, { ...context, rowIndex: index })
    }
  }
}

function readRequiredText(
  value: unknown,
  code: SixGridValidationCode,
  context: Record<string, string | number>,
): string {
  if (typeof value !== 'string' || !value.trim()) throw validationError(code, context)
  return value.trim()
}

function isCharacters(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.every((item) => {
    if (typeof item === 'string') return !!item.trim()
    return isRecord(item) && typeof item.name === 'string' && !!item.name.trim()
  })
}

function isPhotographyCharacter(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false
  const allowedFields = ['name', 'screen_position', 'posture', 'facing']
  return Object.keys(value).every((field) => allowedFields.includes(field))
    && allowedFields.every((field) => typeof value[field] === 'string' && !!value[field].trim())
}

function isActingCharacter(value: unknown): value is { name: string; acting: string } {
  if (!isRecord(value)) return false
  return Object.keys(value).every((field) => field === 'name' || field === 'acting')
    && typeof value.name === 'string'
    && !!value.name.trim()
    && typeof value.acting === 'string'
    && !!value.acting.trim()
}

function validationError(
  code: SixGridValidationCode,
  context: Record<string, string | number>,
) {
  return new SixGridValidationError(code, context)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
