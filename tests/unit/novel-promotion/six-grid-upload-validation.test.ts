import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import {
  SIX_GRID_UPLOAD_MAX_BYTES,
  SIX_GRID_UPLOAD_RATIO_TOLERANCE,
  SixGridUploadError,
  expectedGridSheetRatio,
  expectedSixGridSheetRatio,
  isGridSheetRatioAllowed,
  isSixGridSheetRatioAllowed,
  sheetRatio,
} from '@/lib/novel-promotion/six-grid/upload-contract'
import {
  validateAndNormalizeGridUpload,
  validateAndNormalizeSixGridUpload,
} from '@/lib/novel-promotion/six-grid/upload-validation'
import { resolveStoryboardGridSpec } from '@/lib/novel-promotion/grid-storyboard/spec'
import { resolveGridCropRects } from '@/lib/novel-promotion/grid-storyboard/crop-geometry'

async function imageFixture(
  format: 'png' | 'jpeg' | 'webp' | 'gif',
  width = 800,
  height = 300,
): Promise<Buffer> {
  const image = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 24, g: 96, b: 160 },
    },
  })
  return await image[format]().toBuffer()
}

async function captureUploadError(work: () => Promise<unknown>): Promise<SixGridUploadError> {
  try {
    await work()
  } catch (error) {
    expect(error).toBeInstanceOf(SixGridUploadError)
    return error as SixGridUploadError
  }
  throw new Error('Expected upload validation to fail')
}

describe('six-grid upload contract', () => {
  it('returns the canonical 3x2 sheet ratios for both cell ratios', () => {
    expect(expectedSixGridSheetRatio('16:9')).toBe(8 / 3)
    expect(expectedSixGridSheetRatio('9:16')).toBe(27 / 32)
  })

  it.each([
    { cellRatio: '16:9' as const, direction: 'above', factor: 1 + SIX_GRID_UPLOAD_RATIO_TOLERANCE },
    { cellRatio: '16:9' as const, direction: 'below', factor: 1 - SIX_GRID_UPLOAD_RATIO_TOLERANCE },
    { cellRatio: '9:16' as const, direction: 'above', factor: 1 + SIX_GRID_UPLOAD_RATIO_TOLERANCE },
    { cellRatio: '9:16' as const, direction: 'below', factor: 1 - SIX_GRID_UPLOAD_RATIO_TOLERANCE },
  ])('includes the 3% $direction boundary for $cellRatio cells', ({ cellRatio, factor }) => {
    const expected = expectedSixGridSheetRatio(cellRatio)
    expect(isSixGridSheetRatioAllowed(expected * factor, cellRatio)).toBe(true)
  })

  it.each([
    { cellRatio: '16:9' as const, factor: 1 + SIX_GRID_UPLOAD_RATIO_TOLERANCE + 0.000_001 },
    { cellRatio: '16:9' as const, factor: 1 - SIX_GRID_UPLOAD_RATIO_TOLERANCE - 0.000_001 },
    { cellRatio: '9:16' as const, factor: 1 + SIX_GRID_UPLOAD_RATIO_TOLERANCE + 0.000_001 },
    { cellRatio: '9:16' as const, factor: 1 - SIX_GRID_UPLOAD_RATIO_TOLERANCE - 0.000_001 },
  ])('rejects a ratio just outside the 3% boundary for $cellRatio cells', ({ cellRatio, factor }) => {
    const expected = expectedSixGridSheetRatio(cellRatio)
    expect(isSixGridSheetRatioAllowed(expected * factor, cellRatio)).toBe(false)
  })

  it('computes a ratio only for positive safe-integer dimensions', () => {
    expect(sheetRatio(800, 300)).toBe(8 / 3)

    for (const [width, height] of [
      [0, 300],
      [-1, 300],
      [800.5, 300],
      [Number.NaN, 300],
      [Number.MAX_SAFE_INTEGER + 1, 300],
      [800, Number.POSITIVE_INFINITY],
    ]) {
      expect(() => sheetRatio(width, height)).toThrowError(
        expect.objectContaining({ code: 'SIX_GRID_UPLOAD_IMAGE_INVALID' }),
      )
    }
  })
})

