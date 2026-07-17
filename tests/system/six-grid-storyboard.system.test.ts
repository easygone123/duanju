import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { dispatchComfyRequest } from '@/lib/comfyui/dispatcher'
import { computeGridPixelRects } from '@/lib/novel-promotion/grid-storyboard/crop-geometry'
import { resolveStoryboardGridSpec } from '@/lib/novel-promotion/grid-storyboard/spec'
import { computeSixGridPixelRects, validateManualSixGridCrop } from '@/lib/novel-promotion/six-grid/crop-geometry'
import { readSixGridCropLimits } from '@/lib/novel-promotion/six-grid/limits'
import { buildSixGridSheetPrompt } from '@/lib/novel-promotion/six-grid/prompt-builder'
import { resolveStoryboardRunSettings } from '@/lib/novel-promotion/six-grid/run-settings'
import { resolvePanelVideoSubmission } from '@/lib/novel-promotion/video/panel-video-submission'
import {
  resolveFrameLinkChoices,
  type FrameLinkStoryboard,
} from '@/lib/novel-promotion/video/frame-link-resolver'
import { callRoute } from '../integration/api/helpers/call-route'
import { installAuthMocks, mockAuthenticated, resetAuthMockState } from '../helpers/auth'
import { resetSystemState } from '../helpers/db-reset'
import {
  createFixtureEpisode,
  createFixtureNovelProject,
  createFixtureProject,
  createFixtureUser,
} from '../helpers/fixtures'
import { prisma } from '../helpers/prisma'
import { waitForTaskTerminalState } from './helpers/tasks'
import { startSystemWorkers, stopSystemWorkers, type SystemWorkers } from './helpers/workers'
import {
  AcceptanceComfyServer,
  CapturedComfyTelemetry,
  InMemoryComfyExecution,
  InMemoryComfyStorage,
  PNG,
  createAggregate,
} from './helpers/comfyui-acceptance'

const sixGridRuntime = vi.hoisted(() => ({
  sequence: 0,
  bytes: new Map<string, Buffer>(),
  bypassModels: new Set<string>(),
  generateDirect: null as null | ((params: Record<string, unknown>) => Promise<string>),
}))

vi.mock('@/lib/config-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/config-service')>('@/lib/config-service')
  return {
    ...actual,
    resolveProjectImageTaskGenerationOptions: vi.fn(async (input: { taskSelections?: Record<string, unknown> }) => ({
      aspectRatio: input.taskSelections?.aspectRatio,
    })),
  }
})

vi.mock('@/lib/workers/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/workers/utils')>('@/lib/workers/utils')
  return {
    ...actual,
    resolveImageSourceFromGeneration: vi.fn(async (job: never, params: Record<string, unknown>) => {
      if (typeof params.modelId === 'string' && sixGridRuntime.bypassModels.has(params.modelId)) {
        if (!sixGridRuntime.generateDirect) throw new Error('SIX_GRID_DIRECT_GENERATOR_NOT_READY')
        return sixGridRuntime.generateDirect(params)
      }
      return actual.resolveImageSourceFromGeneration(job, params as never)
    }),
    uploadImageSourceToCos: vi.fn(async (_source: string, _kind: string, targetId: string) => {
      const key = `six-grid-system/${targetId}/${++sixGridRuntime.sequence}.png`
      sixGridRuntime.bytes.set(key, Buffer.from(PNG))
      return key
    }),
  }
})

vi.mock('@/lib/storage', async () => {
  const actual = await vi.importActual<typeof import('@/lib/storage')>('@/lib/storage')
  return {
    ...actual,
    getObjectBuffer: vi.fn(async (key: string) => {
      const bytes = sixGridRuntime.bytes.get(key)
      if (!bytes) throw new Error(`missing six-grid system object: ${key}`)
      return Buffer.from(bytes)
    }),
  }
})

vi.mock('@/lib/media/service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/media/service')>('@/lib/media/service')
  return {
    ...actual,
    ensureMediaObjectFromStorageKey: vi.fn(async (storageKey: string) => {
      const publicId = `six-grid-${++sixGridRuntime.sequence}`
      const media = await prisma.mediaObject.create({
        data: {
          publicId,
          storageKey,
          sha256: `sha-${publicId}`,
          mimeType: 'image/png',
          sizeBytes: BigInt(PNG.byteLength),
        },
      })
      return { ...media, url: `/m/${publicId}` }
    }),
  }
})

