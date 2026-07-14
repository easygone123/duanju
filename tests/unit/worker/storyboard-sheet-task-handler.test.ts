import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from 'bullmq'
import { TASK_TYPE, type TaskJobData } from '@/lib/task/types'

const prismaMock = vi.hoisted(() => ({
  novelPromotionStoryboard: { findFirst: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
  novelPromotionPanel: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
  mediaObject: { findUnique: vi.fn() },
}))
const generationMock = vi.hoisted(() => ({
  resolve: vi.fn(async (jobValue: unknown, paramsValue: Record<string, unknown>) => {
    void jobValue; void paramsValue
    return 'generated-image'
  }), upload: vi.fn(async () => 'images/output.png'),
  ensureMedia: vi.fn(async () => ({ id: 'output-media', url: '/m/output' })),
  getBytes: vi.fn(async () => Buffer.from('stored')),
  normalize: vi.fn(async (values: string[]) => values.map((value) => `normalized:${value}`)),
  assertActive: vi.fn(async (jobValue: unknown, stageValue: string) => {
    void jobValue; void stageValue
    return undefined
  }),
}))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/workers/utils', () => ({
  resolveImageSourceFromGeneration: generationMock.resolve,
  uploadImageSourceToCos: generationMock.upload,
  assertTaskActive: generationMock.assertActive,
}))
vi.mock('@/lib/media/service', () => ({ ensureMediaObjectFromStorageKey: generationMock.ensureMedia }))
vi.mock('@/lib/storage', () => ({
  getObjectBuffer: generationMock.getBytes,
  uploadObject: vi.fn(async () => undefined),
  deleteObject: vi.fn(async () => undefined),
}))
vi.mock('@/lib/media/outbound-image', () => ({ normalizeReferenceImagesForGeneration: generationMock.normalize }))
import {
  buildSixGridTaskDedupeKey,
  resolveSheetAspectRatio,
  type SixGridImageTaskSnapshot,
  handleStoryboardPanelUpscaleTask,
  handleStoryboardSheetTask,
  parseSixGridImageTaskSnapshot,
} from '@/lib/workers/handlers/storyboard-sheet-task-handler'
import { commitSixGridCropBatch } from '@/lib/workers/handlers/storyboard-crop-task-handler'
import { handleStoryboardCropTask, toRetryableCropError } from '@/lib/workers/handlers/storyboard-crop-task-handler'
import { normalizeAnyError } from '@/lib/errors/normalize'

function snapshot(overrides: Partial<SixGridImageTaskSnapshot> = {}): SixGridImageTaskSnapshot {
  return {
    operation: 'crop',
    projectId: 'project-1',
    episodeId: 'episode-1',
    storyboardId: 'storyboard-1',
    groupSequence: 2,
    sourceMediaId: 'media-sheet-1',
    sourceChecksum: 'sha-1',
    sourceVersion: 'v1',
    cellAspectRatio: '16:9',
    processingOrder: 'crop_then_panel_upscale',
    expectedSheetArtifactVersion: 3,
    cropRects: Array.from({ length: 6 }, (_, index) => ({
      cellIndex: index,
      normalizedCropRect: { x: (index % 3) / 3, y: Math.floor(index / 3) / 2, width: 1 / 3, height: 1 / 2 },
    })),
    promptSnapshot: 'continuous story',
    modelSnapshot: 'image-model-1',
    optionsSnapshot: { seed: 7 },
    locale: 'zh',
    ...overrides,
  }
}