describe('configurable grid upload contract', () => {
  it.each([
    { mode: 'four_grid' as const, cellRatio: '16:9' as const, expected: 16 / 9 },
    { mode: 'four_grid' as const, cellRatio: '9:16' as const, expected: 9 / 16 },
    { mode: 'six_grid' as const, cellRatio: '16:9' as const, expected: 8 / 3 },
    { mode: 'six_grid' as const, cellRatio: '9:16' as const, expected: 27 / 32 },
  ])('uses $mode $cellRatio canonical sheet ratio', ({ mode, cellRatio, expected }) => {
    const spec = resolveStoryboardGridSpec(mode, cellRatio)
    expect(expectedGridSheetRatio(spec)).toBe(expected)
    expect(isGridSheetRatioAllowed(expected, spec)).toBe(true)
  })

  it.each([
    { ratio: '16:9' as const, width: 1600, height: 900 },
    { ratio: '9:16' as const, width: 900, height: 1600 },
  ])('accepts a four-grid $ratio full sheet', async ({ ratio, width, height }) => {
    const result = await validateAndNormalizeGridUpload(
      await imageFixture('png', width, height),
      resolveStoryboardGridSpec('four_grid', ratio),
    )
    expect(result).toMatchObject({ width, height, mimeType: 'image/webp' })
  })

  it.each([
    { mode: 'four_grid' as const, ratio: '16:9' as const, width: 1600, height: 901 },
    { mode: 'four_grid' as const, ratio: '9:16' as const, width: 901, height: 1600 },
    { mode: 'six_grid' as const, ratio: '16:9' as const, width: 2401, height: 900 },
    { mode: 'six_grid' as const, ratio: '9:16' as const, width: 1350, height: 1601 },
  ])('crops a tolerated non-divisible $mode $ratio upload through canonical automatic cells', async ({ mode, ratio, width, height }) => {
    const spec = resolveStoryboardGridSpec(mode, ratio)
    const upload = await validateAndNormalizeGridUpload(
      await imageFixture('png', width, height),
      spec,
    )
    const canonicalDefaults = Array.from({ length: spec.panelCount }, (_, cellIndex) => ({
      cellIndex,
      normalizedCropRect: {
        x: (cellIndex % spec.columns) / spec.columns,
        y: Math.floor(cellIndex / spec.columns) / spec.rows,
        width: 1 / spec.columns,
        height: 1 / spec.rows,
      },
    }))

    const rects = resolveGridCropRects({
      cropRectSource: 'auto',
      cropRects: canonicalDefaults,
      spec,
      dimensions: { width: upload.width, height: upload.height },
    })

    expect(rects).toHaveLength(spec.panelCount)
    expect(rects.reduce((area, item) => area + item.pixelRect.width * item.pixelRect.height, 0))
      .toBe(upload.width * upload.height)
  })

  it('keeps strict aspect validation when the same tolerated default-shaped rectangle is user supplied', () => {
    const spec = resolveStoryboardGridSpec('four_grid', '16:9')
    expect(() => resolveGridCropRects({
      cropRectSource: 'manual',
      cropRects: [{
        cellIndex: 0,
        normalizedCropRect: { x: 0, y: 0, width: 0.5, height: 0.5 },
      }],
      spec,
      dimensions: { width: 1600, height: 901 },
    })).toThrow('CROP_ASPECT_RATIO_MISMATCH')
  })

  it('rejects a mismatched four-grid sheet with mode and expected ratio context', async () => {
    const error = await captureUploadError(async () => validateAndNormalizeGridUpload(
      await imageFixture('png', 1600, 900),
      resolveStoryboardGridSpec('four_grid', '9:16'),
    ))
    expect(error).toMatchObject({
      code: 'SIX_GRID_UPLOAD_RATIO_INVALID',
      details: {
        width: 1600,
        height: 900,
        actualRatio: 16 / 9,
        expectedRatio: 9 / 16,
        mode: 'four_grid',
      },
    })
  })
})

