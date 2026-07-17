import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from 'bullmq'
import { TASK_TYPE, type TaskJobData } from '@/lib/task/types'

const prismaMock = vi.hoisted(() => ({
  novelPromotionStoryboard: { findFirst: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
}))
const generationMock = vi.hoisted(() => ({
  resolve: vi.fn(async () => 'generated-image'),
  upload: vi.fn(async () => 'images/output.png'),
  ensureMedia: vi.fn(async () => ({ id: 'output-media', url: '/m/output' })),
  assertActive: vi.fn(async () => undefined),
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/workers/utils', () => ({
  resolveImageSourceFromGeneration: generationMock.resolve,
  uploadImageSourceToCos: generationMock.upload,
  assertTaskActive: generationMock.assertActive,
  toSignedUrlIfCos: (value: string) => value,
}))
vi.mock('@/lib/media/service', () => ({ ensureMediaObjectFromStorageKey: generationMock.ensureMedia }))
vi.mock('@/lib/storage', () => ({ getObjectBuffer: vi.fn(async () => Buffer.from('stored')) }))
vi.mock('@/lib/media/outbound-image', () => ({ normalizeReferenceImagesForGeneration: vi.fn(async (values: string[]) => values) }))

import {
  buildSixGridTaskDedupeKey,
  handleStoryboardSheetTask,
  parseSixGridImageTaskSnapshot,
  type SixGridImageTaskSnapshot,
} from '@/lib/workers/handlers/storyboard-sheet-task-handler'

const FOUR_GRID_SPEC = {
  version: 1 as const,
  mode: 'four_grid' as const,
  columns: 2 as const,
  rows: 2 as const,
  panelCount: 4 as const,
  cellAspectRatio: '16:9' as const,
  sheetAspectRatio: '16:9' as const,
}

const SIX_GRID_SPEC = {
  version: 1 as const,
  mode: 'six_grid' as const,
  columns: 3 as const,
  rows: 2 as const,
  panelCount: 6 as const,
  cellAspectRatio: '16:9' as const,
  sheetAspectRatio: '8:3' as const,
}

function task(overrides: Partial<SixGridImageTaskSnapshot> = {}): SixGridImageTaskSnapshot {
  return {
    operation: 'generate',
    projectId: 'project-1',
    episodeId: 'episode-1',
    storyboardId: 'storyboard-1',
    groupSequence: 1,
    cellAspectRatio: '16:9',
    processingOrder: 'crop_then_panel_upscale',
    expectedSheetArtifactVersion: 0,
    promptSnapshot: 'one combined sheet prompt',
    modelSnapshot: 'image-model-1',
    optionsSnapshot: { seed: 1 },
    locale: 'zh',
    ...overrides,
  }
}

function job(payload: SixGridImageTaskSnapshot): Job<TaskJobData> {
  return { data: {
    taskId: 'task-1', type: TASK_TYPE.STORYBOARD_SHEET_GENERATE, locale: 'zh',
    projectId: 'project-1', episodeId: 'episode-1', targetType: 'NovelPromotionStoryboard',
    targetId: payload.storyboardId, payload: payload as unknown as Record<string, unknown>, userId: 'user-1',
  } } as Job<TaskJobData>
}

describe('grid storyboard immutable sheet task', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    generationMock.resolve.mockResolvedValue('generated-image')
    prismaMock.novelPromotionStoryboard.updateMany.mockResolvedValue({ count: 1 })
  })

  it('parses and preserves an exact versioned four-grid spec', () => {
    expect(parseSixGridImageTaskSnapshot(task({ gridSpec: FOUR_GRID_SPEC }))).toMatchObject({
      gridSpec: FOUR_GRID_SPEC,
    })
  })

  it('normalizes a legacy snapshot without gridSpec to six-grid', () => {
    const parsed = parseSixGridImageTaskSnapshot(task())
    expect(parsed).toMatchObject({ gridSpec: SIX_GRID_SPEC })
    expect(buildSixGridTaskDedupeKey(parsed)).toBe(
      'six-grid:generate:93e96014f122c03788e2aae6dd8eac2e8d1dea02774092b421cc2932d10fe7ea',
    )
  })

  it('rejects a versioned gridSpec that is internally inconsistent', () => {
    expect(() => parseSixGridImageTaskSnapshot(task({
      gridSpec: { ...FOUR_GRID_SPEC, panelCount: 6 } as unknown as typeof FOUR_GRID_SPEC,
    }))).toThrow('STORYBOARD_GRID_SPEC_INVALID')
  })

  it('uses normalized gridSpec in dedupe identity', () => {
    const four = parseSixGridImageTaskSnapshot(task({ gridSpec: FOUR_GRID_SPEC }))
    const six = parseSixGridImageTaskSnapshot(task({ gridSpec: SIX_GRID_SPEC }))
    expect(buildSixGridTaskDedupeKey(four)).not.toBe(buildSixGridTaskDedupeKey(six))
  })

  it('parses exactly four unique four-grid crop rectangles', () => {
    const cropRects = Array.from({ length: 4 }, (_, cellIndex) => ({
      cellIndex,
      normalizedCropRect: {
        x: (cellIndex % 2) / 2,
        y: Math.floor(cellIndex / 2) / 2,
        width: 0.5,
        height: 0.5,
      },
    }))
    expect(parseSixGridImageTaskSnapshot(task({
      operation: 'crop',
      sourceMediaId: 'sheet-1',
      sourceChecksum: 'sha-1',
      sourceVersion: 'v1',
      gridSpec: FOUR_GRID_SPEC,
      cropRects,
    })).cropRects).toEqual(cropRects)
    expect(() => parseSixGridImageTaskSnapshot(task({
      operation: 'crop',
      sourceMediaId: 'sheet-1',
      sourceChecksum: 'sha-1',
      sourceVersion: 'v1',
      gridSpec: FOUR_GRID_SPEC,
      cropRects: [...cropRects, { ...cropRects[3]!, cellIndex: 4 }],
    }))).toThrow('SIX_GRID_CROP_INDEXES_INVALID')
  })

  it.each([
    ['16:9', FOUR_GRID_SPEC],
    ['9:16', { ...FOUR_GRID_SPEC, cellAspectRatio: '9:16' as const, sheetAspectRatio: '9:16' as const }],
  ])('generates one complete four-grid sheet with ratio %s in one provider call', async (aspectRatio, gridSpec) => {
    const snapshot = task({ cellAspectRatio: gridSpec.cellAspectRatio, gridSpec })
    prismaMock.novelPromotionStoryboard.findFirst.mockResolvedValueOnce({
      id: 'storyboard-1', layoutMode: 'four_grid', sheetArtifactVersion: 0,
      sheetGenerationOptionsSnapshot: null, sheetImageMedia: null, upscaledSheetImageMedia: null,
    })

    await handleStoryboardSheetTask(job(snapshot))

    expect(generationMock.resolve).toHaveBeenCalledOnce()
    expect(generationMock.resolve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      prompt: 'one combined sheet prompt',
      options: expect.objectContaining({ aspectRatio }),
    }))
  })

  it.each([
    ['8:3', SIX_GRID_SPEC],
    ['27:32', { ...SIX_GRID_SPEC, cellAspectRatio: '9:16' as const, sheetAspectRatio: '27:32' as const }],
  ])('keeps six-grid generation to one provider call with ratio %s', async (aspectRatio, gridSpec) => {
    const snapshot = task({ cellAspectRatio: gridSpec.cellAspectRatio, gridSpec })
    prismaMock.novelPromotionStoryboard.findFirst.mockResolvedValueOnce({
      id: 'storyboard-1', layoutMode: 'six_grid', sheetArtifactVersion: 0,
      sheetGenerationOptionsSnapshot: null, sheetImageMedia: null, upscaledSheetImageMedia: null,
    })

    await handleStoryboardSheetTask(job(snapshot))

    expect(generationMock.resolve).toHaveBeenCalledOnce()
    expect(generationMock.resolve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      options: expect.objectContaining({ aspectRatio }),
    }))
  })
})
