export type StoryboardGenerationMode = 'individual' | 'six_grid'

export type SixGridCellAspectRatio = '16:9' | '9:16'

export type SixGridProcessingOrder =
  | 'sheet_upscale_then_crop'
  | 'crop_then_panel_upscale'

export type NormalizedCropRect = {
  x: number
  y: number
  width: number
  height: number
}

export type SixGridRunSettings = {
  mode: 'six_grid'
  cellAspectRatio: SixGridCellAspectRatio
  processingOrder: SixGridProcessingOrder
}

const CELL_ASPECT_RATIOS: readonly SixGridCellAspectRatio[] = ['16:9', '9:16']
const PROCESSING_ORDERS: readonly SixGridProcessingOrder[] = [
  'sheet_upscale_then_crop',
  'crop_then_panel_upscale',
]

export function parseSixGridRunSettings(value: unknown): SixGridRunSettings {
  if (!isRecord(value)
    || value.mode !== 'six_grid'
    || !CELL_ASPECT_RATIOS.includes(value.cellAspectRatio as SixGridCellAspectRatio)
    || !PROCESSING_ORDERS.includes(value.processingOrder as SixGridProcessingOrder)) {
    throw new Error('SIX_GRID_RUN_SETTINGS_INVALID')
  }

  return {
    mode: value.mode,
    cellAspectRatio: value.cellAspectRatio as SixGridCellAspectRatio,
    processingOrder: value.processingOrder as SixGridProcessingOrder,
  }
}

export function parseCropRect(value: unknown): NormalizedCropRect {
  if (!isRecord(value)
    || !isFiniteNumber(value.x)
    || !isFiniteNumber(value.y)
    || !isFiniteNumber(value.width)
    || !isFiniteNumber(value.height)) {
    throw new Error('SIX_GRID_CROP_INVALID')
  }

  const rect: NormalizedCropRect = {
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
  }
  if (rect.x < 0
    || rect.y < 0
    || rect.width <= 0
    || rect.height <= 0
    || rect.x + rect.width > 1
    || rect.y + rect.height > 1) {
    throw new Error('SIX_GRID_CROP_OUT_OF_BOUNDS')
  }

  return rect
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
