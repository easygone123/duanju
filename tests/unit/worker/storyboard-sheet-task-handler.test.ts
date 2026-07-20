import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from 'bullmq'
import { TASK_TYPE, type TaskJobData } from '@/lib/task/types'
import { narrationSourceKey } from '@/lib/novel-promotion/narration/sync'

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
  toSignedUrlIfCos: (value: string) => value,
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
    expect(buildSixGridTaskDedupeKey({ ...base, analysisModelSnapshot: 'vision-model-1' })).not.toBe(key)
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
  it('rejects a version-4 generation worker after an uploaded sheet advances the storyboard to version 5', async () => {
    const task = snapshot({
      operation: 'generate',
      sourceMediaId: undefined,
      sourceChecksum: undefined,
      sourceVersion: undefined,
      expectedSheetArtifactVersion: 4,
    })
    prismaMock.novelPromotionStoryboard.findFirst.mockResolvedValueOnce({
      id: 'storyboard-1',
      sheetArtifactVersion: 5,
      sheetGenerationOptionsSnapshot: null,
      sheetImageMedia: { id: 'media-uploaded', storageKey: 'owned/uploaded.webp' },
      upscaledSheetImageMedia: null,
    })

    await expect(handleStoryboardSheetTask(job(task, TASK_TYPE.STORYBOARD_SHEET_GENERATE)))
      .rejects.toThrow('SIX_GRID_SHEET_STALE')

    expect(generationMock.resolve).not.toHaveBeenCalled()
    expect(prismaMock.novelPromotionStoryboard.updateMany).not.toHaveBeenCalled()
  })

  it('rejects a stale sheet upscale after upload replaces its snapshotted original', async () => {
    const task = snapshot({
      operation: 'sheet_upscale',
      expectedSheetArtifactVersion: 4,
      workflowId: 'workflow-1',
      workflowVersionId: 'version-1',
      workflowPurpose: 'upscale',
    })
    prismaMock.novelPromotionStoryboard.findFirst.mockResolvedValueOnce({
      id: 'storyboard-1',
      sheetArtifactVersion: 5,
      imageHistory: null,
      sheetImageMedia: {
        id: 'media-uploaded',
        storageKey: 'owned/uploaded.webp',
        sha256: 'uploaded-sha',
        updatedAt: new Date('2026-07-17T00:00:00.000Z'),
      },
      upscaledSheetImageMedia: null,
    })

    await expect(handleStoryboardSheetTask(job(task, TASK_TYPE.STORYBOARD_SHEET_UPSCALE)))
      .rejects.toThrow('SIX_GRID_SHEET_STALE')

    expect(generationMock.resolve).not.toHaveBeenCalled()
    expect(prismaMock.novelPromotionStoryboard.updateMany).not.toHaveBeenCalled()
  })

  it('rejects a stale panel upscale after upload clears the prior crop source', async () => {
    const task = snapshot({
      operation: 'panel_upscale',
      panelId: 'panel-2',
      workflowId: 'workflow-1',
      workflowVersionId: 'version-1',
      workflowPurpose: 'upscale',
    })
    prismaMock.novelPromotionPanel.findFirst.mockResolvedValueOnce({
      id: 'panel-2',
      imageMediaId: null,
      imageUrl: null,
      imageMedia: null,
      upscaledImageMedia: null,
      imageLineage: null,
    })

    await expect(handleStoryboardPanelUpscaleTask(job(task, TASK_TYPE.STORYBOARD_PANEL_UPSCALE)))
      .rejects.toThrow('SIX_GRID_SOURCE_STALE')

    expect(generationMock.resolve).not.toHaveBeenCalled()
    expect(prismaMock.novelPromotionPanel.updateMany).not.toHaveBeenCalled()
  })

  it('rejects a four-grid panel task when its parent storyboard mode or project lineage changed', async () => {
    const task = snapshot({
      operation: 'panel_upscale', panelId: 'panel-2', sourceVersion: '2026-07-13T00:00:00.000Z',
      workflowId: 'workflow-1', workflowVersionId: 'version-1', workflowPurpose: 'upscale',
      gridSpec: {
        version: 1, mode: 'four_grid', columns: 2, rows: 2, panelCount: 4,
        cellAspectRatio: '16:9', sheetAspectRatio: '16:9',
      },
    })
    prismaMock.novelPromotionPanel.findFirst.mockImplementationOnce(async (args: {
      where?: { storyboard?: { is?: { layoutMode?: string; episodeId?: string; episode?: { novelPromotionProject?: { projectId?: string; project?: { userId?: string } } } } } }
    }) => {
      const parent = args?.where?.storyboard?.is
      if (parent?.layoutMode === 'four_grid'
        && parent.episodeId === 'episode-1'
        && parent.episode?.novelPromotionProject?.projectId === 'project-1'
        && parent.episode.novelPromotionProject.project?.userId === 'user-1') return null
      return {
        id: 'panel-2', imageMediaId: 'media-sheet-1', imageUrl: '/m/crop-2',
        upscaledImageMedia: null, imageLineage: null,
        imageMedia: { id: 'media-sheet-1', storageKey: 'owned/crop-2.png', sha256: 'sha-1', updatedAt: new Date('2026-07-13T00:00:00.000Z') },
      }
    })

    await expect(handleStoryboardPanelUpscaleTask(job(task, TASK_TYPE.STORYBOARD_PANEL_UPSCALE)))
      .rejects.toThrow('SIX_GRID_SOURCE_STALE')

    expect(generationMock.resolve).not.toHaveBeenCalled()
    expect(prismaMock.novelPromotionPanel.updateMany).not.toHaveBeenCalled()
  })

  it('revalidates the same grid parent lineage in the final panel upscale CAS', async () => {
    const task = snapshot({
      operation: 'panel_upscale', panelId: 'panel-2', sourceVersion: '2026-07-13T00:00:00.000Z',
      workflowId: 'workflow-1', workflowVersionId: 'version-1', workflowPurpose: 'upscale',
      gridSpec: {
        version: 1, mode: 'four_grid', columns: 2, rows: 2, panelCount: 4,
        cellAspectRatio: '16:9', sheetAspectRatio: '16:9',
      },
    })
    prismaMock.novelPromotionPanel.findFirst.mockResolvedValueOnce({
      id: 'panel-2', imageMediaId: 'media-sheet-1', imageUrl: '/m/crop-2', upscaledImageMedia: null, imageLineage: null,
      imageMedia: { id: 'media-sheet-1', storageKey: 'owned/crop-2.png', sha256: 'sha-1', updatedAt: new Date('2026-07-13T00:00:00.000Z') },
    })
    prismaMock.novelPromotionPanel.updateMany.mockImplementationOnce(async (args?: {
      where?: { storyboard?: { is?: { layoutMode?: string; episodeId?: string; episode?: { novelPromotionProject?: { projectId?: string; project?: { userId?: string } } } } } }
    }) => {
      const parent = args?.where?.storyboard?.is
      return { count: parent?.layoutMode === 'four_grid'
        && parent.episodeId === 'episode-1'
        && parent.episode?.novelPromotionProject?.projectId === 'project-1'
        && parent.episode.novelPromotionProject.project?.userId === 'user-1' ? 0 : 1 }
    })

    await expect(handleStoryboardPanelUpscaleTask(job(task, TASK_TYPE.STORYBOARD_PANEL_UPSCALE)))
      .rejects.toThrow('SIX_GRID_SOURCE_STALE')
    expect(prismaMock.novelPromotionPanel.updateMany).toHaveBeenCalledOnce()
  })

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

  it('does not reconcile a completed sheet through a mismatched task user', async () => {
    const task = snapshot({ operation: 'generate', sourceMediaId: undefined, sourceChecksum: undefined, sourceVersion: undefined })
    const lineage = buildSixGridTaskDedupeKey(task)
    const completed = {
      id: 'storyboard-1', sheetArtifactVersion: 4,
      sheetGenerationOptionsSnapshot: JSON.stringify({ lineage }),
      sheetImageMedia: { id: 'sheet-output', storageKey: 'sheet-output.png' }, upscaledSheetImageMedia: null,
    }
    prismaMock.novelPromotionStoryboard.findFirst.mockImplementationOnce(async (args?: {
      where?: { episode?: { novelPromotionProject?: { project?: { userId?: string } } } }
    }) => {
      const requestedUser = args?.where?.episode?.novelPromotionProject?.project?.userId
      return requestedUser === undefined || requestedUser === 'owner-user' ? completed : null
    })
    const hostileJob = job(task, TASK_TYPE.STORYBOARD_SHEET_GENERATE)
    hostileJob.data.userId = 'attacker-user'

    await expect(handleStoryboardSheetTask(hostileJob)).rejects.toThrow('SIX_GRID_SHEET_STALE')
    expect(generationMock.getBytes).not.toHaveBeenCalled()
    expect(generationMock.resolve).not.toHaveBeenCalled()
    expect(prismaMock.novelPromotionStoryboard.updateMany).not.toHaveBeenCalled()
  })

  it('does not persist a generated sheet through a mismatched project CAS', async () => {
    const task = snapshot({
      operation: 'generate', projectId: 'attacker-project',
      sourceMediaId: undefined, sourceChecksum: undefined, sourceVersion: undefined,
    })
    prismaMock.novelPromotionStoryboard.findFirst.mockResolvedValueOnce({
      id: 'storyboard-1', sheetArtifactVersion: 3, sheetGenerationOptionsSnapshot: null,
      sheetImageMedia: null, upscaledSheetImageMedia: null,
    })
    prismaMock.novelPromotionStoryboard.updateMany.mockImplementationOnce(async (args?: {
      where?: { episode?: { novelPromotionProject?: { projectId?: string } } }
    }) => {
      const requestedProject = args?.where?.episode?.novelPromotionProject?.projectId
      return { count: requestedProject === undefined || requestedProject === 'owner-project' ? 1 : 0 }
    })

    await expect(handleStoryboardSheetTask(job(task, TASK_TYPE.STORYBOARD_SHEET_GENERATE)))
      .rejects.toThrow('SIX_GRID_SHEET_STALE')
    expect(prismaMock.novelPromotionStoryboard.updateMany).toHaveBeenCalledOnce()
    expect(prismaMock.novelPromotionStoryboard.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        episode: { novelPromotionProject: expect.objectContaining({ projectId: 'attacker-project' }) },
      }),
    }))
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
      where: expect.objectContaining({ id: 'storyboard-1', sheetArtifactVersion: 3 }),
      data: expect.objectContaining({ sheetImageMediaId: 'output-media', sheetArtifactVersion: { increment: 1 } }),
    }))
  })

  it('passes the snapshotted character and location references into complete-sheet generation', async () => {
    const task = snapshot({
      operation: 'generate', sourceMediaId: undefined, sourceChecksum: undefined, sourceVersion: undefined,
      referenceImages: [
        { source: '/api/storage/sign?key=characters%2Fhero.png', kind: 'character', name: 'Hero' },
        { source: '/api/storage/sign?key=locations%2Fcafe.png', kind: 'location', name: 'Cafe' },
      ],
    })
    prismaMock.novelPromotionStoryboard.findFirst.mockResolvedValueOnce({
      id: 'storyboard-1', sheetArtifactVersion: 3, sheetGenerationOptionsSnapshot: null,
      sheetImageMedia: null, upscaledSheetImageMedia: null,
    })

    await handleStoryboardSheetTask(job(task, TASK_TYPE.STORYBOARD_SHEET_GENERATE))

    expect(generationMock.normalize).toHaveBeenCalledWith([
      '/api/storage/sign?key=characters%2Fhero.png',
      '/api/storage/sign?key=locations%2Fcafe.png',
    ])
    expect(generationMock.resolve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      prompt: expect.stringContaining('REFERENCE_IMAGE_MAPPING='),
      comfyReferenceImages: [
        '/api/storage/sign?key=characters%2Fhero.png',
        '/api/storage/sign?key=locations%2Fcafe.png',
      ],
      options: expect.objectContaining({
        referenceImages: [
          'normalized:/api/storage/sign?key=characters%2Fhero.png',
          'normalized:/api/storage/sign?key=locations%2Fcafe.png',
        ],
      }),
    }))
  })

  it('reuses the durable ComfyUI sheet output instead of downloading it through the app', async () => {
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
    generationMock.resolve.mockResolvedValueOnce('comfyui/user-1/project-1/result.png')

    await handleStoryboardSheetTask(job(task, TASK_TYPE.STORYBOARD_SHEET_GENERATE))

    expect(generationMock.resolve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      preferComfyStorageKey: true,
    }))
    expect(generationMock.upload).not.toHaveBeenCalled()
    expect(generationMock.ensureMedia).toHaveBeenCalledWith('comfyui/user-1/project-1/result.png')
  })

  it('uploads a ComfyUI URL fallback instead of persisting it as a storage key', async () => {
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
    generationMock.resolve.mockResolvedValueOnce('https://store.example/result.png')

    await handleStoryboardSheetTask(job(task, TASK_TYPE.STORYBOARD_SHEET_GENERATE))

    expect(generationMock.upload).toHaveBeenCalledWith(
      'https://store.example/result.png', 'storyboard-sheet', 'storyboard-1',
    )
    expect(generationMock.ensureMedia).toHaveBeenCalledWith('images/output.png')
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
    expect(prismaMock.novelPromotionStoryboard.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'storyboard-1', sheetArtifactVersion: 3 }),
    }))
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
  it('crops and commits exactly four cells against the immutable four-grid lineage', async () => {
    const fourGridSpec = {
      version: 1 as const, mode: 'four_grid' as const, columns: 2 as const, rows: 2 as const,
      panelCount: 4 as const, cellAspectRatio: '16:9' as const, sheetAspectRatio: '16:9' as const,
    }
    const cropRects = Array.from({ length: 4 }, (_, cellIndex) => ({
      cellIndex,
      normalizedCropRect: {
        x: (cellIndex % 2) / 2,
        y: Math.floor(cellIndex / 2) / 2,
        width: 0.5,
        height: 0.5,
      },
    }))
    const crop = vi.fn(async () => cropRects.map(({ cellIndex, normalizedCropRect }) => ({
      cellIndex, mediaId: `crop-${cellIndex}`, url: `/m/crop-${cellIndex}`,
      normalizedCropRect, lineage: { sourceMediaId: 'media-sheet-1', artifactVersion: 1 },
    })))
    const lockStoryboard = vi.fn(async () => true)
    const update = vi.fn(async () => ({}))
    const transaction = async (callback: (tx: unknown) => Promise<void>) => callback({
      lockStoryboard,
      novelPromotionPanel: {
        findMany: vi.fn(async () => Array.from({ length: 4 }, (_, gridCellIndex) => ({
          id: `panel-${gridCellIndex}`, gridCellIndex, imageMediaId: null, imageUrl: null,
        }))),
        update,
      },
    })
    const task = Object.assign(snapshot({ gridSpec: fourGridSpec, cropRects }), {
      cropRectSource: 'auto' as const,
    })
    const { executeSixGridCrop } = await import('@/lib/workers/handlers/storyboard-crop-task-handler')

    await executeSixGridCrop(task, {
      userId: 'user-1', crop: crop as never, transaction: transaction as never,
    })

    expect(crop).toHaveBeenCalledWith(expect.objectContaining({
      storyboardId: 'storyboard-1',
      expectedSheetArtifactVersion: 3,
      gridSpec: fourGridSpec,
      cropRectSource: 'auto',
      manualOverrides: undefined,
    }))
    expect(lockStoryboard).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'four_grid', projectId: 'project-1', episodeId: 'episode-1', userId: 'user-1',
    }))
    expect(update).toHaveBeenCalledTimes(4)
  })

  it('directly crops the uploaded original at version 5', async () => {
    const crop = vi.fn(async () => Array.from({ length: 6 }, (_, cellIndex) => ({
      cellIndex,
      mediaId: `crop-${cellIndex}`,
      url: `/m/crop-${cellIndex}`,
      normalizedCropRect: snapshot().cropRects![cellIndex]!.normalizedCropRect,
      lineage: { sourceMediaId: 'media-uploaded', artifactVersion: 1 },
    })))
    const lockStoryboard = vi.fn(async () => true)
    const transaction = async (callback: (tx: unknown) => Promise<void>) => callback({
      lockStoryboard,
      novelPromotionPanel: {
        findMany: vi.fn(async () => Array.from({ length: 6 }, (_, gridCellIndex) => ({
          id: `panel-${gridCellIndex}`,
          gridCellIndex,
          imageMediaId: null,
          imageUrl: null,
        }))),
        update: vi.fn(async () => ({})),
      },
    })
    const task = Object.assign(snapshot({
      sourceMediaId: 'media-uploaded',
      sourceChecksum: 'uploaded-sha',
      sourceVersion: '2026-07-17T00:00:00.000Z',
      expectedSheetArtifactVersion: 5,
      processingOrder: 'crop_then_panel_upscale',
    }), { cropRectSource: 'auto' as const })
    const { executeSixGridCrop } = await import('@/lib/workers/handlers/storyboard-crop-task-handler')

    await executeSixGridCrop(task, {
      userId: 'user-1',
      crop: crop as never,
      transaction: transaction as never,
    })

    expect(crop).toHaveBeenCalledWith(expect.objectContaining({
      sourceMediaId: 'media-uploaded', cropRectSource: 'auto', manualOverrides: undefined,
    }))
    expect(lockStoryboard).toHaveBeenCalledWith(expect.objectContaining({
      storyboardId: 'storyboard-1',
      sourceMediaId: 'media-uploaded',
      expectedSheetArtifactVersion: 5,
      processingOrder: 'crop_then_panel_upscale',
    }))
  })

  it('crops the newly upscaled uploaded sheet instead of its original', async () => {
    const crop = vi.fn(async () => Array.from({ length: 6 }, (_, cellIndex) => ({
      cellIndex,
      mediaId: `crop-${cellIndex}`,
      url: `/m/crop-${cellIndex}`,
      normalizedCropRect: snapshot().cropRects![cellIndex]!.normalizedCropRect,
      lineage: { sourceMediaId: 'media-uploaded-upscaled', artifactVersion: 1 },
    })))
    const lockStoryboard = vi.fn(async () => true)
    const transaction = async (callback: (tx: unknown) => Promise<void>) => callback({
      lockStoryboard,
      novelPromotionPanel: {
        findMany: vi.fn(async () => Array.from({ length: 6 }, (_, gridCellIndex) => ({
          id: `panel-${gridCellIndex}`,
          gridCellIndex,
          imageMediaId: null,
          imageUrl: null,
        }))),
        update: vi.fn(async () => ({})),
      },
    })
    const task = snapshot({
      sourceMediaId: 'media-uploaded-upscaled',
      sourceChecksum: 'upscaled-sha',
      sourceVersion: '2026-07-17T00:01:00.000Z',
      expectedSheetArtifactVersion: 6,
      processingOrder: 'sheet_upscale_then_crop',
    })
    const { executeSixGridCrop } = await import('@/lib/workers/handlers/storyboard-crop-task-handler')

    await executeSixGridCrop(task, {
      userId: 'user-1',
      crop: crop as never,
      transaction: transaction as never,
    })

    expect(crop).toHaveBeenCalledWith(expect.objectContaining({ sourceMediaId: 'media-uploaded-upscaled' }))
    expect(lockStoryboard).toHaveBeenCalledWith(expect.objectContaining({
      storyboardId: 'storyboard-1',
      sourceMediaId: 'media-uploaded-upscaled',
      expectedSheetArtifactVersion: 6,
      processingOrder: 'sheet_upscale_then_crop',
    }))
  })

  it('rejects a stale crop after upload advances to version 5 and replaces the source', async () => {
    const uploadedState = { sheetArtifactVersion: 5, sheetImageMediaId: 'media-uploaded' }
    const lockStoryboard = vi.fn(async (fence: {
      sourceMediaId: string
      expectedSheetArtifactVersion: number
    }) => fence.expectedSheetArtifactVersion === uploadedState.sheetArtifactVersion
      && fence.sourceMediaId === uploadedState.sheetImageMediaId)
    const findMany = vi.fn(async () => Array.from({ length: 6 }, (_, gridCellIndex) => ({
      id: `panel-${gridCellIndex}`,
      gridCellIndex,
      imageMediaId: `old-${gridCellIndex}`,
      imageUrl: `/m/old-${gridCellIndex}`,
    })))
    const update = vi.fn(async () => ({}))
    const transaction = async (callback: (tx: unknown) => Promise<void>) => callback({
      lockStoryboard,
      novelPromotionPanel: { findMany, update },
    })
    const artifacts = Array.from({ length: 6 }, (_, cellIndex) => ({
      cellIndex,
      mediaId: `crop-${cellIndex}`,
      url: `/m/crop-${cellIndex}`,
      normalizedCropRect: snapshot().cropRects![cellIndex]!.normalizedCropRect,
      lineage: { sourceMediaId: 'media-sheet-1', artifactVersion: 1 },
    }))

    await expect(commitSixGridCropBatch({
      storyboardId: 'storyboard-1',
      sourceMediaId: 'media-sheet-1',
      expectedSheetArtifactVersion: 4,
      processingOrder: 'crop_then_panel_upscale',
      taskLineage: 'crop-task-lineage',
      artifacts,
    }, { transaction: transaction as never })).rejects.toThrow('SIX_GRID_SOURCE_STALE')

    expect(lockStoryboard).toHaveBeenCalledWith(expect.objectContaining({
      sourceMediaId: 'media-sheet-1',
      expectedSheetArtifactVersion: 4,
    }))
    expect(findMany).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('serializes upload behind a crop-owned storyboard lock so upload clears the committed crop', async () => {
    const state = {
      sheetArtifactVersion: 3,
      sheetImageMediaId: 'media-sheet-1',
      panels: Array.from({ length: 6 }, (_, gridCellIndex) => ({
        id: `panel-${gridCellIndex}`,
        gridCellIndex,
        imageMediaId: `old-${gridCellIndex}` as string | null,
        imageUrl: `/m/old-${gridCellIndex}` as string | null,
      })),
    }
    const events: string[] = []
    let mutexTail = Promise.resolve()
    const acquireStoryboardLock = async () => {
      let release = () => {}
      const held = new Promise<void>((resolve) => { release = resolve })
      const previous = mutexTail
      mutexTail = previous.then(() => held)
      await previous
      return release
    }
    let signalCropLocked = () => {}
    const cropLocked = new Promise<void>((resolve) => { signalCropLocked = resolve })
    let allowCropPanelRead = () => {}
    const cropMayReadPanels = new Promise<void>((resolve) => { allowCropPanelRead = resolve })
    const transaction = async (callback: (tx: unknown) => Promise<void>) => {
      let releaseLock: (() => void) | undefined
      let cropOwnsLock = false
      try {
        await callback({
          lockStoryboard: async (fence: {
            storyboardId: string
            sourceMediaId: string
            expectedSheetArtifactVersion: number
          }) => {
            releaseLock = await acquireStoryboardLock()
            cropOwnsLock = fence.storyboardId === 'storyboard-1'
              && state.sheetArtifactVersion === fence.expectedSheetArtifactVersion
              && state.sheetImageMediaId === fence.sourceMediaId
            events.push('crop-lock')
            signalCropLocked()
            return cropOwnsLock
          },
          novelPromotionPanel: {
            findMany: async () => {
              if (!cropOwnsLock) throw new Error('PANEL_READ_WITHOUT_STORYBOARD_LOCK')
              events.push('crop-panel-read')
              await cropMayReadPanels
              return structuredClone(state.panels)
            },
            update: async (args: { where: { id: string }; data: { imageMediaId: string; imageUrl: string } }) => {
              if (!cropOwnsLock) throw new Error('PANEL_WRITE_WITHOUT_STORYBOARD_LOCK')
              const panel = state.panels.find((item) => item.id === args.where.id)
              if (!panel) throw new Error('PANEL_NOT_FOUND')
              panel.imageMediaId = args.data.imageMediaId
              panel.imageUrl = args.data.imageUrl
              events.push(`crop-write:${panel.gridCellIndex}`)
            },
          },
        })
      } finally {
        releaseLock?.()
      }
    }
    const artifacts = Array.from({ length: 6 }, (_, cellIndex) => ({
      cellIndex,
      mediaId: `crop-${cellIndex}`,
      url: `/m/crop-${cellIndex}`,
      normalizedCropRect: snapshot().cropRects![cellIndex]!.normalizedCropRect,
      lineage: { sourceMediaId: 'media-sheet-1', artifactVersion: 1 },
    }))

    const crop = commitSixGridCropBatch({
      storyboardId: 'storyboard-1',
      sourceMediaId: 'media-sheet-1',
      expectedSheetArtifactVersion: 3,
      processingOrder: 'crop_then_panel_upscale',
      taskLineage: 'crop-task-lineage',
      artifacts,
    }, { transaction: transaction as never })
    await cropLocked

    let uploadSettled = false
    const upload = (async () => {
      const releaseLock = await acquireStoryboardLock()
      try {
        events.push('upload-replace')
        state.sheetArtifactVersion += 1
        state.sheetImageMediaId = 'media-uploaded'
        for (const panel of state.panels) {
          panel.imageMediaId = null
          panel.imageUrl = null
        }
      } finally {
        releaseLock()
        uploadSettled = true
      }
    })()
    await Promise.resolve()
    expect(uploadSettled).toBe(false)

    allowCropPanelRead()
    await Promise.all([crop, upload])

    expect(state.sheetArtifactVersion).toBe(4)
    expect(state.sheetImageMediaId).toBe('media-uploaded')
    expect(state.panels.every((panel) => panel.imageMediaId === null && panel.imageUrl === null)).toBe(true)
    expect(events.indexOf('upload-replace')).toBeGreaterThan(events.indexOf('crop-write:5'))
  })

  it('switches all six panels in one transaction without changing dialogue or duration', async () => {
    const lockStoryboard = vi.fn(async () => true)
    const update = vi.fn(async () => ({}))
    const findMany = vi.fn(async () => Array.from({ length: 6 }, (_, gridCellIndex) => ({ id: `panel-${gridCellIndex}`, gridCellIndex, imageMediaId: `old-${gridCellIndex}`, imageUrl: `/m/old-${gridCellIndex}` })))
    const transaction = vi.fn(async (callback: (tx: { lockStoryboard: typeof lockStoryboard; novelPromotionPanel: { update: typeof update; findMany: typeof findMany } }) => Promise<void>) => {
      await callback({ lockStoryboard, novelPromotionPanel: { update, findMany } })
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
    }, { transaction: transaction as never })

    expect(transaction).toHaveBeenCalledTimes(1)
    expect(lockStoryboard.mock.invocationCallOrder[0]).toBeLessThan(findMany.mock.invocationCallOrder[0]!)
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

  it('binds four analyzed prompts and durations to their matching crop cells atomically', async () => {
    const fourGridSpec = {
      version: 1 as const, mode: 'four_grid' as const, columns: 2 as const, rows: 2 as const,
      panelCount: 4 as const, cellAspectRatio: '16:9' as const, sheetAspectRatio: '16:9' as const,
    }
    const fixture = createAtomicNarrationCropFixture()
    const artifacts = Array.from({ length: 4 }, (_, cellIndex) => ({
      cellIndex,
      mediaId: `crop-${cellIndex}`,
      url: `/m/crop-${cellIndex}`,
      normalizedCropRect: {
        x: (cellIndex % 2) / 2, y: Math.floor(cellIndex / 2) / 2, width: 0.5, height: 0.5,
      },
      lineage: { sourceMediaId: 'media-sheet-1', artifactVersion: 1 },
    }))
    const panelAnalysis = artifacts.map((_, index) => ({
      panel_number: index + 1,
      description: `actual cell ${index + 1}`,
      image_prompt: `image ${index + 1}`,
      video_prompt: `video ${index + 1}`,
      duration: index + 1.5,
      shot_type: '中景',
      camera_move: '固定',
      narration_recommended: index === 0,
      narration_text: index === 0 ? 'A year passed.' : null,
      narration_emotion: index === 0 ? 'reflective' : null,
    }))

    await commitSixGridCropBatch({
      storyboardId: 'storyboard-1',
      sourceMediaId: 'media-sheet-1',
      expectedSheetArtifactVersion: 3,
      processingOrder: 'crop_then_panel_upscale',
      taskLineage: 'crop-task-lineage',
      gridSpec: fourGridSpec,
      episodeId: 'episode-1',
      locale: 'en',
      artifacts,
      panelAnalysis,
    }, { transaction: fixture.transaction as never })

    expect(fixture.update).toHaveBeenCalledTimes(4)
    expect(fixture.update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { id: 'panel-0' },
      data: expect.objectContaining({
        imageMediaId: 'crop-0',
        description: 'actual cell 1',
        imagePrompt: 'image 1',
        videoPrompt: 'video 1',
        duration: 1.5,
        estimatedDuration: 1.5,
        narrationRecommended: true,
        narrationSuggestedText: 'A year passed.',
        narrationSuggestedEmotion: 'reflective',
      }),
    }))
    expect(fixture.update).toHaveBeenNthCalledWith(4, expect.objectContaining({
      where: { id: 'panel-3' },
      data: expect.objectContaining({ imageMediaId: 'crop-3', videoPrompt: 'video 4', duration: 4.5 }),
    }))
    expect(fixture.state.voiceLines).toEqual([
      expect.objectContaining({
        sourceKey: narrationSourceKey('panel-0'),
        enabled: true,
        speaker: 'Narrator',
        content: 'A year passed.',
        emotionPrompt: 'reflective',
      }),
    ])
  })

  it('disables an existing automatic narration when analysis no longer recommends it without replacing its projection', async () => {
    const fixture = createAtomicNarrationCropFixture({
      voiceLines: [narrationVoice({
        sourceKey: narrationSourceKey('panel-0'),
        content: 'Earlier automatic narration',
        emotionPrompt: 'calm',
        audioUrl: '/m/narration.wav',
      })],
    })

    await commitFourGridNarrationFixture(fixture, [analysisNarration(false), ...Array.from({ length: 3 }, () => analysisNarration(false))])

    expect(fixture.state.panels[0]).toMatchObject({
      narrationRecommended: false,
      narrationSuggestedText: null,
      narrationSuggestedEmotion: null,
    })
    expect(fixture.state.voiceLines[0]).toMatchObject({
      enabled: false,
      content: 'Earlier automatic narration',
      emotionPrompt: 'calm',
      audioUrl: '/m/narration.wav',
    })
  })

  it('preserves manual narration fields and resolves on/off modes from the manual projection', async () => {
    const fixture = createAtomicNarrationCropFixture({
      panels: [
        cropPanel({ id: 'panel-0', panelIndex: 0, gridCellIndex: 0, narrationMode: 'on', narrationText: 'Manual on', narrationEmotion: 'urgent' }),
        cropPanel({ id: 'panel-1', panelIndex: 1, gridCellIndex: 1, narrationMode: 'off', narrationText: 'Manual off', narrationEmotion: 'solemn' }),
        cropPanel({ id: 'panel-2', panelIndex: 2, gridCellIndex: 2 }),
        cropPanel({ id: 'panel-3', panelIndex: 3, gridCellIndex: 3 }),
      ],
      voiceLines: [narrationVoice({
        sourceKey: narrationSourceKey('panel-1'),
        matchedPanelId: 'panel-1',
        matchedPanelIndex: 1,
        content: 'Existing disabled projection',
        emotionPrompt: 'existing',
      })],
    })

    await commitFourGridNarrationFixture(fixture, Array.from({ length: 4 }, () => analysisNarration(false)))

    expect(fixture.state.panels[0]).toMatchObject({ narrationText: 'Manual on', narrationEmotion: 'urgent' })
    expect(fixture.state.panels[1]).toMatchObject({ narrationText: 'Manual off', narrationEmotion: 'solemn' })
    expect(fixture.state.voiceLines.find((line) => line.sourceKey === narrationSourceKey('panel-0'))).toMatchObject({
      enabled: true,
      content: 'Manual on',
      emotionPrompt: 'urgent',
    })
    expect(fixture.state.voiceLines.find((line) => line.sourceKey === narrationSourceKey('panel-1'))).toMatchObject({
      enabled: false,
      content: 'Existing disabled projection',
      emotionPrompt: 'existing',
    })
  })

  it('keeps narration disabled when the canonical panel has dialogue', async () => {
    const fixture = createAtomicNarrationCropFixture({
      panels: [
        cropPanel({ id: 'panel-0', panelIndex: 0, gridCellIndex: 0, hasDialogue: true, narrationMode: 'on', narrationText: 'Manual narration' }),
        cropPanel({ id: 'panel-1', panelIndex: 1, gridCellIndex: 1 }),
        cropPanel({ id: 'panel-2', panelIndex: 2, gridCellIndex: 2 }),
        cropPanel({ id: 'panel-3', panelIndex: 3, gridCellIndex: 3 }),
      ],
    })

    await commitFourGridNarrationFixture(fixture, Array.from({ length: 4 }, () => analysisNarration(false)))

    expect(fixture.state.voiceLines.find((line) => line.sourceKey === narrationSourceKey('panel-0')))
      .toMatchObject({ enabled: false, content: 'Manual narration' })
  })

  it.each([
    ['panel update', { failPanelId: 'panel-2' }],
    ['narration sync', { failVoicePanelId: 'panel-2' }],
  ])('rolls back every crop and narration mutation when a %s fails', async (_label, options) => {
    const fixture = createAtomicNarrationCropFixture(options)

    await expect(commitFourGridNarrationFixture(
      fixture,
      Array.from({ length: 4 }, () => analysisNarration(true)),
    )).rejects.toThrow(options.failPanelId ? 'PANEL_WRITE_FAILED' : 'VOICE_SYNC_FAILED')

    expect(fixture.state.panels.every((panel) => panel.imageMediaId === null)).toBe(true)
    expect(fixture.state.panels.every((panel) => panel.narrationSuggestedText === null)).toBe(true)
    expect(fixture.state.voiceLines).toEqual([])
  })

  it('requires locale only when four-grid analysis is supplied', async () => {
    const fixture = createAtomicNarrationCropFixture()
    const input = fourGridNarrationCommitInput(Array.from({ length: 4 }, () => analysisNarration(false)))

    await expect(commitSixGridCropBatch({ ...input, locale: undefined }, { transaction: fixture.transaction as never }))
      .rejects.toThrow('FOUR_GRID_NARRATION_LOCALE_REQUIRED')
    expect(fixture.transaction).not.toHaveBeenCalled()

    await expect(commitSixGridCropBatch(
      { ...input, episodeId: undefined },
      { transaction: fixture.transaction as never },
    )).resolves.toBeUndefined()

    const sixGridFixture = createAtomicNarrationCropFixture({
      panels: Array.from({ length: 6 }, (_, index) => cropPanel({ id: `panel-${index}`, panelIndex: index, gridCellIndex: index })),
    })
    await commitSixGridCropBatch({
      storyboardId: 'storyboard-1',
      sourceMediaId: 'media-sheet-1',
      expectedSheetArtifactVersion: 3,
      processingOrder: 'crop_then_panel_upscale',
      taskLineage: 'crop-task-lineage',
      artifacts: sixGridArtifacts(),
    }, { transaction: sixGridFixture.transaction as never })
    expect(sixGridFixture.voiceCreate).not.toHaveBeenCalled()
    expect(sixGridFixture.voiceUpdate).not.toHaveBeenCalled()
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

  it('does not reconcile committed crops through a mismatched task user', async () => {
    const task = snapshot()
    const committed = task.cropRects!.map(({ cellIndex }) => ({
      gridCellIndex: cellIndex,
      croppedImageMediaId: `crop-${cellIndex}`,
      imageMediaId: `crop-${cellIndex}`,
      imageLineage: JSON.stringify({ taskLineage: buildSixGridTaskDedupeKey(task) }),
      croppedImageMedia: { id: `crop-${cellIndex}`, storageKey: `crop-${cellIndex}.png` },
    }))
    prismaMock.mediaObject.findUnique.mockResolvedValueOnce({ id: 'media-sheet-1', sha256: 'sha-1', updatedAt: 'v1' })
    prismaMock.novelPromotionPanel.findMany.mockImplementationOnce(async (args?: {
      where?: { storyboard?: { is?: { episode?: { novelPromotionProject?: { project?: { userId?: string } } } } } }
    }) => {
      const requestedUser = args?.where?.storyboard?.is?.episode?.novelPromotionProject?.project?.userId
      return requestedUser === undefined || requestedUser === 'owner-user' ? committed : []
    })
    const hostileJob = job(task, TASK_TYPE.STORYBOARD_SHEET_CROP)
    hostileJob.data.userId = 'attacker-user'
    generationMock.assertActive.mockImplementation(async (_job, stage) => {
      if (stage === 'six_grid_crop_before_crop') throw new Error('RECONCILIATION_REJECTED')
    })

    await expect(handleStoryboardCropTask(hostileJob)).rejects.toThrow('RECONCILIATION_REJECTED')
    expect(generationMock.getBytes).not.toHaveBeenCalled()
  })
})

type CropPanelFixtureRow = {
  id: string
  storyboardId: string
  storyboard: { episodeId: string }
  panelIndex: number
  gridCellIndex: number
  imageMediaId: string | null
  imageUrl: string | null
  hasDialogue: boolean
  narrationMode: string
  narrationRecommended: boolean
  narrationSuggestedText: string | null
  narrationSuggestedEmotion: string | null
  narrationText: string | null
  narrationEmotion: string | null
  [key: string]: unknown
}

type NarrationVoiceFixtureRow = {
  id: string
  episodeId: string
  lineIndex: number
  lineType: string
  enabled: boolean
  sourceKey: string | null
  speaker: string
  content: string
  emotionPrompt: string | null
  matchedPanelId: string | null
  matchedStoryboardId: string | null
  matchedPanelIndex: number | null
  audioUrl: string | null
  [key: string]: unknown
}

function cropPanel(overrides: Partial<CropPanelFixtureRow> = {}): CropPanelFixtureRow {
  return {
    id: 'panel-0',
    storyboardId: 'storyboard-1',
    storyboard: { episodeId: 'episode-1' },
    panelIndex: 0,
    gridCellIndex: 0,
    imageMediaId: null,
    imageUrl: null,
    hasDialogue: false,
    narrationMode: 'auto',
    narrationRecommended: false,
    narrationSuggestedText: null,
    narrationSuggestedEmotion: null,
    narrationText: null,
    narrationEmotion: null,
    ...overrides,
  }
}

function narrationVoice(overrides: Partial<NarrationVoiceFixtureRow> = {}): NarrationVoiceFixtureRow {
  return {
    id: 'voice-1',
    episodeId: 'episode-1',
    lineIndex: 1,
    lineType: 'narration',
    enabled: true,
    sourceKey: narrationSourceKey('panel-0'),
    speaker: 'Narrator',
    content: 'Existing narration',
    emotionPrompt: null,
    matchedPanelId: 'panel-0',
    matchedStoryboardId: 'storyboard-1',
    matchedPanelIndex: 0,
    audioUrl: null,
    ...overrides,
  }
}

function analysisNarration(recommended: boolean) {
  return {
    description: 'actual cell',
    image_prompt: 'grounded image',
    video_prompt: 'grounded video',
    duration: 2,
    shot_type: '中景',
    camera_move: '固定',
    narration_recommended: recommended,
    narration_text: recommended ? 'Suggested narration' : null,
    narration_emotion: recommended ? 'reflective' : null,
  }
}

function fourGridNarrationCommitInput(rows: ReturnType<typeof analysisNarration>[]) {
  return {
    storyboardId: 'storyboard-1',
    sourceMediaId: 'media-sheet-1',
    expectedSheetArtifactVersion: 3,
    processingOrder: 'crop_then_panel_upscale' as const,
    taskLineage: 'crop-task-lineage',
    gridSpec: {
      version: 1 as const,
      mode: 'four_grid' as const,
      columns: 2 as const,
      rows: 2 as const,
      panelCount: 4 as const,
      cellAspectRatio: '16:9' as const,
      sheetAspectRatio: '16:9' as const,
    },
    episodeId: 'episode-1',
    locale: 'en' as const,
    artifacts: sixGridArtifacts(4),
    panelAnalysis: rows.map((row, index) => ({ panel_number: index + 1, ...row })),
  }
}

async function commitFourGridNarrationFixture(
  fixture: ReturnType<typeof createAtomicNarrationCropFixture>,
  rows: ReturnType<typeof analysisNarration>[],
) {
  return await commitSixGridCropBatch(
    fourGridNarrationCommitInput(rows),
    { transaction: fixture.transaction as never },
  )
}

function sixGridArtifacts(panelCount = 6) {
  return Array.from({ length: panelCount }, (_, cellIndex) => ({
    cellIndex,
    mediaId: `crop-${cellIndex}`,
    url: `/m/crop-${cellIndex}`,
    normalizedCropRect: panelCount === 4
      ? { x: (cellIndex % 2) / 2, y: Math.floor(cellIndex / 2) / 2, width: 0.5, height: 0.5 }
      : snapshot().cropRects![cellIndex]!.normalizedCropRect,
    lineage: { sourceMediaId: 'media-sheet-1', artifactVersion: 1 },
  }))
}

function createAtomicNarrationCropFixture(options: {
  panels?: CropPanelFixtureRow[]
  voiceLines?: NarrationVoiceFixtureRow[]
  failPanelId?: string
  failVoicePanelId?: string
} = {}) {
  const state = {
    panels: structuredClone(options.panels ?? Array.from({ length: 4 }, (_, index) => cropPanel({
      id: `panel-${index}`,
      panelIndex: index,
      gridCellIndex: index,
    }))),
    voiceLines: structuredClone(options.voiceLines ?? []),
  }
  let nextVoiceId = state.voiceLines.length + 1
  const update = vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    if (where.id === options.failPanelId) throw new Error('PANEL_WRITE_FAILED')
    const panel = state.panels.find((row) => row.id === where.id)
    if (!panel) throw new Error('PANEL_NOT_FOUND')
    Object.assign(panel, data)
    return structuredClone(panel)
  })
  const voiceCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    if (data.matchedPanelId === options.failVoicePanelId) throw new Error('VOICE_SYNC_FAILED')
    const created = narrationVoice({
      ...(data as Partial<NarrationVoiceFixtureRow>),
      id: `voice-${nextVoiceId++}`,
    })
    state.voiceLines.push(created)
    return { id: created.id }
  })
  const voiceUpdate = vi.fn(async ({ where, data }: {
    where: { id?: string; sourceKey?: string }
    data: Record<string, unknown>
  }) => {
    const row = state.voiceLines.find((candidate) => (
      (where.id && candidate.id === where.id)
      || (where.sourceKey && candidate.sourceKey === where.sourceKey)
    ))
    if (!row) throw { code: 'P2025' }
    if (row.matchedPanelId === options.failVoicePanelId) throw new Error('VOICE_SYNC_FAILED')
    Object.assign(row, data)
    return { id: row.id }
  })
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<void>) => {
    const before = structuredClone(state)
    try {
      await callback({
        lockStoryboard: vi.fn(async () => true),
        novelPromotionPanel: {
          findMany: vi.fn(async () => structuredClone(state.panels)),
          findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
            const panel = state.panels.find((row) => row.id === where.id)
            return panel ? { hasDialogue: panel.hasDialogue } : null
          }),
          update,
        },
        novelPromotionVoiceLine: {
          findUnique: vi.fn(async ({ where }: { where: { sourceKey: string } }) => {
            const row = state.voiceLines.find((candidate) => candidate.sourceKey === where.sourceKey)
            return row ? { id: row.id } : null
          }),
          aggregate: vi.fn(async ({ where }: { where: { episodeId: string } }) => ({
            _max: {
              lineIndex: state.voiceLines
                .filter((row) => row.episodeId === where.episodeId)
                .reduce<number | null>((max, row) => max === null ? row.lineIndex : Math.max(max, row.lineIndex), null),
            },
          })),
          create: voiceCreate,
          update: voiceUpdate,
        },
      })
    } catch (error) {
      state.panels = before.panels
      state.voiceLines = before.voiceLines
      throw error
    }
  })
  return { state, transaction, update, voiceCreate, voiceUpdate }
}

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