describe('six-grid image task immutable contract', () => {
  it('maps cell aspect ratio to the full 3x2 sheet ratio', () => {
    expect(resolveSheetAspectRatio('16:9')).toBe('8:3')
    expect(resolveSheetAspectRatio('9:16')).toBe('27:32')
  })

  it('includes source, version, geometry, order and artifact version in dedupe identity', () => {
    const base = snapshot()
    const key = buildSixGridTaskDedupeKey(base)
    expect(buildSixGridTaskDedupeKey({ ...base })).toBe(key)
    expect(buildSixGridTaskDedupeKey({ ...base, sourceChecksum: 'sha-2' })).not.toBe(key)
    expect(buildSixGridTaskDedupeKey({ ...base, sourceVersion: 'v2' })).not.toBe(key)
    expect(buildSixGridTaskDedupeKey({ ...base, processingOrder: 'sheet_upscale_then_crop' })).not.toBe(key)
    expect(buildSixGridTaskDedupeKey({ ...base, expectedSheetArtifactVersion: 4 })).not.toBe(key)
    expect(buildSixGridTaskDedupeKey({ ...base, promptSnapshot: 'changed prompt' })).not.toBe(key)
    expect(buildSixGridTaskDedupeKey({ ...base, modelSnapshot: 'changed-model' })).not.toBe(key)
    expect(buildSixGridTaskDedupeKey({ ...base, optionsSnapshot: { seed: 8 } })).not.toBe(key)
    const changed = structuredClone(base)
    changed.cropRects![0]!.normalizedCropRect.x = 0.01
    expect(buildSixGridTaskDedupeKey(changed)).not.toBe(key)
  })

  it('canonicalizes crop geometry order and rejects duplicate cell indexes', () => {
    const base = snapshot()
    const reversed = snapshot({ cropRects: [...base.cropRects!].reverse() })
    expect(buildSixGridTaskDedupeKey(parseSixGridImageTaskSnapshot(reversed))).toBe(
      buildSixGridTaskDedupeKey(parseSixGridImageTaskSnapshot(base)),
    )
    const duplicate = snapshot({ cropRects: base.cropRects!.map((item, index) => index === 5 ? { ...item, cellIndex: 4 } : item) })
    expect(() => parseSixGridImageTaskSnapshot(duplicate)).toThrow('SIX_GRID_CROP_INDEXES_INVALID')
  })

  it('requires the complete immutable source identity for every derived operation', () => {
    expect(() => parseSixGridImageTaskSnapshot(snapshot({ sourceChecksum: undefined }))).toThrow('SIX_GRID_SOURCE_SNAPSHOT_REQUIRED')
  })

  it('accepts task-run metadata injected by the shared submitter without adding it to the immutable snapshot', () => {
    const parsed = parseSixGridImageTaskSnapshot({
      ...snapshot(),
      flowId: 'novel-promotion',
      flowStageIndex: 1,
      flowStageTotal: 1,
      flowStageTitle: 'Storyboard sheet',
      runId: 'run-1',
      meta: { flowId: 'novel-promotion' },
    })
    expect(parsed).not.toHaveProperty('flowId')
    expect(parsed).not.toHaveProperty('meta')
  })
})