vi.mock('@/lib/media/outbound-image', async () => {
  const actual = await vi.importActual<typeof import('@/lib/media/outbound-image')>('@/lib/media/outbound-image')
  return {
    ...actual,
    normalizeReferenceImagesForGeneration: vi.fn(async (references: string[]) => references),
  }
})

vi.mock('@/lib/novel-promotion/six-grid/crop-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/novel-promotion/six-grid/crop-service')>(
    '@/lib/novel-promotion/six-grid/crop-service',
  )
  return {
    ...actual,
    cropSixGridSheet: vi.fn(async (input: {
      sourceMediaId: string
      manualOverrides?: Array<{ cellIndex: number; normalizedCropRect: { x: number; y: number; width: number; height: number } }>
    }) => {
      const rects = input.manualOverrides ?? Array.from({ length: 6 }, (_, cellIndex) => ({
        cellIndex,
        normalizedCropRect: {
          x: (cellIndex % 3) / 3,
          y: Math.floor(cellIndex / 3) / 2,
          width: 1 / 3,
          height: 1 / 2,
        },
      }))
      return await Promise.all(rects.map(async ({ cellIndex, normalizedCropRect }) => {
        const publicId = `crop-${++sixGridRuntime.sequence}`
        const storageKey = `six-grid-system/crops/${publicId}.png`
        sixGridRuntime.bytes.set(storageKey, Buffer.from(PNG))
        const media = await prisma.mediaObject.create({
          data: {
            publicId,
            storageKey,
            sha256: `sha-${publicId}`,
            mimeType: 'image/png',
            sizeBytes: BigInt(PNG.byteLength),
          },
        })
        return {
          cellIndex,
          mediaId: media.id,
          storageKey,
          url: `/m/${publicId}`,
          pixelRect: { x: 0, y: 0, width: 900, height: 1600 },
          normalizedCropRect,
          lineage: {
            sourceMediaId: input.sourceMediaId,
            sourceStorageKey: 'six-grid-system/source.png',
            sourceDimensions: { width: 2700, height: 3200 },
            sourceChecksum: 'source-sha',
            sourceVersion: 'v1',
            cropRect: { x: 0, y: 0, width: 900, height: 1600 },
            processingStage: 'six_grid_crop' as const,
            artifactVersion: 1,
            outputChecksum: `sha-${publicId}`,
            outputDimensions: { width: 900, height: 1600 },
          },
        }
      }))
    }),
  }
})

