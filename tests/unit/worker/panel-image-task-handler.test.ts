import type { Job } from 'bullmq'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TASK_TYPE, type TaskJobData } from '@/lib/task/types'

const prismaMock = vi.hoisted(() => ({
  novelPromotionPanel: {
    findUnique: vi.fn(),
    update: vi.fn(async () => ({})),
  },
}))

const utilsMock = vi.hoisted(() => ({
  assertTaskActive: vi.fn(async () => undefined),
  getProjectModels: vi.fn(async () => ({ storyboardModel: 'storyboard-model-1', artStyle: 'realistic' })),
  resolveImageSourceFromGeneration: vi.fn(),
  uploadImageSourceToCos: vi.fn(),
  toSignedUrlIfCos: vi.fn((value: string | null | undefined) => value || null),
}))

const sharedMock = vi.hoisted(() => ({
  collectPanelReferenceImages: vi.fn(async () => ['https://signed.example/ref-1.png']),
  collectPanelReferenceImageEntries: vi.fn(async () => [{
    source: 'users/u/projects/p/ref-1.png',
    url: 'https://signed.example/ref-1.png', kind: 'character', name: 'Hero',
  }]),
  resolveNovelData: vi.fn(async () => ({
    videoRatio: '16:9',
    characters: [],
    locations: [
      {
        name: 'Old Town',
        assetKind: 'prop',
        images: [{ isSelected: true, description: '同名道具' }],
      },
      {
        name: 'Old Town',
        assetKind: 'location',
        images: [
          {
            isSelected: true,
            description: '雨夜街道',
            availableSlots: JSON.stringify([
              '街道左侧靠墙的留白位置',
            ]),
          },
        ],
      },
    ],
  })),
}))

const outboundMock = vi.hoisted(() => ({
  normalizeReferenceImagesForGeneration: vi.fn(async (values: string[]) => {
    void values
    return ['normalized-ref-1']
  }),
}))

const fetchMock = vi.hoisted(() => vi.fn())

const promptMock = vi.hoisted(() => ({
  buildPrompt: vi.fn((input: {
    promptId: string
    locale: string
    variables: Record<string, string>
  }) => {
    void input
    return 'panel-image-prompt'
  }),
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/workers/utils', () => utilsMock)
vi.mock('@/lib/media/outbound-image', () => outboundMock)
vi.mock('@/lib/workers/shared', () => ({ reportTaskProgress: vi.fn(async () => undefined) }))
vi.mock('@/lib/logging/core', () => ({
  logInfo: vi.fn(),
  createScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    event: vi.fn(),
    child: vi.fn(),
  })),
}))
vi.mock('@/lib/workers/handlers/image-task-handler-shared', async () => {
  const actual = await vi.importActual<typeof import('@/lib/workers/handlers/image-task-handler-shared')>(
    '@/lib/workers/handlers/image-task-handler-shared',
  )
  return {
    ...actual,
    collectPanelReferenceImages: sharedMock.collectPanelReferenceImages,
    collectPanelReferenceImageEntries: sharedMock.collectPanelReferenceImageEntries,
    resolveNovelData: sharedMock.resolveNovelData,
  }
})
vi.mock('@/lib/prompt-i18n', () => ({
  PROMPT_IDS: { NP_SINGLE_PANEL_IMAGE: 'np_single_panel_image' },
  buildPrompt: promptMock.buildPrompt,
}))

import { handlePanelImageTask } from '@/lib/workers/handlers/panel-image-task-handler'

function buildJob(payload: Record<string, unknown>, targetId = 'panel-1'): Job<TaskJobData> {
  return {
    data: {
      taskId: 'task-panel-image-1',
      type: TASK_TYPE.IMAGE_PANEL,
      locale: 'zh',
      projectId: 'project-1',
      episodeId: 'episode-1',
      targetType: 'NovelPromotionPanel',
      targetId,
      payload,
      userId: 'user-1',
    },
  } as unknown as Job<TaskJobData>
}