describe('six-grid sheet and panel execution', () => {
  beforeEach(() => resetExecutionMocks())
  it('reconciles matching stored bytes without another provider submission', async () => {
    const task = snapshot({ operation: 'generate', sourceMediaId: undefined, sourceChecksum: undefined, sourceVersion: undefined })
    const lineage = buildSixGridTaskDedupeKey(task)
    prismaMock.novelPromotionStoryboard.findFirst.mockResolvedValueOnce({
      id: 'storyboard-1', sheetArtifactVersion: 4,
      sheetGenerationOptionsSnapshot: JSON.stringify({ lineage }),
      sheetImageMedia: { id: 'sheet-output', storageKey: 'sheet-output.png' }, upscaledSheetImageMedia: null,
    })
    const result = await handleStoryboardSheetTask(job(task, TASK_TYPE.STORYBOARD_SHEET_GENERATE))
    expect(result).toEqual({ storyboardId: 'storyboard-1', mediaId: 'sheet-output', reconciled: true })
    expect(generationMock.getBytes).toHaveBeenCalledWith('sheet-output.png')
    expect(generationMock.resolve).not.toHaveBeenCalled()
    expect(prismaMock.novelPromotionStoryboard.updateMany).not.toHaveBeenCalled()
  })

  it('generates one complete portrait sheet with 27:32 and artifact-version CAS', async () => {
    const task = snapshot({ operation: 'generate', cellAspectRatio: '9:16', sourceMediaId: undefined, sourceChecksum: undefined, sourceVersion: undefined })
    prismaMock.novelPromotionStoryboard.findFirst.mockResolvedValueOnce({
      id: 'storyboard-1', sheetArtifactVersion: 3, sheetGenerationOptionsSnapshot: null,
      sheetImageMedia: null, upscaledSheetImageMedia: null,
    })
    await handleStoryboardSheetTask(job(task, TASK_TYPE.STORYBOARD_SHEET_GENERATE))
    expect(generationMock.resolve).toHaveBeenCalledOnce()
    expect(generationMock.resolve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      options: expect.objectContaining({ aspectRatio: '27:32' }),
    }))
    expect(prismaMock.novelPromotionStoryboard.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'storyboard-1', sheetArtifactVersion: 3 },
      data: expect.objectContaining({ sheetImageMediaId: 'output-media', sheetArtifactVersion: { increment: 1 } }),
    }))
  })

  it('upscales only the selected panel and rejects a stale crop source', async () => {
    const task = snapshot({ operation: 'panel_upscale', panelId: 'panel-2', workflowId: 'workflow-1', workflowVersionId: 'version-1', workflowPurpose: 'upscale', sourceVersion: '2026-07-13T00:00:00.000Z' })
    prismaMock.novelPromotionPanel.findFirst.mockResolvedValueOnce({ id: 'panel-2', imageMediaId: 'newer-media', imageUrl: '/m/newer', upscaledImageMediaId: null, imageLineage: null })
    await expect(handleStoryboardPanelUpscaleTask(job(task, TASK_TYPE.STORYBOARD_PANEL_UPSCALE))).rejects.toThrow('SIX_GRID_SOURCE_STALE')
    expect(prismaMock.novelPromotionPanel.updateMany).not.toHaveBeenCalled()
  })

  it('rejects a reused media id whose checksum or version no longer matches the snapshot', async () => {
    const task = snapshot({ operation: 'panel_upscale', panelId: 'panel-2', workflowId: 'workflow-1', workflowVersionId: 'version-1', workflowPurpose: 'upscale', sourceVersion: '2026-07-13T00:00:00.000Z' })
    prismaMock.novelPromotionPanel.findFirst.mockResolvedValueOnce({
      id: 'panel-2', imageMediaId: 'media-sheet-1', imageUrl: '/m/crop-2', upscaledImageMediaId: null, imageLineage: null,
      imageMedia: { id: 'media-sheet-1', sha256: 'different-sha', updatedAt: new Date('2026-07-13T00:00:00.000Z') },
    })
    await expect(handleStoryboardPanelUpscaleTask(job(task, TASK_TYPE.STORYBOARD_PANEL_UPSCALE))).rejects.toThrow('SIX_GRID_SOURCE_STALE')
    expect(generationMock.resolve).not.toHaveBeenCalled()
  })

  it('refuses to publish a generated sheet when the artifact CAS loses', async () => {
    const task = snapshot({ operation: 'generate', sourceMediaId: undefined, sourceChecksum: undefined, sourceVersion: undefined })
    prismaMock.novelPromotionStoryboard.findFirst.mockResolvedValueOnce({ id: 'storyboard-1', sheetArtifactVersion: 3, sheetGenerationOptionsSnapshot: null, sheetImageMedia: null, upscaledSheetImageMedia: null })
    prismaMock.novelPromotionStoryboard.updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(handleStoryboardSheetTask(job(task, TASK_TYPE.STORYBOARD_SHEET_GENERATE))).rejects.toThrow('SIX_GRID_SHEET_STALE')
    expect(prismaMock.novelPromotionStoryboard.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'storyboard-1', sheetArtifactVersion: 3 } }))
  })

  it('publishes a panel upscale with a source CAS scoped to only that panel', async () => {
    const task = snapshot({ operation: 'panel_upscale', panelId: 'panel-2', workflowId: 'workflow-1', workflowVersionId: 'version-1', workflowPurpose: 'upscale', sourceVersion: '2026-07-13T00:00:00.000Z' })
    prismaMock.novelPromotionPanel.findFirst.mockResolvedValueOnce({ id: 'panel-2', imageMediaId: 'media-sheet-1', imageUrl: '/m/crop-2', upscaledImageMediaId: null, imageLineage: null,
      imageMedia: { id: 'media-sheet-1', publicId: 'crop-public', storageKey: 'owned/crop-2.png', sha256: 'sha-1', updatedAt: new Date('2026-07-13T00:00:00.000Z') } })
    await handleStoryboardPanelUpscaleTask(job(task, TASK_TYPE.STORYBOARD_PANEL_UPSCALE))
    expect(prismaMock.novelPromotionPanel.updateMany).toHaveBeenCalledOnce()
    expect(prismaMock.novelPromotionPanel.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'panel-2', imageMediaId: 'media-sheet-1', imageMedia: expect.any(Object) }),
      data: expect.objectContaining({ upscaledImageMediaId: 'output-media', imageMediaId: 'output-media', imageDerivation: 'panel_upscale' }),
    }))
  })

  it('reconciles an already-published panel upscale from stored bytes after a crash', async () => {
    const task = snapshot({ operation: 'panel_upscale', panelId: 'panel-2', workflowId: 'workflow-1', workflowVersionId: 'version-1', workflowPurpose: 'upscale', sourceVersion: '2026-07-13T00:00:00.000Z' })
    const lineage = buildSixGridTaskDedupeKey(task)
    prismaMock.novelPromotionPanel.findFirst.mockResolvedValueOnce({
      id: 'panel-2', imageMediaId: 'output-media', imageUrl: '/m/output', upscaledImageMediaId: 'output-media', imageLineage: JSON.stringify({ lineage }),
      imageMedia: { id: 'output-media', sha256: 'output-sha', updatedAt: new Date() },
      upscaledImageMedia: { id: 'output-media', storageKey: 'panel-output.png' },
    })
    await expect(handleStoryboardPanelUpscaleTask(job(task, TASK_TYPE.STORYBOARD_PANEL_UPSCALE))).resolves.toEqual({ panelId: 'panel-2', mediaId: 'output-media', reconciled: true })
    expect(generationMock.getBytes).toHaveBeenCalledWith('panel-output.png')
    expect(generationMock.resolve).not.toHaveBeenCalled()
  })

  it('keeps original generation snapshots byte-identical and records sheet upscale lineage in history', async () => {
    const task = snapshot({
      operation: 'sheet_upscale', workflowId: 'workflow-1', workflowVersionId: 'version-old', workflowPurpose: 'upscale',
      sourceVersion: '2026-07-13T00:00:00.000Z', modelSnapshot: 'comfyui::workflow-1', optionsSnapshot: { scale: 2 },
    })
    prismaMock.novelPromotionStoryboard.findFirst.mockResolvedValueOnce({
      id: 'storyboard-1', sheetArtifactVersion: 3, sheetPromptSnapshot: 'ORIGINAL_PROMPT', sheetModelSnapshot: 'ORIGINAL_MODEL',
      sheetGenerationOptionsSnapshot: 'ORIGINAL_OPTIONS_BYTES', imageHistory: JSON.stringify([{ type: 'legacy', value: 1 }]),
      sheetImageMediaId: 'media-sheet-1', sheetImageUrl: 'https://attacker.invalid/stale.png',
      sheetImageMedia: { id: 'media-sheet-1', publicId: 'source-public', storageKey: 'owned/source.png', sha256: 'sha-1', updatedAt: new Date('2026-07-13T00:00:00.000Z') },
      upscaledSheetImageMedia: null,
    })
    await handleStoryboardSheetTask(job(task, TASK_TYPE.STORYBOARD_SHEET_UPSCALE))
    const updateCall = prismaMock.novelPromotionStoryboard.updateMany.mock.calls[0] as unknown as [{ data: Record<string, unknown> }]
    const data = updateCall[0].data
    expect(data).not.toHaveProperty('sheetPromptSnapshot')
    expect(data).not.toHaveProperty('sheetModelSnapshot')
    expect(data).not.toHaveProperty('sheetGenerationOptionsSnapshot')
    expect(JSON.parse(data.imageHistory as string)).toEqual(expect.arrayContaining([
      { type: 'legacy', value: 1 },
      expect.objectContaining({ type: 'six_grid_sheet_upscale', workflowVersionId: 'version-old', sourceMediaId: 'media-sheet-1' }),
    ]))
    expect(generationMock.getBytes).toHaveBeenCalledWith('owned/source.png')
    expect(generationMock.normalize).not.toHaveBeenCalled()
    expect(generationMock.resolve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      comfyWorkflowVersionId: 'version-old', comfyReferenceImages: ['owned/source.png'],
    }))
    expect(JSON.stringify(generationMock.resolve.mock.calls)).not.toContain('attacker.invalid')
  })

  it('reconciles a sheet upscale from typed history without provider calls or duplicate entries', async () => {
    const task = snapshot({
      operation: 'sheet_upscale', workflowId: 'workflow-1', workflowVersionId: 'version-old', workflowPurpose: 'upscale',
      sourceVersion: '2026-07-13T00:00:00.000Z', modelSnapshot: 'comfyui::workflow-1',
    })
    const lineage = buildSixGridTaskDedupeKey(task)
    const history = JSON.stringify([{ type: 'six_grid_sheet_upscale', lineage, workflowVersionId: 'version-old' }])
    prismaMock.novelPromotionStoryboard.findFirst.mockResolvedValueOnce({
      id: 'storyboard-1', sheetArtifactVersion: 4, imageHistory: history,
      sheetImageMedia: { id: 'media-sheet-1', storageKey: 'owned/source.png', sha256: 'sha-1', updatedAt: new Date('2026-07-13T00:00:00.000Z') },
      upscaledSheetImageMedia: { id: 'upscaled-output', storageKey: 'owned/upscaled.png' },
    })
    await expect(handleStoryboardSheetTask(job(task, TASK_TYPE.STORYBOARD_SHEET_UPSCALE))).resolves.toEqual({
      storyboardId: 'storyboard-1', mediaId: 'upscaled-output', reconciled: true,
    })
    expect(generationMock.getBytes).toHaveBeenCalledWith('owned/upscaled.png')
    expect(generationMock.resolve).not.toHaveBeenCalled()
    expect(prismaMock.novelPromotionStoryboard.updateMany).not.toHaveBeenCalled()
  })

  it('uses the queued ComfyUI generation version even if project defaults change later', async () => {
    const task = snapshot({
      operation: 'generate', modelSnapshot: 'comfyui::workflow-1', imageModel: 'comfyui::workflow-1',
      workflowId: 'workflow-1', workflowVersionId: 'version-old', workflowPurpose: 'generation',
      comfyWorkflowVersionId: 'version-old', comfyModelSnapshotVersion: 1,
      sourceMediaId: undefined, sourceChecksum: undefined, sourceVersion: undefined,
    })
    prismaMock.novelPromotionStoryboard.findFirst.mockResolvedValueOnce({
      id: 'storyboard-1', sheetArtifactVersion: 3, sheetGenerationOptionsSnapshot: null,
      sheetImageMedia: null, upscaledSheetImageMedia: null,
    })
    await handleStoryboardSheetTask(job(task, TASK_TYPE.STORYBOARD_SHEET_GENERATE))
    expect(generationMock.resolve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      modelId: 'comfyui::workflow-1', comfyWorkflowVersionId: 'version-old', allowTaskExternalIdResume: false,
    }))
  })

  it('enables remote external-id resume and finishes a retry without a second provider submit', async () => {
    const task = snapshot({ operation: 'generate', modelSnapshot: 'fal::banana-2', imageModel: 'fal::banana-2', sourceMediaId: undefined, sourceChecksum: undefined, sourceVersion: undefined })
    let externalId: string | null = null
    let submits = 0
    let resumes = 0
    generationMock.resolve.mockImplementation(async (_job, params) => {
      if (params.allowTaskExternalIdResume && externalId) { resumes += 1; return 'resumed-result' }
      submits += 1; externalId = 'external-1'; return 'first-result'
    })
    generationMock.upload.mockRejectedValueOnce(new Error('CRASH_AFTER_PROVIDER'))
    prismaMock.novelPromotionStoryboard.findFirst.mockResolvedValue({ id: 'storyboard-1', sheetArtifactVersion: 3, sheetGenerationOptionsSnapshot: null, sheetImageMedia: null, upscaledSheetImageMedia: null })
    await expect(handleStoryboardSheetTask(job(task, TASK_TYPE.STORYBOARD_SHEET_GENERATE))).rejects.toThrow('CRASH_AFTER_PROVIDER')
    await expect(handleStoryboardSheetTask(job(task, TASK_TYPE.STORYBOARD_SHEET_GENERATE))).resolves.toMatchObject({ reconciled: false })
    expect(submits).toBe(1)
    expect(resumes).toBe(1)
    expect(prismaMock.novelPromotionStoryboard.updateMany).toHaveBeenCalledTimes(1)
  })

  it('fences cancellation after sheet provider output before upload or DB persistence', async () => {
    const task = snapshot({ operation: 'generate', sourceMediaId: undefined, sourceChecksum: undefined, sourceVersion: undefined })
    prismaMock.novelPromotionStoryboard.findFirst.mockResolvedValueOnce({ id: 'storyboard-1', sheetArtifactVersion: 3, sheetGenerationOptionsSnapshot: null, sheetImageMedia: null, upscaledSheetImageMedia: null })
    generationMock.assertActive.mockImplementation(async (_job, stage) => {
      if (stage === 'six_grid_sheet_after_provider') throw new Error('TASK_CANCELLED')
    })
    await expect(handleStoryboardSheetTask(job(task, TASK_TYPE.STORYBOARD_SHEET_GENERATE))).rejects.toThrow('TASK_CANCELLED')
    expect(generationMock.upload).not.toHaveBeenCalled()
    expect(prismaMock.novelPromotionStoryboard.updateMany).not.toHaveBeenCalled()
  })

  it('does not advance undo history when panel upscale resolves to the current media', async () => {
    const task = snapshot({ operation: 'panel_upscale', panelId: 'panel-2', workflowId: 'workflow-1', workflowVersionId: 'version-old', workflowPurpose: 'upscale', sourceVersion: '2026-07-13T00:00:00.000Z' })
    prismaMock.novelPromotionPanel.findFirst.mockResolvedValueOnce({ id: 'panel-2', imageMediaId: 'media-sheet-1', imageUrl: '/m/current', upscaledImageMediaId: null, imageLineage: null,
      imageMedia: { id: 'media-sheet-1', storageKey: 'owned/current.png', sha256: 'sha-1', updatedAt: new Date('2026-07-13T00:00:00.000Z') } })
    generationMock.ensureMedia.mockResolvedValueOnce({ id: 'media-sheet-1', url: '/m/current' })
    await handleStoryboardPanelUpscaleTask(job(task, TASK_TYPE.STORYBOARD_PANEL_UPSCALE))
    const updateCall = prismaMock.novelPromotionPanel.updateMany.mock.calls[0] as unknown as [{ data: Record<string, unknown> }]
    const update = updateCall[0]
    expect(update.data).not.toHaveProperty('previousImageMediaId')
    expect(update.data).not.toHaveProperty('previousImageUrl')
  })

  it('fences cancellation after panel provider output before upload or panel update', async () => {
    const task = snapshot({ operation: 'panel_upscale', panelId: 'panel-2', workflowId: 'workflow-1', workflowVersionId: 'version-old', workflowPurpose: 'upscale', sourceVersion: '2026-07-13T00:00:00.000Z', modelSnapshot: 'comfyui::workflow-1' })
    prismaMock.novelPromotionPanel.findFirst.mockResolvedValueOnce({ id: 'panel-2', imageMediaId: 'media-sheet-1', imageUrl: '/m/current', upscaledImageMediaId: null, imageLineage: null,
      imageMedia: { id: 'media-sheet-1', storageKey: 'owned/current.png', sha256: 'sha-1', updatedAt: new Date('2026-07-13T00:00:00.000Z') } })
    generationMock.assertActive.mockImplementation(async (_job, stage) => {
      if (stage === 'six_grid_panel_upscale_after_provider') throw new Error('TASK_CANCELLED')
    })
    await expect(handleStoryboardPanelUpscaleTask(job(task, TASK_TYPE.STORYBOARD_PANEL_UPSCALE))).rejects.toThrow('TASK_CANCELLED')
    expect(generationMock.upload).not.toHaveBeenCalled()
    expect(prismaMock.novelPromotionPanel.updateMany).not.toHaveBeenCalled()
  })

  it('derives panel provider inputs only from the verified MediaObject, never redundant URLs', async () => {
    const task = snapshot({ operation: 'panel_upscale', panelId: 'panel-2', workflowId: 'workflow-1', workflowVersionId: 'version-old', workflowPurpose: 'upscale', sourceVersion: '2026-07-13T00:00:00.000Z', modelSnapshot: 'comfyui::workflow-1' })
    prismaMock.novelPromotionPanel.findFirst.mockResolvedValueOnce({
      id: 'panel-2', imageMediaId: 'media-sheet-1', imageUrl: 'https://attacker.invalid/stale.png', upscaledImageMediaId: null, imageLineage: null,
      imageMedia: { id: 'media-sheet-1', publicId: 'crop-public', storageKey: 'owned/crop-2.png', sha256: 'sha-1', updatedAt: new Date('2026-07-13T00:00:00.000Z') },
    })
    await handleStoryboardPanelUpscaleTask(job(task, TASK_TYPE.STORYBOARD_PANEL_UPSCALE))
    expect(generationMock.getBytes).toHaveBeenCalledWith('owned/crop-2.png')
    expect(generationMock.normalize).not.toHaveBeenCalled()
    expect(generationMock.resolve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ comfyWorkflowVersionId: 'version-old', comfyReferenceImages: ['owned/crop-2.png'] }))
    expect(JSON.stringify(generationMock.resolve.mock.calls)).not.toContain('attacker.invalid')
  })

  it('fails on missing source storage bytes before calling the provider', async () => {
    const task = snapshot({ operation: 'panel_upscale', panelId: 'panel-2', workflowId: 'workflow-1', workflowVersionId: 'version-old', workflowPurpose: 'upscale', sourceVersion: '2026-07-13T00:00:00.000Z', modelSnapshot: 'comfyui::workflow-1' })
    prismaMock.novelPromotionPanel.findFirst.mockResolvedValueOnce({
      id: 'panel-2', imageMediaId: 'media-sheet-1', imageUrl: '/m/stale', upscaledImageMediaId: null, imageLineage: null,
      imageMedia: { id: 'media-sheet-1', publicId: 'crop-public', storageKey: 'missing/crop.png', sha256: 'sha-1', updatedAt: new Date('2026-07-13T00:00:00.000Z') },
    })
    generationMock.getBytes.mockRejectedValueOnce(new Error('STORAGE_NOT_FOUND'))
    await expect(handleStoryboardPanelUpscaleTask(job(task, TASK_TYPE.STORYBOARD_PANEL_UPSCALE))).rejects.toThrow('STORAGE_NOT_FOUND')
    expect(generationMock.resolve).not.toHaveBeenCalled()
  })
})

