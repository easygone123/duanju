export const DEFAULT_SIX_GRID_CROP_MAX_SOURCE_BYTES = 50 * 1024 * 1024
export const DEFAULT_SIX_GRID_CROP_MAX_SOURCE_PIXELS = 32_000_000

export type SixGridCropLimits = {
  maxSourceBytes: number
  maxSourcePixels: number
}

export function readSixGridCropLimits(
  env: Record<string, string | undefined> = process.env,
): SixGridCropLimits {
  return {
    maxSourceBytes: parseLimit(
      env.SIX_GRID_CROP_MAX_SOURCE_BYTES,
      DEFAULT_SIX_GRID_CROP_MAX_SOURCE_BYTES,
      'SIX_GRID_CROP_MAX_SOURCE_BYTES',
      1_024,
      2 * 1024 * 1024 * 1024,
    ),
    maxSourcePixels: parseLimit(
      env.SIX_GRID_CROP_MAX_SOURCE_PIXELS,
      DEFAULT_SIX_GRID_CROP_MAX_SOURCE_PIXELS,
      'SIX_GRID_CROP_MAX_SOURCE_PIXELS',
      1_000_000,
      268_000_000,
    ),
  }
}

function parseLimit(
  raw: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name}_INVALID`)
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name}_INVALID`)
  }
  return parsed
}
