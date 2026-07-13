import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { callRoute } from '../helpers/call-route'

const submitTaskMock = vi.hoisted(() => vi.fn(async () => ({ success: true, taskId: 'task-1' })))
const authMock = vi.hoisted(() => vi.fn(async () => ({ session: { user: { id: 'user-1' } } })))
const prismaMock = vi.hoisted(() => ({
  novelPromotionStoryboard: { findFirst: vi.fn() },
  novelPromotionPanel: { findFirst: vi.fn(), updateMany: vi.fn() },
  comfyWorkflow: { findFirst: vi.fn() },
  $transaction: vi.fn(),
}))
const capabilityMock = vi.hoisted(() => vi.fn(async () => ({ aspectRatio: '8:3' })))

vi.mock('bullmq', () => ({
  Queue: class { add() { return Promise.resolve({ id: 'job' }) } getJob() { return Promise.resolve(null) } },
}))
vi.mock('@/lib/redis', () => ({ queueRedis: {} }))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/task/submitter', () => ({ submitTask: submitTaskMock }))
vi.mock('@/lib/api-auth', () => ({
  requireProjectAuthLight: authMock,
  isErrorResponse: (value: unknown) => value instanceof Response,
}))
vi.mock('@/lib/config-service', () => ({ resolveProjectImageTaskGenerationOptions: capabilityMock }))
import { TASK_TYPE } from '@/lib/task/types'
import { getQueueTypeByTaskType } from '@/lib/task/queues'
import { resolveTaskIntent } from '@/lib/task/intent'
import { getTaskTypeLabel } from '@/lib/task/progress-message'
import { isBillableTaskType } from '@/lib/billing'

