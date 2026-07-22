import type {
  ActingDirection,
  PhotographyRule,
  StoryboardPanel,
} from '@/lib/storyboard-phases'
import type { StoryboardGridSpec } from './spec'

export const GRID_REQUIRES_EXACT_PANEL_COUNT = 'GRID_REQUIRES_EXACT_PANEL_COUNT'
export const GRID_SCENE_BOUNDARY_VIOLATION = 'GRID_SCENE_BOUNDARY_VIOLATION'
export const GRID_CONTINUITY_MISMATCH = 'GRID_CONTINUITY_MISMATCH'
export const GRID_SCENE_PLAN_INVALID = 'GRID_SCENE_PLAN_INVALID'
export const GRID_PANEL_INVALID = 'GRID_PANEL_INVALID'
export const GRID_NUMBERING_INVALID = 'GRID_NUMBERING_INVALID'
export const GRID_RULES_INVALID = 'GRID_RULES_INVALID'
export const GRID_CLIP_COVERAGE_INVALID = 'GRID_CLIP_COVERAGE_INVALID'
export const GRID_CLIP_ORDER_INVALID = 'GRID_CLIP_ORDER_INVALID'

export type GridValidationCode =
  | typeof GRID_REQUIRES_EXACT_PANEL_COUNT
  | typeof GRID_SCENE_BOUNDARY_VIOLATION
  | typeof GRID_CONTINUITY_MISMATCH
  | typeof GRID_SCENE_PLAN_INVALID
  | typeof GRID_PANEL_INVALID
  | typeof GRID_NUMBERING_INVALID
  | typeof GRID_RULES_INVALID
  | typeof GRID_CLIP_COVERAGE_INVALID
  | typeof GRID_CLIP_ORDER_INVALID

export class GridStoryboardValidationError extends Error {
  readonly code: GridValidationCode
  readonly rawContext: Readonly<Record<string, string | number>>

  constructor(code: GridValidationCode, rawContext: Record<string, string | number> = {}) {
    super(code)
    this.name = 'GridStoryboardValidationError'
    this.code = code
    this.rawContext = Object.freeze({ ...rawContext })
  }
}

export interface GridSceneGroup {
  sceneKey: string
  clipId: string
  incomingContinuity: string
  outgoingContinuity: string
  panels: StoryboardPanel[]
}

export interface PlannedGridSceneGroup extends GridSceneGroup {
  groupId: string
  groupKey: string
  groupSequence: number
}

export function validateGridSceneGroups(
  value: unknown,
  spec: StoryboardGridSpec,
): GridSceneGroup[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw validationError(GRID_SCENE_PLAN_INVALID, spec, { scope: 'groups' })
  }

  const groups = value.map((candidate, groupIndex) => normalizeGroup(candidate, groupIndex, spec))
  for (let index = 1; index < groups.length; index += 1) {
    const previous = groups[index - 1]
    const current = groups[index]
    if (current.sceneKey === previous.sceneKey
      && current.incomingContinuity !== previous.outgoingContinuity) {
      throw validationError(GRID_CONTINUITY_MISMATCH, spec, { groupIndex: index })
    }
  }
  return groups
}

export function validateGridEpisodePlan(
  value: unknown,
  orderedClipIds: readonly string[],
  spec: StoryboardGridSpec,
): PlannedGridSceneGroup[] {
  const groups = validateGridSceneGroups(value, spec)
  const clipIndexById = new Map(orderedClipIds.map((clipId, index) => [clipId, index]))
  const seenClipIds = new Set<string>()
  const groupCountByClipId = new Map<string, number>()
  let previousClipIndex = -1

  const planned = groups.map((group, index): PlannedGridSceneGroup => {
    const clipIndex = clipIndexById.get(group.clipId)
    if (clipIndex === undefined) {
      throw validationError(GRID_CLIP_COVERAGE_INVALID, spec, { groupIndex: index })
    }
    if (clipIndex < previousClipIndex) {
      throw validationError(GRID_CLIP_ORDER_INVALID, spec, { groupIndex: index })
    }
    previousClipIndex = clipIndex
    seenClipIds.add(group.clipId)
    const withinClipSequence = (groupCountByClipId.get(group.clipId) || 0) + 1
    groupCountByClipId.set(group.clipId, withinClipSequence)
    const groupSequence = index + 1
    const prefix = spec.mode === 'four_grid' ? 'four-grid' : 'six-grid'
    const groupId = `${prefix}:${groupSequence}:${group.clipId}:${withinClipSequence}`
    return {
      ...group,
      groupId,
      groupKey: groupId,
      groupSequence,
    }
  })

  if (orderedClipIds.some((clipId) => !seenClipIds.has(clipId))) {
    throw validationError(GRID_CLIP_COVERAGE_INVALID, spec, {
      expectedClipCount: orderedClipIds.length,
      coveredClipCount: seenClipIds.size,
    })
  }
  return planned
}