describe('worker panel-image-task-handler behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)

    prismaMock.novelPromotionPanel.findUnique.mockResolvedValue({
      id: 'panel-1',
      storyboardId: 'storyboard-1',
      panelIndex: 0,
      shotType: 'close-up',
      cameraMove: 'static',
      description: 'hero close-up',
      imagePrompt: 'panel anchor prompt',
      videoPrompt: 'dramatic',
      location: 'Old Town',
      characters: JSON.stringify([{ name: 'Hero', appearance: 'default', slot: '街道左侧靠墙的留白位置' }]),
      srtSegment: '台词片段',
      photographyRules: null,
      actingNotes: null,
      sketchImageUrl: null,
      imageUrl: null,
    })

    utilsMock.resolveImageSourceFromGeneration.mockReset()
    utilsMock.resolveImageSourceFromGeneration
      .mockResolvedValueOnce('generated-source-1')
      .mockResolvedValueOnce('generated-source-2')

    utilsMock.uploadImageSourceToCos.mockReset()
    utilsMock.uploadImageSourceToCos
      .mockResolvedValueOnce('cos/panel-candidate-1.png')
      .mockResolvedValueOnce('cos/panel-candidate-2.png')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps opaque owned references for ComfyUI without normalizing browser URLs', async () => {
    const source = 'users/u/projects/p/ref.png'
    const browserUrl = 'http://localhost:19000/waoowaoo/users/u/projects/p/ref.png?signed=1'
    utilsMock.getProjectModels.mockResolvedValueOnce({
      storyboardModel: 'comfyui::workflow-image',
      artStyle: 'realistic',
    })
    sharedMock.collectPanelReferenceImageEntries.mockResolvedValueOnce([{
      source,
      url: browserUrl,
      kind: 'character',
      name: 'Hero',
    }])

    await handlePanelImageTask(buildJob({ candidateCount: 1 }))

    expect(outboundMock.normalizeReferenceImagesForGeneration).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(utilsMock.resolveImageSourceFromGeneration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        modelId: 'comfyui::workflow-image',
        comfyReferenceImages: [source],
        options: expect.not.objectContaining({ referenceImages: expect.anything() }),
        preferComfyStorageKey: true,
      }),
    )
  })

  it('reuses the persisted ComfyUI output key without downloading and uploading it again', async () => {
    utilsMock.getProjectModels.mockResolvedValueOnce({
      storyboardModel: 'comfyui::workflow-image',
      artStyle: 'realistic',
    })
    utilsMock.resolveImageSourceFromGeneration.mockReset()
    utilsMock.resolveImageSourceFromGeneration.mockResolvedValueOnce(
      'comfyui/user-1/project-1/request-1/output.png',
    )

    const result = await handlePanelImageTask(buildJob({ candidateCount: 1 }))

    expect(utilsMock.resolveImageSourceFromGeneration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        preferComfyStorageKey: true,
      }),
    )
    expect(utilsMock.uploadImageSourceToCos).not.toHaveBeenCalled()
    expect(prismaMock.novelPromotionPanel.update).toHaveBeenCalledWith({
      where: { id: 'panel-1' },
      data: {
        imageUrl: 'comfyui/user-1/project-1/request-1/output.png',
        candidateImages: null,
      },
    })
    expect(result.imageUrl).toBe('comfyui/user-1/project-1/request-1/output.png')
  })

  it('still normalizes browser references to data URLs for cloud image providers', async () => {
    const source = 'users/u/projects/p/ref.png'
    const browserUrl = 'http://localhost:19000/waoowaoo/users/u/projects/p/ref.png?signed=1'
    utilsMock.getProjectModels.mockResolvedValueOnce({
      storyboardModel: 'fal::cloud-image',
      artStyle: 'realistic',
    })
    sharedMock.collectPanelReferenceImageEntries.mockResolvedValueOnce([{
      source,
      url: browserUrl,
      kind: 'character',
      name: 'Hero',
    }])
    outboundMock.normalizeReferenceImagesForGeneration.mockResolvedValueOnce([
      'data:image/png;base64,UkVG',
    ])

    await handlePanelImageTask(buildJob({ candidateCount: 1 }))

    expect(outboundMock.normalizeReferenceImagesForGeneration).toHaveBeenCalledWith([browserUrl])
    expect(utilsMock.resolveImageSourceFromGeneration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        modelId: 'fal::cloud-image',
        options: expect.objectContaining({
          referenceImages: ['data:image/png;base64,UkVG'],
        }),
      }),
    )
  })

  it('does not let a malformed comfy-like model key bypass cloud normalization', async () => {
    const browserUrl = 'http://localhost:19000/waoowaoo/users/u/projects/p/ref.png?signed=1'
    utilsMock.getProjectModels.mockResolvedValueOnce({
      storyboardModel: 'comfyui:remote::workflow-image',
      artStyle: 'realistic',
    })
    sharedMock.collectPanelReferenceImageEntries.mockResolvedValueOnce([{
      source: 'users/u/projects/p/ref.png',
      url: browserUrl,
      kind: 'character',
      name: 'Hero',
    }])

    await handlePanelImageTask(buildJob({ candidateCount: 1 }))

    expect(outboundMock.normalizeReferenceImagesForGeneration).toHaveBeenCalledWith([browserUrl])
  })

  it('orders compact semantic references as characters, location, props, then sketch', async () => {
    const actual = await vi.importActual<typeof import('@/lib/workers/handlers/image-task-handler-shared')>(
      '@/lib/workers/handlers/image-task-handler-shared',
    )
    const references = await actual.collectPanelReferenceImages({
      characters: [
        {
          name: 'Hero',
          appearances: [{
            changeReason: 'default', imageUrls: JSON.stringify(['hero.png']),
            imageUrl: null, selectedIndex: 0,
          }],
        },
        {
          name: 'Friend',
          appearances: [{
            changeReason: 'default', imageUrls: JSON.stringify(['friend.png']),
            imageUrl: null, selectedIndex: 0,
          }],
        },
      ],
      locations: [
        {
          name: 'Cafe', assetKind: 'location',
          images: [{ isSelected: true, imageUrl: 'cafe.png' }],
        },
        {
          name: 'Milk', assetKind: 'prop',
          images: [{ isSelected: true, imageUrl: 'milk.png' }],
        },
      ],
    }, {
      characters: JSON.stringify([{ name: 'Hero' }, { name: 'Missing' }, { name: 'Friend' }]),
      location: 'Cafe',
      props: JSON.stringify(['Missing Prop', 'Milk']),
      sketchImageUrl: 'sketch.png',
    })

    expect(references).toEqual([
      'hero.png', 'friend.png', 'cafe.png', 'milk.png', 'sketch.png',
    ])
  })

  it('missing panelId -> explicit error', async () => {
    const job = buildJob({}, '')
    await expect(handlePanelImageTask(job)).rejects.toThrow('panelId missing')
  })

  it('first generation -> persists main image and candidate list', async () => {
    const job = buildJob({ candidateCount: 2, comfyWorkflowVersionId: 'image-version-1' })
    const result = await handlePanelImageTask(job)

    expect(result).toEqual({
      panelId: 'panel-1',
      candidateCount: 2,
      imageUrl: 'cos/panel-candidate-1.png',
    })

    expect(utilsMock.resolveImageSourceFromGeneration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        modelId: 'storyboard-model-1',
        prompt: 'panel-image-prompt',
        allowTaskExternalIdResume: false,
        options: expect.objectContaining({
          referenceImages: ['normalized-ref-1'],
          aspectRatio: '16:9',
        }),
      }),
    )
    expect(utilsMock.resolveImageSourceFromGeneration.mock.calls[0]?.[1]).toMatchObject({
      invocationKey: 'task-panel-image-1:panel:panel-1:candidate:0',
      comfyWorkflowVersionId: 'image-version-1',
      comfyReferenceImages: ['users/u/projects/p/ref-1.png'],
    })
    expect(utilsMock.resolveImageSourceFromGeneration.mock.calls[1]?.[1]).toMatchObject({
      invocationKey: 'task-panel-image-1:panel:panel-1:candidate:1',
      comfyWorkflowVersionId: 'image-version-1',
      comfyReferenceImages: ['users/u/projects/p/ref-1.png'],
    })
    expect(promptMock.buildPrompt).toHaveBeenCalledWith(expect.objectContaining({
      variables: expect.objectContaining({
        storyboard_text_json_input: expect.stringContaining('"slot": "街道左侧靠墙的留白位置"'),
      }),
    }))
    expect(promptMock.buildPrompt).toHaveBeenCalledWith(expect.objectContaining({
      variables: expect.objectContaining({
        storyboard_text_json_input: expect.stringContaining('"available_slots"'),
      }),
    }))
    expect(promptMock.buildPrompt).toHaveBeenCalledWith(expect.objectContaining({
      variables: expect.objectContaining({
        storyboard_text_json_input: expect.stringContaining('"description": "雨夜街道"'),
      }),
    }))
    expect(promptMock.buildPrompt).toHaveBeenCalledWith(expect.objectContaining({
      variables: expect.objectContaining({
        storyboard_text_json_input: expect.stringContaining('"index": "image0"'),
      }),
    }))

    expect(prismaMock.novelPromotionPanel.update).toHaveBeenCalledWith({
      where: { id: 'panel-1' },
      data: {
        imageUrl: 'cos/panel-candidate-1.png',
        candidateImages: JSON.stringify(['cos/panel-candidate-1.png', 'cos/panel-candidate-2.png']),
      },
    })
  })

  it('regeneration branch -> keeps old image in previousImageUrl and stores candidates only', async () => {
    utilsMock.resolveImageSourceFromGeneration.mockReset()
    utilsMock.uploadImageSourceToCos.mockReset()

    prismaMock.novelPromotionPanel.findUnique.mockResolvedValueOnce({
      id: 'panel-1',
      storyboardId: 'storyboard-1',
      panelIndex: 0,
      shotType: 'close-up',
      cameraMove: 'static',
      description: 'hero close-up',
      imagePrompt: null,
      videoPrompt: 'dramatic',
      location: 'Old Town',
      characters: '[]',
      srtSegment: null,
      photographyRules: null,
      actingNotes: null,
      sketchImageUrl: null,
      imageUrl: 'cos/panel-old.png',
    })

    utilsMock.resolveImageSourceFromGeneration.mockResolvedValueOnce('generated-source-regen')
    utilsMock.uploadImageSourceToCos.mockResolvedValueOnce('cos/panel-regenerated.png')

    const job = buildJob({ candidateCount: 1 })
    const result = await handlePanelImageTask(job)

    expect(result).toEqual({
      panelId: 'panel-1',
      candidateCount: 1,
      imageUrl: null,
    })

    expect(prismaMock.novelPromotionPanel.update).toHaveBeenCalledWith({
      where: { id: 'panel-1' },
      data: {
        previousImageUrl: 'cos/panel-old.png',
        candidateImages: JSON.stringify(['cos/panel-regenerated.png']),
      },
    })
  })

  it('uses one shared compact eight-image list for prompt and generation inputs', async () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({
      source: `source-ref-${index}.png`,
      url: `ref-${index}.png`, kind: 'character' as const, name: `Character ${index}`,
    }))
    sharedMock.collectPanelReferenceImageEntries.mockResolvedValueOnce(entries)
    outboundMock.normalizeReferenceImagesForGeneration.mockImplementationOnce(async (values) => (
      values.map((value) => `normalized-${value}`)
    ))
    utilsMock.resolveImageSourceFromGeneration.mockReset()
    utilsMock.resolveImageSourceFromGeneration.mockResolvedValueOnce('generated-source-capped')
    utilsMock.uploadImageSourceToCos.mockReset()
    utilsMock.uploadImageSourceToCos.mockResolvedValueOnce('cos/capped.png')

    await handlePanelImageTask(buildJob({ candidateCount: 1 }))

    const generation = utilsMock.resolveImageSourceFromGeneration.mock.calls[0]?.[1]
    expect(generation.comfyReferenceImages).toEqual(entries.slice(0, 8).map((entry) => entry.source))
    expect(generation.options.referenceImages).toEqual(
      entries.slice(0, 8).map((entry) => `normalized-${entry.url}`),
    )
    const promptPayload = promptMock.buildPrompt.mock.calls[0]?.[0]
    expect(promptPayload.variables.storyboard_text_json_input).toContain('"index": "image7"')
    expect(promptPayload.variables.storyboard_text_json_input).not.toContain('"index": "image8"')
  })

  it('uses the validated task capability snapshot for the generator call', async () => {
    const job = buildJob({
      candidateCount: 1,
      imageModel: 'fal::banana-2',
      generationOptions: { resolution: '4K', aspectRatio: '1:1' },
    })
    await handlePanelImageTask(job)

    expect(utilsMock.resolveImageSourceFromGeneration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        modelId: 'fal::banana-2',
        options: expect.objectContaining({ resolution: '4K', aspectRatio: '1:1' }),
      }),
    )
    expect(promptMock.buildPrompt).toHaveBeenCalledWith(expect.objectContaining({
      variables: expect.objectContaining({ aspect_ratio: '1:1' }),
    }))
  })
})