describe('six-grid route/task registration contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authMock.mockResolvedValue({ session: { user: { id: 'user-1' } } })
    prismaMock.novelPromotionStoryboard.findFirst.mockResolvedValue(storyboardFixture())
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflowFixture())
    prismaMock.novelPromotionPanel.findFirst.mockResolvedValue({
      id: 'panel-1', imageMediaId: 'current-1', imageUrl: '/current.webp',
      previousImageMediaId: 'previous-1', previousImageUrl: '/previous.webp',
      croppedImageMediaId: 'previous-1', upscaledImageMediaId: 'current-1',
    })
    prismaMock.novelPromotionPanel.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.$transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback(prismaMock))
    capabilityMock.mockResolvedValue({ aspectRatio: '8:3' })
  })
  it('registers all four operations as image tasks with stable intents and labels', () => {
    const tasks = [
      TASK_TYPE.STORYBOARD_SHEET_GENERATE,
      TASK_TYPE.STORYBOARD_SHEET_UPSCALE,
      TASK_TYPE.STORYBOARD_SHEET_CROP,
      TASK_TYPE.STORYBOARD_PANEL_UPSCALE,
    ]
    expect(tasks.every((task) => getQueueTypeByTaskType(task) === 'image')).toBe(true)
    expect(resolveTaskIntent(TASK_TYPE.STORYBOARD_SHEET_GENERATE)).toBe('generate')
    expect(resolveTaskIntent(TASK_TYPE.STORYBOARD_SHEET_UPSCALE)).toBe('process')
    expect(resolveTaskIntent(TASK_TYPE.STORYBOARD_SHEET_CROP)).toBe('process')
    expect(resolveTaskIntent(TASK_TYPE.STORYBOARD_PANEL_UPSCALE)).toBe('process')
    expect(tasks.every((task) => getTaskTypeLabel(task) !== 'progress.taskType.generic')).toBe(true)
    expect(isBillableTaskType(TASK_TYPE.STORYBOARD_SHEET_GENERATE)).toBe(true)
    expect(isBillableTaskType(TASK_TYPE.STORYBOARD_SHEET_CROP)).toBe(false)
    expect(isBillableTaskType(TASK_TYPE.STORYBOARD_SHEET_UPSCALE)).toBe(false)
    expect(isBillableTaskType(TASK_TYPE.STORYBOARD_PANEL_UPSCALE)).toBe(false)
  })

  it('exports the three strict POST endpoints', async () => {
    const [sheet, crop, panel] = await Promise.all([
      import('@/app/api/novel-promotion/[projectId]/storyboard-sheet/route'),
      import('@/app/api/novel-promotion/[projectId]/storyboard-sheet/crop/route'),
      import('@/app/api/novel-promotion/[projectId]/storyboard-panel/upscale/route'),
    ])
    expect(sheet.POST).toBeTypeOf('function')
    expect(crop.POST).toBeTypeOf('function')
    expect(panel.POST).toBeTypeOf('function')
  })

  it('undoes a panel with a media-id CAS and returns HTTP 409 for a stale snapshot', async () => {
    const route = await import('@/app/api/novel-promotion/[projectId]/panel/route')
    const body = {
      panelId: 'panel-1', restorePreviousImage: true,
      expectedCurrentMediaId: 'current-1', expectedPreviousMediaId: 'previous-1',
    }
    let response = await callRoute(route.PATCH, 'PATCH', body, { params: { projectId: 'project-1' } })
    expect(response.status).toBe(200)
    expect(prismaMock.novelPromotionPanel.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'panel-1', imageMediaId: 'current-1', previousImageMediaId: 'previous-1' },
    }))

    prismaMock.novelPromotionPanel.updateMany.mockResolvedValueOnce({ count: 0 })
    response = await callRoute(route.PATCH, 'PATCH', body, { params: { projectId: 'project-1' } })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: 'CONFLICT', details: { code: 'SIX_GRID_PANEL_IMAGE_STALE' } },
    })
  })

  it('snapshots the correct original source for crop-then-upscale before submission', async () => {
    const route = await import('@/app/api/novel-promotion/[projectId]/storyboard-sheet/crop/route')
    const response = await callRoute(route.POST, 'POST', {
      episodeId: 'episode-1', storyboardId: 'storyboard-1', locale: 'zh',
    }, { params: { projectId: 'project-1' } })
    expect(response.status).toBe(200)
    expect(submitTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      type: TASK_TYPE.STORYBOARD_SHEET_CROP,
      payload: expect.objectContaining({
        sourceMediaId: 'sheet-media', sourceChecksum: 'sheet-sha', sourceVersion: '2026-07-13T00:00:00.000Z',
        processingOrder: 'crop_then_panel_upscale', expectedSheetArtifactVersion: 4,
        cropRects: expect.arrayContaining([expect.objectContaining({ cellIndex: 5 })]),
      }),
    }))
  })

  it('rejects non-six-grid and incomplete groups before the task/billing boundary', async () => {
    const route = await import('@/app/api/novel-promotion/[projectId]/storyboard-sheet/crop/route')
    prismaMock.novelPromotionStoryboard.findFirst.mockResolvedValueOnce({ ...storyboardFixture(), layoutMode: 'individual' })
    let response = await callRoute(route.POST, 'POST', { episodeId: 'episode-1', storyboardId: 'storyboard-1', locale: 'zh' }, { params: { projectId: 'project-1' } })
    expect(response.status).toBe(400)
    prismaMock.novelPromotionStoryboard.findFirst.mockResolvedValueOnce({ ...storyboardFixture(), panels: storyboardFixture().panels.slice(0, 5) })
    response = await callRoute(route.POST, 'POST', { episodeId: 'episode-1', storyboardId: 'storyboard-1', locale: 'zh' }, { params: { projectId: 'project-1' } })
    expect(response.status).toBe(400)
    expect(submitTaskMock).not.toHaveBeenCalled()
  })

  it('rejects wrong-purpose or unpublished upscale workflows before submission', async () => {
    const route = await import('@/app/api/novel-promotion/[projectId]/storyboard-sheet/route')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValueOnce(workflowFixture({ purpose: 'generation' }))
    let response = await callRoute(route.POST, 'POST', {
      operation: 'upscale', episodeId: 'episode-1', storyboardId: 'storyboard-1', workflowId: 'workflow-1', workflowVersionId: 'version-1', locale: 'zh',
    }, { params: { projectId: 'project-1' } })
    expect(response.status).toBe(400)
    prismaMock.comfyWorkflow.findFirst.mockResolvedValueOnce(workflowFixture({ publishedAt: null }))
    response = await callRoute(route.POST, 'POST', {
      operation: 'upscale', episodeId: 'episode-1', storyboardId: 'storyboard-1', workflowId: 'workflow-1', workflowVersionId: 'version-1', locale: 'zh',
    }, { params: { projectId: 'project-1' } })
    expect(response.status).toBe(400)
    expect(submitTaskMock).not.toHaveBeenCalled()
  })

  it('returns auth denial without querying ownership or submitting', async () => {
    const route = await import('@/app/api/novel-promotion/[projectId]/storyboard-sheet/crop/route')
    authMock.mockResolvedValueOnce(NextResponse.json({ error: 'forbidden' }, { status: 403 }) as never)
    const response = await callRoute(route.POST, 'POST', { episodeId: 'episode-1', storyboardId: 'storyboard-1', locale: 'zh' }, { params: { projectId: 'project-1' } })
    expect(response.status).toBe(403)
    expect(prismaMock.novelPromotionStoryboard.findFirst).not.toHaveBeenCalled()
    expect(submitTaskMock).not.toHaveBeenCalled()
  })

  it('fails closed on an unsupported complete-sheet ratio before submission', async () => {
    const route = await import('@/app/api/novel-promotion/[projectId]/storyboard-sheet/route')
    capabilityMock.mockRejectedValueOnce(new Error('CAPABILITY_VALUE_NOT_ALLOWED: aspectRatio'))
    const response = await callRoute(route.POST, 'POST', {
      operation: 'generate', episodeId: 'episode-1', storyboardId: 'storyboard-1', imageModel: 'openai::image-1', locale: 'zh',
    }, { params: { projectId: 'project-1' } })
    expect(response.status).toBe(400)
    expect(capabilityMock).toHaveBeenCalledWith(expect.objectContaining({ taskSelections: { aspectRatio: '8:3' } }))
    expect(submitTaskMock).not.toHaveBeenCalled()
  })

  it('rejects client-supplied sheet resolution instead of bypassing server capability selection', async () => {
    const route = await import('@/app/api/novel-promotion/[projectId]/storyboard-sheet/route')
    const response = await callRoute(route.POST, 'POST', {
      operation: 'generate', episodeId: 'episode-1', storyboardId: 'storyboard-1', imageModel: 'openai::image-1',
      generationOptions: { resolution: '99999K' }, locale: 'zh',
    }, { params: { projectId: 'project-1' } })
    expect(response.status).toBe(400)
    expect(submitTaskMock).not.toHaveBeenCalled()
  })

  it('selects the upscaled sheet source for sheet-upscale-then-crop', async () => {
    const route = await import('@/app/api/novel-promotion/[projectId]/storyboard-sheet/crop/route')
    prismaMock.novelPromotionStoryboard.findFirst.mockResolvedValueOnce({ ...storyboardFixture(), sixGridProcessingOrder: 'sheet_upscale_then_crop' })
    const response = await callRoute(route.POST, 'POST', { episodeId: 'episode-1', storyboardId: 'storyboard-1', locale: 'zh' }, { params: { projectId: 'project-1' } })
    expect(response.status).toBe(200)
    expect(submitTaskMock).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ sourceMediaId: 'upscaled-sheet', processingOrder: 'sheet_upscale_then_crop' }) }))
  })

  it('pins the owned published current ComfyUI generation workflow into the immutable task', async () => {
    const route = await import('@/app/api/novel-promotion/[projectId]/storyboard-sheet/route')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValueOnce(workflowFixture({ purpose: 'generation' }))
    const response = await callRoute(route.POST, 'POST', {
      operation: 'generate', episodeId: 'episode-1', storyboardId: 'storyboard-1', imageModel: 'comfyui::workflow-1', locale: 'zh',
    }, { params: { projectId: 'project-1' } })
    expect(response.status).toBe(200)
    expect(submitTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        imageModel: 'comfyui::workflow-1', workflowId: 'workflow-1', workflowVersionId: 'version-1',
        workflowPurpose: 'generation', comfyWorkflowVersionId: 'version-1', comfyModelSnapshotVersion: 1,
      }),
    }))
  })

  it.each([
    ['wrong purpose', workflowFixture({ purpose: 'upscale' })],
    ['unpublished', workflowFixture({ purpose: 'generation', publishedAt: null })],
    ['untested', workflowFixture({ purpose: 'generation', lastSuccessfulTestAt: null })],
    ['another user test connection', workflowFixture({ purpose: 'generation', lastTestConnection: { userId: 'user-2' } })],
    ['invalid static contract', workflowFixture({ purpose: 'generation', outputSpec: [] })],
  ])('rejects a ComfyUI generation workflow with %s before submit/billing', async (_label, workflow) => {
    const route = await import('@/app/api/novel-promotion/[projectId]/storyboard-sheet/route')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValueOnce(workflow)
    const response = await callRoute(route.POST, 'POST', {
      operation: 'generate', episodeId: 'episode-1', storyboardId: 'storyboard-1', imageModel: 'comfyui::workflow-1', locale: 'zh',
    }, { params: { projectId: 'project-1' } })
    expect(response.status).toBe(400)
    expect(submitTaskMock).not.toHaveBeenCalled()
  })

  it('accepts a tested owned published upscale workflow pinned to its current version', async () => {
    const route = await import('@/app/api/novel-promotion/[projectId]/storyboard-sheet/route')
    const response = await callRoute(route.POST, 'POST', {
      operation: 'upscale', episodeId: 'episode-1', storyboardId: 'storyboard-1',
      workflowId: 'workflow-1', workflowVersionId: 'version-1', locale: 'zh',
    }, { params: { projectId: 'project-1' } })
    expect(response.status).toBe(200)
    expect(submitTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ workflowPurpose: 'upscale', workflowVersionId: 'version-1' }),
    }))
  })
})