export function validateGridPhotographyRules(
  value: unknown,
  spec: StoryboardGridSpec,
): PhotographyRule[] {
  return validateNumberedRows(value, 'photography', spec, (row, rowIndex) => (
    normalizePhotographyRow(row, rowIndex, spec)
  )) as PhotographyRule[]
}

export function validateGridActingDirections(
  value: unknown,
  spec: StoryboardGridSpec,
): ActingDirection[] {
  return validateNumberedRows(value, 'acting', spec, (row, rowIndex) => {
    if (!Array.isArray(row.characters)
      || !row.characters.every((character) => isActingCharacter(character))) {
      throw validationError(GRID_RULES_INVALID, spec, { rowIndex, scope: 'acting' })
    }
    return row
  }) as ActingDirection[]
}

function normalizeGroup(
  value: unknown,
  groupIndex: number,
  spec: StoryboardGridSpec,
): GridSceneGroup {
  if (!isRecord(value)) {
    throw validationError(GRID_SCENE_PLAN_INVALID, spec, { groupIndex })
  }
  if (!Array.isArray(value.panels) || value.panels.length !== spec.panelCount) {
    throw validationError(GRID_REQUIRES_EXACT_PANEL_COUNT, spec, {
      groupIndex,
      actualPanelCount: Array.isArray(value.panels) ? value.panels.length : -1,
    })
  }

  const sceneKey = readRequiredText(value.sceneKey, GRID_SCENE_PLAN_INVALID, spec, { groupIndex })
  const clipId = readRequiredText(value.clipId, GRID_SCENE_PLAN_INVALID, spec, { groupIndex })
  const incomingContinuity = readRequiredText(value.incomingContinuity, GRID_SCENE_PLAN_INVALID, spec, { groupIndex })
  const outgoingContinuity = readRequiredText(value.outgoingContinuity, GRID_SCENE_PLAN_INVALID, spec, { groupIndex })
  const panels = value.panels.map((panel, panelIndex) => normalizePanel(panel, groupIndex, panelIndex, spec))
  assertSequentialPanelNumbers(panels, spec, { groupIndex })
  const locations = new Set(panels.map((panel) => panel.location))
  if (locations.size !== 1 || !locations.has(sceneKey)) {
    throw validationError(GRID_SCENE_BOUNDARY_VIOLATION, spec, { groupIndex })
  }

  return { sceneKey, clipId, incomingContinuity, outgoingContinuity, panels }
}