describe('system - six-grid storyboard acceptance', () => {
  let workers: SystemWorkers = {}

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    sixGridRuntime.sequence = 0
    sixGridRuntime.bytes.clear()
    sixGridRuntime.bypassModels.clear()
    sixGridRuntime.generateDirect = null
    await resetSystemState()
    installAuthMocks()
  })

  afterEach(async () => {
    await stopSystemWorkers(workers)
    workers = {}
    resetAuthMockState()
  })

  it('REQ-NP-SIX-GRID-01 runs landscape and portrait sheets through the real ComfyUI renderer, client, and dispatcher', async () => {
    const fixture = await seedSixGridSystemFixture('sheet_upscale_then_crop', '16:9')
    mockAuthenticated(fixture.user.id)
    const server = await installFakeComfyGeneration()
    sixGridRuntime.bypassModels.add(`comfyui::${fixture.workflow.id}`)
    try {
      workers = await startSystemWorkers(['image'])
      const generated = await submitSheet(fixture, { operation: 'generate' })
      expect((await waitForTaskTerminalState(generated.taskId)).status).toBe('completed')

      const upscaled = await submitSheet(fixture, {
        operation: 'upscale',
        workflowId: fixture.workflow.id,
        workflowVersionId: fixture.workflowVersion.id,
      })
      expect((await waitForTaskTerminalState(upscaled.taskId)).status).toBe('completed')

      const cropped = await submitCrop(fixture)
      expect((await waitForTaskTerminalState(cropped.taskId)).status).toBe('completed')
      const persisted = await prisma.novelPromotionStoryboard.findUnique({
        where: { id: fixture.storyboard.id },
        include: { panels: { orderBy: { gridCellIndex: 'asc' } } },
      })
      expect(persisted).toMatchObject({
        layoutMode: 'six_grid',
        sixGridCellAspectRatio: '16:9',
        sixGridProcessingOrder: 'sheet_upscale_then_crop',
        sheetImageMediaId: expect.any(String),
        upscaledSheetImageMediaId: expect.any(String),
      })
      expect(persisted?.panels).toHaveLength(6)
      expect(persisted?.panels.every((panel) => panel.croppedImageMediaId === panel.imageMediaId)).toBe(true)
      expect(server.promptCount).toBe(2)
      expect(persisted?.sheetGenerationOptionsSnapshot).toContain('"aspectRatio":"8:3"')
    } finally {
      await server.close()
    }
  })

  it('REQ-NP-SIX-GRID-02 executes crop-then-panel-upscale and persists a ratio-locked manual recrop', async () => {
    expect(readSixGridCropLimits({
      SIX_GRID_CROP_MAX_SOURCE_BYTES: '67108864',
      SIX_GRID_CROP_MAX_SOURCE_PIXELS: '48000000',
    })).toEqual({ maxSourceBytes: 67_108_864, maxSourcePixels: 48_000_000 })
    for (const dimensions of [{ width: 4800, height: 1800 }, { width: 2700, height: 3200 }]) {
      const rects = computeSixGridPixelRects(dimensions)
      expect(rects).toHaveLength(6)
      expect(rects.reduce((area, rect) => area + rect.width * rect.height, 0))
        .toBe(dimensions.width * dimensions.height)
      const ratio = dimensions.width > dimensions.height ? '16:9' : '9:16'
      expect(computeGridPixelRects(dimensions, resolveStoryboardGridSpec('six_grid', ratio)))
        .toEqual(rects)
    }
    expect(validateManualSixGridCrop({
      cellIndex: 0,
      normalizedCropRect: { x: 0, y: 0, width: 1 / 6, height: 1 / 4 },
      cellAspectRatio: '16:9',
      dimensions: { width: 4800, height: 1800 },
    })).toEqual({ x: 0, y: 0, width: 800, height: 450 })

    const fixture = await seedSixGridSystemFixture('crop_then_panel_upscale', '9:16')
    mockAuthenticated(fixture.user.id)
    const server = await installFakeComfyGeneration()
    sixGridRuntime.bypassModels.add(`comfyui::${fixture.workflow.id}`)
    try {
      workers = await startSystemWorkers(['image'])
      const generated = await submitSheet(fixture, { operation: 'generate' })
      expect((await waitForTaskTerminalState(generated.taskId)).status).toBe('completed')
      const manualRects = defaultSystemCropRects()
      manualRects[0] = {
        cellIndex: 0,
        normalizedCropRect: { x: 0, y: 0, width: 1 / 6, height: 1 / 4 },
      }
      const cropped = await submitCrop(fixture, manualRects)
      expect((await waitForTaskTerminalState(cropped.taskId)).status).toBe('completed')
      const firstPanel = await prisma.novelPromotionPanel.findFirst({
        where: { storyboardId: fixture.storyboard.id, gridCellIndex: 0 },
      })
      expect(firstPanel?.normalizedCropRect).toBe(JSON.stringify(manualRects[0].normalizedCropRect))

      const upscaled = await submitPanelUpscale(fixture, firstPanel!.id)
      expect((await waitForTaskTerminalState(upscaled.taskId)).status).toBe('completed')
      const persisted = await prisma.novelPromotionPanel.findUnique({ where: { id: firstPanel!.id } })
      expect(persisted).toMatchObject({
        imageDerivation: 'panel_upscale',
        croppedImageMediaId: expect.any(String),
        upscaledImageMediaId: expect.any(String),
        imageMediaId: expect.any(String),
      })
      expect(persisted?.imageMediaId).toBe(persisted?.upscaledImageMediaId)
      expect(persisted?.imageMediaId).not.toBe(persisted?.croppedImageMediaId)
      expect(server.promptCount).toBe(2)
      const generatedOptions = await prisma.novelPromotionStoryboard.findUnique({
        where: { id: fixture.storyboard.id },
        select: { sheetGenerationOptionsSnapshot: true },
      })
      expect(generatedOptions?.sheetGenerationOptionsSnapshot).toContain('"aspectRatio":"27:32"')
    } finally {
      await server.close()
    }
  })

  it('REQ-NP-SIX-GRID-03 routes literal dialogue to the pinned dialogue model without shortening duration', () => {
    const submission = resolvePanelVideoSubmission({
      panel: {
        hasDialogue: true,
        dialogueSpeaker: 'Ming',
        dialogueText: '不要离开',
        dialogueEmotion: 'afraid',
        includeDialogueInVideoPrompt: true,
        videoPrompt: 'A slow push-in on Ming holding a red umbrella.',
        estimatedDuration: 7.2,
      },
      project: { videoModel: 'cloud::video', dialogueVideoModel: 'comfyui::dialogue-video' },
      models: [
        { modelKey: 'cloud::video', available: true, duration: { kind: 'fixed', options: [5, 10] } },
        { modelKey: 'comfyui::dialogue-video', comfyWorkflowVersionId: 'dialogue-v1', available: true, duration: { kind: 'fixed', options: [5, 10] } },
      ],
    })
    expect(submission).toMatchObject({
      selectedModel: 'comfyui::dialogue-video',
      effectiveDuration: 10,
      snapshot: { comfyWorkflowVersionId: 'dialogue-v1' },
    })
    expect(submission.submittedPrompt).toContain('不要离开')
  })

  it('REQ-NP-SIX-GRID-04 links the last cell to the next continuous group and stops at a scene boundary', () => {
    const first = sixGridStoryboard('group-1', 1, 'platform', 'g1')
    const continuous = sixGridStoryboard('group-2', 2, 'platform', 'g2')
    const boundary = sixGridStoryboard('group-3', 3, 'street', 'g3')
    expect(resolveFrameLinkChoices({ panelId: 'g1-5', storyboards: [boundary, continuous, first] }).lastFrame)
      .toEqual({ mode: 'automatic', sourcePanelId: 'g2-0' })
    expect(resolveFrameLinkChoices({ panelId: 'g2-5', storyboards: [first, continuous, boundary] }).lastFrame)
      .toBeNull()
  })

  it('REQ-NP-SIX-GRID-05 retries output transfer without submitting a duplicate ComfyUI prompt', async () => {
    const fixture = await seedSixGridSystemFixture('crop_then_panel_upscale', '16:9')
    mockAuthenticated(fixture.user.id)
    const server = await installFakeComfyGeneration(1)
    try {
      const first = await submitSheet(fixture, { operation: 'generate' })
      const duplicate = await submitSheet(fixture, { operation: 'generate' })
      expect(duplicate.taskId).toBe(first.taskId)
      workers = await startSystemWorkers(['image'])
      expect((await waitForTaskTerminalState(first.taskId)).status).toBe('completed')
      expect(server.promptCount).toBe(1)
      expect(await prisma.comfyGenerationRequest.count({ where: { taskId: first.taskId } })).toBe(1)
    } finally {
      await server.close()
    }
  })

  it('REQ-NP-SIX-GRID-06 preserves the legacy individual-mode default', () => {
    expect(resolveStoryboardRunSettings({ project: { videoRatio: '4:3' } })).toEqual({
      storyboardGenerationMode: 'individual',
      sixGridCellAspectRatio: null,
      gridSpec: null,
      sixGridProcessingOrder: 'crop_then_panel_upscale',
      storyboardUpscaleModel: null,
      dialogueVideoModel: null,
    })
  })
})