describe('six-grid upload validation', () => {
  it.each(['png', 'jpeg', 'webp'] as const)(
    'accepts and normalizes a valid %s sheet to WebP',
    async (format) => {
      const result = await validateAndNormalizeSixGridUpload(
        await imageFixture(format),
        '16:9',
      )

      expect(result).toMatchObject({
        width: 800,
        height: 300,
        sizeBytes: result.bytes.byteLength,
        mimeType: 'image/webp',
      })
      expect(result.bytes).toBeInstanceOf(Buffer)
      expect(await sharp(result.bytes).metadata()).toMatchObject({
        format: 'webp',
        width: 800,
        height: 300,
      })
    },
  )

  it('applies EXIF autorotation before validating and returning dimensions', async () => {
    const source = await sharp({
      create: {
        width: 300,
        height: 800,
        channels: 3,
        background: { r: 48, g: 128, b: 72 },
      },
    }).jpeg().withMetadata({ orientation: 6 }).toBuffer()

    expect(await sharp(source).metadata()).toMatchObject({
      width: 300,
      height: 800,
      orientation: 6,
    })

    const result = await validateAndNormalizeSixGridUpload(source, '16:9')

    expect(result).toMatchObject({ width: 800, height: 300, mimeType: 'image/webp' })
    expect(await sharp(result.bytes).metadata()).toMatchObject({
      format: 'webp',
      width: 800,
      height: 300,
    })
  })

  it('rejects invalid image bytes without exposing the decoder error', async () => {
    const error = await captureUploadError(() => validateAndNormalizeSixGridUpload(
      Buffer.from('not an image'),
      '16:9',
    ))

    expect(error).toMatchObject({
      code: 'SIX_GRID_UPLOAD_IMAGE_INVALID',
      message: 'SIX_GRID_UPLOAD_IMAGE_INVALID',
      details: {},
    })
  })

  it('rejects a decodable GIF based on its actual format', async () => {
    const error = await captureUploadError(async () => validateAndNormalizeSixGridUpload(
      await imageFixture('gif'),
      '16:9',
    ))

    expect(error).toMatchObject({ code: 'SIX_GRID_UPLOAD_IMAGE_INVALID' })
  })

  it('rejects an empty source as an invalid image', async () => {
    const error = await captureUploadError(() => validateAndNormalizeSixGridUpload(
      Buffer.alloc(0),
      '16:9',
    ))

    expect(error).toMatchObject({ code: 'SIX_GRID_UPLOAD_IMAGE_INVALID' })
  })

  it('rejects an oversized encoded source before attempting to decode it', async () => {
    const error = await captureUploadError(() => validateAndNormalizeSixGridUpload(
      Buffer.alloc(SIX_GRID_UPLOAD_MAX_BYTES + 1),
      '16:9',
    ))

    expect(error).toMatchObject({ code: 'SIX_GRID_UPLOAD_TOO_LARGE' })
  })

  it('rejects a decoded dimension above the maximum', async () => {
    const error = await captureUploadError(async () => validateAndNormalizeSixGridUpload(
      await imageFixture('png', 16_385, 1),
      '16:9',
    ))

    expect(error).toMatchObject({ code: 'SIX_GRID_UPLOAD_TOO_LARGE' })
  })

  it('enforces the 80 megapixel cap independently of the per-dimension cap', async () => {
    const source = await imageFixture('png', 14_640, 5_490)

    const error = await captureUploadError(() => validateAndNormalizeSixGridUpload(
      source,
      '16:9',
    ))

    expect(14_640).toBeLessThan(16_384)
    expect(5_490).toBeLessThan(16_384)
    expect(14_640 * 5_490).toBeGreaterThan(80_000_000)
    expect(error).toMatchObject({ code: 'SIX_GRID_UPLOAD_TOO_LARGE' })
  })

  it('accepts and normalizes a valid portrait 9:16 six-grid sheet end to end', async () => {
    const result = await validateAndNormalizeSixGridUpload(
      await imageFixture('jpeg', 810, 960),
      '9:16',
    )

    expect(result).toMatchObject({
      width: 810,
      height: 960,
      mimeType: 'image/webp',
    })
    expect(await sharp(result.bytes).metadata()).toMatchObject({
      format: 'webp',
      width: 810,
      height: 960,
    })
  })

  it('rejects the wrong overall ratio with stable numeric details', async () => {
    const error = await captureUploadError(async () => validateAndNormalizeSixGridUpload(
      await imageFixture('png', 600, 600),
      '16:9',
    ))

    expect(error).toMatchObject({
      code: 'SIX_GRID_UPLOAD_RATIO_INVALID',
      message: 'SIX_GRID_UPLOAD_RATIO_INVALID',
      details: {
        width: 600,
        height: 600,
        actualRatio: 1,
      },
    })
  })
})