function normalizePanel(
  value: unknown,
  groupIndex: number,
  panelIndex: number,
  spec: StoryboardGridSpec,
): StoryboardPanel {
  if (!isRecord(value)) {
    throw validationError(GRID_PANEL_INVALID, spec, { groupIndex, panelIndex })
  }
  const context = { groupIndex, panelIndex }
  const panelNumber = value.panel_number
  if (!Number.isInteger(panelNumber)) {
    throw validationError(GRID_NUMBERING_INVALID, spec, context)
  }
  const description = readRequiredText(value.description, GRID_PANEL_INVALID, spec, context)
  const location = readRequiredText(value.location, GRID_PANEL_INVALID, spec, context)
  const sourceText = readRequiredText(value.source_text, GRID_PANEL_INVALID, spec, context)
  if (!isCharacters(value.characters)) {
    throw validationError(GRID_PANEL_INVALID, spec, context)
  }
  if (value.props !== undefined
    && (!Array.isArray(value.props)
      || !value.props.every((prop) => typeof prop === 'string' && !!prop.trim()))) {
    throw validationError(GRID_PANEL_INVALID, spec, context)
  }
  if (value.srt_range !== undefined && !Array.isArray(value.srt_range)) {
    throw validationError(GRID_PANEL_INVALID, spec, context)
  }
  for (const field of ['scene_type', 'shot_type', 'camera_move', 'video_prompt'] as const) {
    if (value[field] !== undefined) readRequiredText(value[field], GRID_PANEL_INVALID, spec, context)
  }
  if (typeof value.duration !== 'number'
    || !Number.isFinite(value.duration)
    || value.duration <= 0) {
    throw validationError(GRID_PANEL_INVALID, spec, context)
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
  spec: StoryboardGridSpec,
  validateRow: (row: Record<string, unknown>, rowIndex: number) => Record<string, unknown>,
): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length !== spec.panelCount) {
    throw validationError(GRID_RULES_INVALID, spec, {
      scope,
      rowCount: Array.isArray(value) ? value.length : -1,
    })
  }
  const rows = value.map((row, rowIndex) => {
    if (!isRecord(row)) throw validationError(GRID_RULES_INVALID, spec, { scope, rowIndex })
    return validateRow(row, rowIndex)
  })
  assertSequentialPanelNumbers(rows, spec, { scope })
  return rows
}

function normalizePhotographyRow(
  row: Record<string, unknown>,
  rowIndex: number,
  spec: StoryboardGridSpec,
): PhotographyRule {
  const context = { rowIndex, scope: 'photography' }
  if (row.composition !== undefined) {
    return {
      panel_number: row.panel_number as number,
      composition: readRequiredText(row.composition, GRID_RULES_INVALID, spec, context),
      lighting: readRequiredText(row.lighting, GRID_RULES_INVALID, spec, context),
      color_palette: readRequiredText(row.color_palette, GRID_RULES_INVALID, spec, context),
      atmosphere: readRequiredText(row.atmosphere, GRID_RULES_INVALID, spec, context),
      technical_notes: readRequiredText(row.technical_notes, GRID_RULES_INVALID, spec, context),
    }
  }

  const sceneSummary = readRequiredText(row.scene_summary, GRID_RULES_INVALID, spec, context)
  const depthOfField = readRequiredText(row.depth_of_field, GRID_RULES_INVALID, spec, context)
  const colorTone = readRequiredText(row.color_tone, GRID_RULES_INVALID, spec, context)
  if (!isRecord(row.lighting)) throw validationError(GRID_RULES_INVALID, spec, context)
  const lightingDirection = readRequiredText(row.lighting.direction, GRID_RULES_INVALID, spec, context)
  const lightingQuality = readRequiredText(row.lighting.quality, GRID_RULES_INVALID, spec, context)
  if (!Array.isArray(row.characters)
    || !row.characters.every((character) => isPhotographyCharacter(character))) {
    throw validationError(GRID_RULES_INVALID, spec, context)
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
  spec: StoryboardGridSpec,
  context: Record<string, string | number>,
) {
  for (let index = 0; index < spec.panelCount; index += 1) {
    if (rows[index]?.panel_number !== index + 1) {
      throw validationError(GRID_NUMBERING_INVALID, spec, { ...context, rowIndex: index })
    }
  }
}

function readRequiredText(
  value: unknown,
  code: GridValidationCode,
  spec: StoryboardGridSpec,
  context: Record<string, string | number>,
): string {
  if (typeof value !== 'string' || !value.trim()) throw validationError(code, spec, context)
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
  code: GridValidationCode,
  spec: StoryboardGridSpec,
  context: Record<string, string | number>,
) {
  return new GridStoryboardValidationError(code, {
    mode: spec.mode,
    expectedPanelCount: spec.panelCount,
    ...context,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