function sceneGroup() {
  return {
    sceneKey: 'rainy-platform',
    clipId: 'clip-1',
    incomingContinuity: 'Ming wears a red coat and carries a red umbrella.',
    outgoingContinuity: 'Ming still wears the red coat and carries the umbrella.',
    panels: Array.from({ length: 6 }, (_, index) => ({
      panel_number: index + 1,
      description: `Ming advances through visual beat ${index + 1}.`,
      location: 'rainy-platform',
      source_text: `source ${index + 1}`,
      characters: [{ name: 'Ming' }],
      props: ['red umbrella'],
    })),
  }
}

function sixGridStoryboard(id: string, groupSequence: number, sceneKey: string, prefix: string): FrameLinkStoryboard {
  return {
    id,
    layoutMode: 'six_grid',
    groupSequence,
    continuityAnchor: JSON.stringify({ sceneKey }),
    panels: Array.from({ length: 6 }, (_, gridCellIndex) => ({
      id: `${prefix}-${gridCellIndex}`,
      storyboardId: id,
      panelIndex: gridCellIndex,
      gridCellIndex,
    })),
  }
}

async function installFakeComfyGeneration(transferFailures = 0) {
  const server = new AcceptanceComfyServer()
  server.installDynamicHistoryRoutes(30)
  await server.start()
  sixGridRuntime.generateDirect = async (params) => {
    const aggregate = createAggregate('image')
    const prompt = typeof params.prompt === 'string' ? params.prompt : ''
    const references = Array.isArray(params.comfyReferenceImages)
      ? params.comfyReferenceImages.filter((value): value is string => typeof value === 'string')
      : []
    const inputKey = references[0] ?? 'users/user-a/input.png'
    aggregate.request.variableSnapshot.prompt = prompt
    aggregate.request.variableSnapshot.input = { storageKey: inputKey, filename: 'input.png' }
    const storage = new InMemoryComfyStorage()
    storage.seed(inputKey, {
      bytes: sixGridRuntime.bytes.get(inputKey) ?? PNG,
      userId: aggregate.request.userId,
      projectId: aggregate.request.projectId,
      mediaType: 'image',
    })
    const telemetry = new CapturedComfyTelemetry()
    const result = await dispatchComfyRequest(
      aggregate.request.id,
      new InMemoryComfyExecution(server.client(), storage, aggregate, telemetry).dependencies(),
    )
    if (result.outcome !== 'completed') throw new Error(`unexpected direct ComfyUI result: ${result.outcome}`)
    persistComfyStorageObjects(storage)
    return result.primary.url
  }
  let closed = false
  let remainingTransferFailures = transferFailures
  const claimed = new Set<string>()
  const pump = (async () => {
    while (!closed) {
      const request = await prisma.comfyGenerationRequest.findFirst({
        where: { status: 'waiting_capacity', id: { notIn: [...claimed] } },
        orderBy: { createdAt: 'asc' },
      })
      if (!request) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        continue
      }
      claimed.add(request.id)
      const aggregate = createAggregate('image', request.userId)
      const inputKey = `users/${request.userId}/${request.id}.png`
      Object.assign(aggregate.request, {
        id: request.id,
        taskId: request.taskId,
        invocationKey: request.invocationKey,
        userId: request.userId,
        projectId: request.projectId,
        workflowId: request.workflowId,
        workflowVersionId: request.workflowVersionId,
        variableSnapshot: {
          prompt: 'SIX_GRID_SYSTEM_PROMPT',
          input: { storageKey: inputKey, filename: 'input.png' },
        },
      })
      const storage = new InMemoryComfyStorage()
      storage.transferFailures = remainingTransferFailures
      remainingTransferFailures = 0
      storage.seed(inputKey, {
        bytes: PNG,
        userId: request.userId,
        projectId: request.projectId,
        mediaType: 'image',
      })
      const telemetry = new CapturedComfyTelemetry()
      try {
        let result = await dispatchComfyRequest(
          aggregate.request.id,
          new InMemoryComfyExecution(server.client(), storage, aggregate, telemetry).dependencies(),
        )
        if (result.outcome === 'reconciling') {
          result = await dispatchComfyRequest(
            aggregate.request.id,
            new InMemoryComfyExecution(server.client(), storage, aggregate, telemetry).dependencies(),
          )
        }
        if (result.outcome !== 'completed') throw new Error(`unexpected ComfyUI result: ${result.outcome}`)
        persistComfyStorageObjects(storage)
        await prisma.comfyGenerationRequest.update({
          where: { id: request.id },
          data: {
            status: 'completed',
            outputRefs: JSON.parse(JSON.stringify(aggregate.request.outputRefs ?? [])),
          },
        })
      } catch (error) {
        await prisma.comfyGenerationRequest.update({
          where: { id: request.id },
          data: { status: 'failed', errorMessage: error instanceof Error ? error.message : String(error) },
        })
      }
    }
  })()
  return {
    get promptCount() { return server.promptCount },
    async close() {
      closed = true
      await pump
      await server.close()
    },
  }
}

