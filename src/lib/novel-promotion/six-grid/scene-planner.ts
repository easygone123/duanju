import type {
  ActingDirection,
  PhotographyRule,
  StoryboardPanel,
} from '@/lib/storyboard-phases'
import {
  GRID_CLIP_COVERAGE_INVALID,
  GRID_CLIP_ORDER_INVALID,
  GRID_CONTINUITY_MISMATCH,
  GRID_NUMBERING_INVALID,
  GRID_PANEL_INVALID,
  GRID_REQUIRES_EXACT_PANEL_COUNT,
  GRID_RULES_INVALID,
  GRID_SCENE_BOUNDARY_VIOLATION,
  GRID_SCENE_PLAN_INVALID,
  GridStoryboardValidationError,
  validateGridActingDirections,
  validateGridEpisodePlan,
  validateGridPhotographyRules,
  validateGridSceneGroups,
  type GridValidationCode,
} from '@/lib/novel-promotion/grid-storyboard/scene-planner'
import { resolveStoryboardGridSpec } from '@/lib/novel-promotion/grid-storyboard/spec'

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

const SIX_GRID_SPEC = resolveStoryboardGridSpec('six_grid', '16:9')

export function validateAndNormalizeSixGridGroups(value: unknown): SixGridSceneGroup[] {
  return withSixGridErrors(() => validateGridSceneGroups(value, SIX_GRID_SPEC)
    .map((group) => ({ ...group, panels: group.panels as SixStoryboardPanels })))
}

export function validateSixGridEpisodePlan(
  value: unknown,
  orderedClipIds: readonly string[],
): PlannedSixGridSceneGroup[] {
  return withSixGridErrors(() => validateGridEpisodePlan(value, orderedClipIds, SIX_GRID_SPEC)
    .map((group) => ({ ...group, panels: group.panels as SixStoryboardPanels })))
}

export function validateSixGridPhotographyRules(value: unknown): PhotographyRule[] {
  return withSixGridErrors(() => validateGridPhotographyRules(value, SIX_GRID_SPEC))
}

export function validateSixGridActingDirections(value: unknown): ActingDirection[] {
  return withSixGridErrors(() => validateGridActingDirections(value, SIX_GRID_SPEC))
}

function withSixGridErrors<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof GridStoryboardValidationError) {
      throw new SixGridValidationError(
        mapGridCode(error.code),
        toLegacySixGridContext(error.code, error.rawContext),
      )
    }
    throw error
  }
}

function toLegacySixGridContext(
  code: GridValidationCode,
  context: Readonly<Record<string, string | number>>,
): Record<string, string | number> {
  const {
    mode: _mode,
    expectedPanelCount: _expectedPanelCount,
    actualPanelCount,
    ...legacyContext
  } = context
  if (code === GRID_REQUIRES_EXACT_PANEL_COUNT && actualPanelCount !== undefined) {
    return { ...legacyContext, panelCount: actualPanelCount }
  }
  return legacyContext
}

function mapGridCode(code: GridValidationCode): SixGridValidationCode {
  switch (code) {
    case GRID_REQUIRES_EXACT_PANEL_COUNT:
      return SIX_GRID_REQUIRES_EXACTLY_SIX_PANELS
    case GRID_SCENE_BOUNDARY_VIOLATION:
      return SIX_GRID_SCENE_BOUNDARY_VIOLATION
    case GRID_CONTINUITY_MISMATCH:
      return SIX_GRID_CONTINUITY_MISMATCH
    case GRID_SCENE_PLAN_INVALID:
      return SIX_GRID_SCENE_PLAN_INVALID
    case GRID_PANEL_INVALID:
      return SIX_GRID_PANEL_INVALID
    case GRID_NUMBERING_INVALID:
      return SIX_GRID_NUMBERING_INVALID
    case GRID_RULES_INVALID:
      return SIX_GRID_RULES_INVALID
    case GRID_CLIP_COVERAGE_INVALID:
      return SIX_GRID_CLIP_COVERAGE_INVALID
    case GRID_CLIP_ORDER_INVALID:
      return SIX_GRID_CLIP_ORDER_INVALID
  }
}
