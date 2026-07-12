import type {
  SixGridCellAspectRatio,
  SixGridProcessingOrder,
  StoryboardGenerationMode,
} from './contracts'
import { parseModelKeyStrict } from '@/lib/model-config-contract'

export const SIX_GRID_ASPECT_RATIO_UNSUPPORTED = 'SIX_GRID_ASPECT_RATIO_UNSUPPORTED'
export const STORYBOARD_RUN_SETTINGS_INVALID = 'STORYBOARD_RUN_SETTINGS_INVALID'

export interface StoryboardRunSettingsSource {
  storyboardGenerationMode?: StoryboardGenerationMode | null
  sixGridCellAspectRatio?: SixGridCellAspectRatio | null
  sixGridProcessingOrder?: SixGridProcessingOrder | null
  storyboardUpscaleModel?: string | null
  dialogueVideoModel?: string | null
  videoRatio?: string | null
}

export interface ResolvedStoryboardRunSettings {
  storyboardGenerationMode: StoryboardGenerationMode
  sixGridCellAspectRatio: SixGridCellAspectRatio | null
  sixGridProcessingOrder: SixGridProcessingOrder
  storyboardUpscaleModel: string | null
  dialogueVideoModel: string | null
}

export function parseStoryboardRunSettingsTask(value: unknown): StoryboardRunSettingsSource {
  if (!isRecord(value)) throw new Error(STORYBOARD_RUN_SETTINGS_INVALID)

  const parsed: StoryboardRunSettingsSource = {}
  if (Object.hasOwn(value, 'storyboardGenerationMode')) {
    if (value.storyboardGenerationMode !== null
      && value.storyboardGenerationMode !== 'individual'
      && value.storyboardGenerationMode !== 'six_grid') {
      throw new Error(STORYBOARD_RUN_SETTINGS_INVALID)
    }
    parsed.storyboardGenerationMode = value.storyboardGenerationMode
  }
  if (Object.hasOwn(value, 'sixGridCellAspectRatio')) {
    if (value.sixGridCellAspectRatio !== null
      && value.sixGridCellAspectRatio !== '16:9'
      && value.sixGridCellAspectRatio !== '9:16') {
      throw new Error(STORYBOARD_RUN_SETTINGS_INVALID)
    }
    parsed.sixGridCellAspectRatio = value.sixGridCellAspectRatio
  }
  if (Object.hasOwn(value, 'sixGridProcessingOrder')) {
    if (value.sixGridProcessingOrder !== null
      && value.sixGridProcessingOrder !== 'sheet_upscale_then_crop'
      && value.sixGridProcessingOrder !== 'crop_then_panel_upscale') {
      throw new Error(STORYBOARD_RUN_SETTINGS_INVALID)
    }
    parsed.sixGridProcessingOrder = value.sixGridProcessingOrder
  }
  for (const field of ['storyboardUpscaleModel', 'dialogueVideoModel'] as const) {
    if (!Object.hasOwn(value, field)) continue
    const model = value[field]
    if (model !== null && (typeof model !== 'string' || !parseModelKeyStrict(model))) {
      throw new Error(STORYBOARD_RUN_SETTINGS_INVALID)
    }
    parsed[field] = typeof model === 'string'
      ? parseModelKeyStrict(model)?.modelKey ?? null
      : null
  }
  return parsed
}

export function resolveStoryboardRunSettings(input: {
  task?: StoryboardRunSettingsSource | null
  project?: StoryboardRunSettingsSource | null
}): ResolvedStoryboardRunSettings {
  const task = input.task || {}
  const project = input.project || {}
  const storyboardGenerationMode = task.storyboardGenerationMode
    ?? project.storyboardGenerationMode
    ?? 'individual'
  const sixGridProcessingOrder = task.sixGridProcessingOrder
    ?? project.sixGridProcessingOrder
    ?? 'crop_then_panel_upscale'

  let sixGridCellAspectRatio: SixGridCellAspectRatio | null = null
  if (storyboardGenerationMode === 'six_grid') {
    const candidate = task.sixGridCellAspectRatio
      ?? project.sixGridCellAspectRatio
      ?? task.videoRatio
      ?? project.videoRatio
    if (candidate !== '16:9' && candidate !== '9:16') {
      throw new Error(SIX_GRID_ASPECT_RATIO_UNSUPPORTED)
    }
    sixGridCellAspectRatio = candidate
  }

  return {
    storyboardGenerationMode,
    sixGridCellAspectRatio,
    sixGridProcessingOrder,
    storyboardUpscaleModel: Object.hasOwn(task, 'storyboardUpscaleModel')
      ? task.storyboardUpscaleModel ?? null
      : project.storyboardUpscaleModel ?? null,
    dialogueVideoModel: Object.hasOwn(task, 'dialogueVideoModel')
      ? task.dialogueVideoModel ?? null
      : project.dialogueVideoModel ?? null,
  }
}

export function shouldLockStoryboardRunSettings(input: {
  isStarting: boolean
  isActiveRunning: boolean
}): boolean {
  return input.isStarting || input.isActiveRunning
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