function persistComfyStorageObjects(storage: InMemoryComfyStorage) {
  for (const [storageKey, object] of storage.objects) {
    sixGridRuntime.bytes.set(storageKey, Buffer.from(object.bytes))
  }
}

async function seedSixGridSystemFixture(
  processingOrder: 'sheet_upscale_then_crop' | 'crop_then_panel_upscale',
  cellAspectRatio: '16:9' | '9:16',
) {
  const user = await createFixtureUser()
  const project = await createFixtureProject(user.id)
  const novelProject = await createFixtureNovelProject(project.id)
  const episode = await createFixtureEpisode(novelProject.id)
  const clip = await prisma.novelPromotionClip.create({
    data: {
      episodeId: episode.id,
      summary: 'six-grid system clip',
      content: 'six-grid system content',
      screenplay: 'six-grid system screenplay',
      location: 'rainy-platform',
      characters: JSON.stringify(['Ming']),
    },
  })
  const storyboard = await prisma.novelPromotionStoryboard.create({
    data: {
      episodeId: episode.id,
      clipId: clip.id,
      panelCount: 6,
      layoutMode: 'six_grid',
      groupSequence: 1,
      continuityAnchor: JSON.stringify({ sceneKey: 'rainy-platform' }),
      sixGridCellAspectRatio: cellAspectRatio,
      sixGridProcessingOrder: processingOrder,
      sheetPromptSnapshot: buildSixGridSheetPrompt(sceneGroup(), { locale: 'en', cellAspectRatio }),
      sheetModelSnapshot: 'cloud::sheet-image',
      sheetArtifactVersion: 0,
    },
  })
  await prisma.novelPromotionPanel.createMany({
    data: Array.from({ length: 6 }, (_, gridCellIndex) => ({
      storyboardId: storyboard.id,
      panelIndex: gridCellIndex,
      panelNumber: gridCellIndex + 1,
      gridCellIndex,
      description: `six-grid system panel ${gridCellIndex + 1}`,
      location: 'rainy-platform',
      characters: JSON.stringify(['Ming']),
    })),
  })

  const connection = await prisma.comfyConnection.create({
    data: {
      userId: user.id,
      name: 'six-grid system ComfyUI',
      baseUrl: 'http://127.0.0.1:18188',
      normalizedBaseUrl: 'http://127.0.0.1:18188',
    },
  })
  const generationWorkflow = await prisma.comfyWorkflow.create({
    data: { userId: user.id, name: 'six-grid generation', mediaType: 'image', status: 'draft' },
  })
  const generationWorkflowVersion = await prisma.comfyWorkflowVersion.create({
    data: {
      workflowId: generationWorkflow.id,
      version: 1,
      purpose: 'generation',
      apiFormatJson: {
        prompt: { class_type: 'PromptText', inputs: { text: '' } },
        save: { class_type: 'SaveImage', inputs: { images: ['prompt', 0] } },
      },
      variableDefinitions: [
        { name: 'prompt', type: 'string', required: true },
        { name: 'aspect_ratio', type: 'string', required: true },
      ],
      bindingSpec: [
        { nodeId: 'prompt', inputPath: 'text', variable: 'prompt', valueType: 'string' },
        { nodeId: 'prompt', inputPath: 'aspect_ratio', variable: 'aspect_ratio', valueType: 'string' },
      ],
      outputSpec: [{ name: 'result', nodeId: 'save', fieldPath: 'images', mediaType: 'image', primary: true }],
      requirements: {},
      contentHash: 'six-grid-generation-v1',
      publishedAt: new Date(),
      lastSuccessfulTestAt: new Date(),
      lastTestConnectionId: connection.id,
    },
  })
  await prisma.comfyWorkflow.update({
    where: { id: generationWorkflow.id },
    data: { status: 'published', currentVersionId: generationWorkflowVersion.id },
  })
  await prisma.novelPromotionStoryboard.update({
    where: { id: storyboard.id },
    data: { sheetModelSnapshot: `comfyui::${generationWorkflow.id}` },
  })
  const workflow = await prisma.comfyWorkflow.create({
    data: { userId: user.id, name: 'six-grid upscale', mediaType: 'image', status: 'draft' },
  })
  const workflowVersion = await prisma.comfyWorkflowVersion.create({
    data: {
      workflowId: workflow.id,
      version: 1,
      purpose: 'upscale',
      apiFormatJson: {
        source: { class_type: 'LoadImage', inputs: { image: 'input.png' } },
        save: { class_type: 'SaveImage', inputs: { images: ['source', 0] } },
      },
      variableDefinitions: [{ name: 'source_image', type: 'image_ref', required: true }],
      bindingSpec: [{ nodeId: 'source', inputPath: 'image', variable: 'source_image', valueType: 'image_ref', transform: 'filename' }],
      outputSpec: [{ name: 'result', nodeId: 'save', fieldPath: 'images', mediaType: 'image', primary: true }],
      requirements: {},
      contentHash: 'six-grid-upscale-v1',
      publishedAt: new Date(),
      lastSuccessfulTestAt: new Date(),
      lastTestConnectionId: connection.id,
    },
  })
  await prisma.comfyWorkflow.update({
    where: { id: workflow.id },
    data: { status: 'published', currentVersionId: workflowVersion.id },
  })
  return {
    user, project, novelProject, episode, clip,
    storyboard: { ...storyboard, sheetModelSnapshot: `comfyui::${generationWorkflow.id}` },
    workflow, workflowVersion, generationWorkflow, generationWorkflowVersion,
  }
}

