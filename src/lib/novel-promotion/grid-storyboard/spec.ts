export type GridStoryboardMode = 'four_grid' | 'six_grid'

export type GridCellAspectRatio = '16:9' | '9:16'

export const FOUR_GRID_SHEET_SIZES = [
  '1280x720',
  '1536x864',
  '2560x1440',
  '720x1280',
  '864x1536',
  '1440x2560',
] as const

export type FourGridSheetSize = (typeof FOUR_GRID_SHEET_SIZES)[number]

export const DEFAULT_FOUR_GRID_SHEET_LONG_EDGE = 1536

export function resolveFourGridSheetSize(
  cellAspectRatio: GridCellAspectRatio,
  longEdge: 1280 | 1536 | 2560 = DEFAULT_FOUR_GRID_SHEET_LONG_EDGE,
): FourGridSheetSize {
  const landscape = {
    1280: '1280x720',
    1536: '1536x864',
    2560: '2560x1440',
  } as const
  const portrait = {
    1280: '720x1280',
    1536: '864x1536',
    2560: '1440x2560',
  } as const
  return cellAspectRatio === '9:16' ? portrait[longEdge] : landscape[longEdge]
}

export function isFourGridSheetSizeForRatio(
  value: unknown,
  cellAspectRatio: GridCellAspectRatio,
): value is FourGridSheetSize {
  return value === resolveFourGridSheetSize(cellAspectRatio, 1280)
    || value === resolveFourGridSheetSize(cellAspectRatio, 1536)
    || value === resolveFourGridSheetSize(cellAspectRatio, 2560)
}

export type StoryboardGridSpec = {
  mode: GridStoryboardMode
  columns: 2 | 3
  rows: 2
  panelCount: 4 | 6
  cellAspectRatio: GridCellAspectRatio
  sheetAspectRatio: '16:9' | '9:16' | '8:3' | '27:32'
}

const GRID_STORYBOARD_MODES: readonly GridStoryboardMode[] = ['four_grid', 'six_grid']
const GRID_CELL_ASPECT_RATIOS: readonly GridCellAspectRatio[] = ['16:9', '9:16']

export function isGridStoryboardMode(value: unknown): value is GridStoryboardMode {
  return GRID_STORYBOARD_MODES.includes(value as GridStoryboardMode)
}

export function isGridCellAspectRatio(value: unknown): value is GridCellAspectRatio {
  return GRID_CELL_ASPECT_RATIOS.includes(value as GridCellAspectRatio)
}

export function allowsIndividualStoryboardGroupCreation(
  configuredMode: unknown,
  persistedModes: readonly unknown[],
): boolean {
  if (persistedModes.length > 0) {
    return !persistedModes.some(isGridStoryboardMode)
  }
  return !isGridStoryboardMode(configuredMode)
}

export function assertGridStoryboardMode(value: unknown): asserts value is GridStoryboardMode {
  if (!isGridStoryboardMode(value)) throw new Error('STORYBOARD_GRID_MODE_INVALID')
}

export function assertGridCellAspectRatio(value: unknown): asserts value is GridCellAspectRatio {
  if (!isGridCellAspectRatio(value)) {
    throw new Error('STORYBOARD_GRID_CELL_ASPECT_RATIO_INVALID')
  }
}

export function resolveStoryboardGridSpec(
  mode: unknown,
  cellAspectRatio: unknown,
): StoryboardGridSpec {
  assertGridStoryboardMode(mode)
  assertGridCellAspectRatio(cellAspectRatio)

  if (mode === 'four_grid') {
    return {
      mode,
      columns: 2,
      rows: 2,
      panelCount: 4,
      cellAspectRatio,
      sheetAspectRatio: cellAspectRatio,
    }
  }

  return {
    mode,
    columns: 3,
    rows: 2,
    panelCount: 6,
    cellAspectRatio,
    sheetAspectRatio: cellAspectRatio === '16:9' ? '8:3' : '27:32',
  }
}