describe('six-grid crop atomic persistence', () => {
  beforeEach(() => resetExecutionMocks())
  it('switches all six panels in one transaction without changing dialogue or duration', async () => {
    const update = vi.fn(async () => ({}))
    const findMany = vi.fn(async () => Array.from({ length: 6 }, (_, gridCellIndex) => ({ id: `panel-${gridCellIndex}`, gridCellIndex, imageMediaId: `old-${gridCellIndex}`, imageUrl: `/m/old-${gridCellIndex}` })))
    const transaction = vi.fn(async (callback: (tx: { novelPromotionPanel: { update: typeof update; findMany: typeof findMany } }) => Promise<void>) => {
      await callback({ novelPromotionPanel: { update, findMany } })
    })
    const artifacts = Array.from({ length: 6 }, (_, cellIndex) => ({
      cellIndex,
      mediaId: `crop-${cellIndex}`,
      url: `/m/crop-${cellIndex}`,
      normalizedCropRect: snapshot().cropRects![cellIndex]!.normalizedCropRect,
      lineage: { sourceMediaId: 'media-sheet-1', artifactVersion: 1 },
    }))

    await commitSixGridCropBatch({
      storyboardId: 'storyboard-1',
      sourceMediaId: 'media-sheet-1',
      expectedSheetArtifactVersion: 3,
      processingOrder: 'crop_then_panel_upscale',
      taskLineage: 'crop-task-lineage',
      artifacts,
    }, { transaction })

    expect(transaction).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledTimes(6)
    expect(update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { id: 'panel-0' },
      data: expect.objectContaining({
        croppedImageMediaId: 'crop-0',
        imageMediaId: 'crop-0',
        previousImageMediaId: 'old-0',
        previousImageUrl: '/m/old-0',
      }),
    }))
    expect(JSON.stringify(update.mock.calls)).not.toContain('dialogueText')
    expect(JSON.stringify(update.mock.calls)).not.toContain('estimatedDuration')
  })

  it('does not open the panel transaction when crop production fails', async () => {
    const transaction = vi.fn()
    const crop = vi.fn(async () => { throw new Error('SIX_GRID_CROP_BATCH_FAILED') })
    const { executeSixGridCrop } = await import('@/lib/workers/handlers/storyboard-crop-task-handler')
    await expect(executeSixGridCrop(snapshot(), { userId: 'user-1', crop, transaction })).rejects.toThrow('SIX_GRID_CROP_BATCH_FAILED')
    expect(transaction).not.toHaveBeenCalled()
  })

  it('propagates a busy crop claim for the task retry policy without panel writes', async () => {
    const transaction = vi.fn()
    const crop = vi.fn(async () => { throw new Error('SIX_GRID_CROP_BUSY') })
    const { executeSixGridCrop } = await import('@/lib/workers/handlers/storyboard-crop-task-handler')
    await expect(executeSixGridCrop(snapshot(), { userId: 'user-1', crop, transaction })).rejects.toThrow('SIX_GRID_CROP_BUSY')
    expect(transaction).not.toHaveBeenCalled()
    expect(normalizeAnyError(toRetryableCropError(new Error('SIX_GRID_CROP_BUSY')), { context: 'worker' }).retryable).toBe(true)
    expect(normalizeAnyError(toRetryableCropError(new Error('SIX_GRID_SOURCE_STALE')), { context: 'worker' }).retryable).toBe(false)
    expect(normalizeAnyError(toRetryableCropError(new Error('SIX_GRID_CROP_IDENTITY_CONFLICT')), { context: 'worker' }).retryable).toBe(false)
  })

  it('fences cancellation after a long crop before opening the six-panel transaction', async () => {
    const transaction = vi.fn()
    const crop = vi.fn(async () => Array.from({ length: 6 }, (_, cellIndex) => ({ cellIndex, mediaId: `crop-${cellIndex}` })))
    const assertActive = vi.fn(async (stage: string) => {
      if (stage === 'six_grid_crop_after_crop') throw new Error('TASK_CANCELLED')
    })
    const { executeSixGridCrop } = await import('@/lib/workers/handlers/storyboard-crop-task-handler')
    await expect(executeSixGridCrop(snapshot(), { userId: 'user-1', crop: crop as never, transaction, assertActive })).rejects.toThrow('TASK_CANCELLED')
    expect(transaction).not.toHaveBeenCalled()
  })

  it('reconciles a fully committed crop batch from stored bytes without replacing undo history', async () => {
    const task = snapshot()
    prismaMock.mediaObject.findUnique.mockResolvedValueOnce({ id: 'media-sheet-1', sha256: 'sha-1', updatedAt: 'v1' })
    prismaMock.novelPromotionPanel.findMany.mockResolvedValueOnce(task.cropRects!.map(({ cellIndex, normalizedCropRect }) => ({
      id: `panel-${cellIndex}`, gridCellIndex: cellIndex,
      croppedImageMediaId: `crop-${cellIndex}`, imageMediaId: `crop-${cellIndex}`,
      normalizedCropRect: JSON.stringify(normalizedCropRect),
      imageLineage: JSON.stringify({ taskLineage: buildSixGridTaskDedupeKey(task) }),
      croppedImageMedia: { id: `crop-${cellIndex}`, storageKey: `crop-${cellIndex}.png` },
    })))
    const result = await handleStoryboardCropTask(job(task, TASK_TYPE.STORYBOARD_SHEET_CROP))
    expect(result).toEqual({ storyboardId: 'storyboard-1', mediaIds: Array.from({ length: 6 }, (_, index) => `crop-${index}`), reconciled: true })
    expect(generationMock.getBytes).toHaveBeenCalledTimes(6)
  })
})

function job(payload: SixGridImageTaskSnapshot, type: TaskJobData['type']): Job<TaskJobData> {
  return { data: { taskId: 'task-1', type, locale: 'zh', projectId: 'project-1', episodeId: 'episode-1', targetType: 'NovelPromotionStoryboard', targetId: payload.storyboardId, payload: payload as unknown as Record<string, unknown>, userId: 'user-1' } } as Job<TaskJobData>
}

function resetExecutionMocks() {
  vi.clearAllMocks()
  generationMock.resolve.mockReset().mockResolvedValue('generated-image')
  generationMock.upload.mockReset().mockResolvedValue('images/output.png')
  generationMock.ensureMedia.mockReset().mockResolvedValue({ id: 'output-media', url: '/m/output' })
  generationMock.getBytes.mockReset().mockResolvedValue(Buffer.from('stored'))
  generationMock.normalize.mockReset().mockImplementation(async (values: string[]) => values.map((value) => `normalized:${value}`))
  generationMock.assertActive.mockReset().mockResolvedValue(undefined)
  prismaMock.novelPromotionStoryboard.updateMany.mockReset().mockResolvedValue({ count: 1 })
  prismaMock.novelPromotionPanel.updateMany.mockReset().mockResolvedValue({ count: 1 })
}
