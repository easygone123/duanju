import sharp from 'sharp'
import type { PixelRect } from './crop-geometry'
import {
  DEFAULT_SIX_GRID_CROP_MAX_SOURCE_PIXELS,
  readSixGridCropLimits,
} from './limits'

// 32 MP caps decoded RGBA memory near 128 MiB while allowing large 3x2 sheets.
export const MAX_CROP_SOURCE_PIXELS = DEFAULT_SIX_GRID_CROP_MAX_SOURCE_PIXELS
const MAX_DIMENSION = 16_384
const ALLOWED_FORMATS = new Set(['png', 'jpeg', 'webp'])

export type SharpPipelineObserver = (delta: 1 | -1) => void

export async function readCropSourceMetadata(
  bytes: Buffer,
  observer?: SharpPipelineObserver,
): Promise<{ width: number; height: number }> {
  const maxSourcePixels = readSixGridCropLimits().maxSourcePixels
  return await observePipeline(observer, async () => {
    try {
      const metadata = await sharp(bytes, {
        limitInputPixels: maxSourcePixels,
        failOn: 'error',
      }).metadata()
      if (!metadata.width || !metadata.height || !metadata.format
        || !ALLOWED_FORMATS.has(metadata.format)
        || (metadata.pages ?? 1) !== 1
        || (metadata.orientation != null && metadata.orientation !== 1)) {
        throw new Error('invalid')
      }
      if (metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION
        || metadata.width * metadata.height > maxSourcePixels) {
        throw new Error('dimensions')
      }
      return { width: metadata.width, height: metadata.height }
    } catch (error) {
      if ((error as Error).message === 'dimensions') {
        throw new Error('SIX_GRID_SOURCE_DIMENSIONS_EXCEEDED')
      }
      throw new Error('SIX_GRID_SOURCE_IMAGE_INVALID')
    }
  })
}

export async function extractCropPng(
  sourceBytes: Buffer,
  rect: PixelRect,
  observer?: SharpPipelineObserver,
): Promise<Buffer> {
  const maxSourcePixels = readSixGridCropLimits().maxSourcePixels
  return await observePipeline(observer, async () => {
    try {
      return await sharp(sourceBytes, {
        limitInputPixels: maxSourcePixels,
        failOn: 'error',
      }).extract({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })
        .png({ compressionLevel: 9 })
        .toBuffer()
    } catch {
      throw new Error('SIX_GRID_CROP_EXTRACT_FAILED')
    }
  })
}

async function observePipeline<T>(observer: SharpPipelineObserver | undefined, work: () => Promise<T>) {
  observer?.(1)
  try {
    return await work()
  } finally {
    observer?.(-1)
  }
}