type SixGridSystemFixture = Awaited<ReturnType<typeof seedSixGridSystemFixture>>

async function submitSheet(
  fixture: SixGridSystemFixture,
  input: { operation: 'generate' | 'upscale'; workflowId?: string; workflowVersionId?: string },
) {
  const route = await import('@/app/api/novel-promotion/[projectId]/storyboard-sheet/route')
  const response = await callRoute(route.POST, 'POST', {
    ...input,
    episodeId: fixture.episode.id,
    storyboardId: fixture.storyboard.id,
    ...(input.operation === 'generate' ? { imageModel: fixture.storyboard.sheetModelSnapshot } : {}),
    locale: 'en',
  }, { params: { projectId: fixture.project.id } })
  expect(response.status).toBe(200)
  return await response.json() as { taskId: string }
}

async function submitCrop(
  fixture: SixGridSystemFixture,
  cropRects?: ReturnType<typeof defaultSystemCropRects>,
) {
  const route = await import('@/app/api/novel-promotion/[projectId]/storyboard-sheet/crop/route')
  const response = await callRoute(route.POST, 'POST', {
    episodeId: fixture.episode.id,
    storyboardId: fixture.storyboard.id,
    ...(cropRects ? { cropRects } : {}),
    locale: 'en',
  }, { params: { projectId: fixture.project.id } })
  expect(response.status).toBe(200)
  return await response.json() as { taskId: string }
}

async function submitPanelUpscale(fixture: SixGridSystemFixture, panelId: string) {
  const route = await import('@/app/api/novel-promotion/[projectId]/storyboard-panel/upscale/route')
  const response = await callRoute(route.POST, 'POST', {
    episodeId: fixture.episode.id,
    storyboardId: fixture.storyboard.id,
    panelId,
    workflowId: fixture.workflow.id,
    workflowVersionId: fixture.workflowVersion.id,
    locale: 'en',
  }, { params: { projectId: fixture.project.id } })
  expect(response.status).toBe(200)
  return await response.json() as { taskId: string }
}

function defaultSystemCropRects() {
  return Array.from({ length: 6 }, (_, cellIndex) => ({
    cellIndex,
    normalizedCropRect: {
      x: (cellIndex % 3) / 3,
      y: Math.floor(cellIndex / 3) / 2,
      width: 1 / 3,
      height: 1 / 2,
    },
  }))
}