function storyboardFixture() {
  const sheet = { id: 'sheet-media', publicId: 'sheet-public', storageKey: 'sheet.png', sha256: 'sheet-sha', updatedAt: new Date('2026-07-13T00:00:00.000Z') }
  return {
    id: 'storyboard-1', episodeId: 'episode-1', layoutMode: 'six_grid', groupSequence: 1,
    sixGridCellAspectRatio: '16:9', sixGridProcessingOrder: 'crop_then_panel_upscale', sheetArtifactVersion: 4,
    sheetPromptSnapshot: 'one continuous story', sheetModelSnapshot: 'openai::image-1', sheetImageUrl: '/m/sheet-public',
    sheetImageMediaId: sheet.id, sheetImageMedia: sheet, upscaledSheetImageMediaId: 'upscaled-sheet', upscaledSheetImageMedia: { ...sheet, id: 'upscaled-sheet', sha256: 'upscaled-sha' },
    panels: Array.from({ length: 6 }, (_, gridCellIndex) => ({ id: `panel-${gridCellIndex}`, gridCellIndex, imageMediaId: `crop-${gridCellIndex}`, croppedImageMediaId: `crop-${gridCellIndex}`, imageMedia: { ...sheet, id: `crop-${gridCellIndex}` }, croppedImageMedia: { ...sheet, id: `crop-${gridCellIndex}` } })),
  }
}

function workflowFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'workflow-1', userId: 'user-1', mediaType: 'image', status: 'published', currentVersionId: 'version-1',
    currentVersion: {
      id: 'version-1', workflowId: 'workflow-1', purpose: 'upscale', publishedAt: new Date(), lastSuccessfulTestAt: new Date(), lastTestConnection: { userId: 'user-1' },
      apiFormatJson: {
        source: { class_type: 'LoadImage', inputs: { image: 'input.png' } },
        save: { class_type: 'SaveImage', inputs: { images: ['source', 0] } },
      },
      variableDefinitions: [{ name: 'source_image', type: 'image_ref', required: true }],
      bindingSpec: [{ nodeId: 'source', inputPath: 'image', variable: 'source_image', valueType: 'image_ref', transform: 'filename' }],
      outputSpec: [{ name: 'result', nodeId: 'save', fieldPath: 'images', mediaType: 'image', primary: true }],
      ...overrides,
    },
  }
}
