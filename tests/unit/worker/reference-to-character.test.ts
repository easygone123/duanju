import { DelayedError, type Job } from 'bullmq'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CHARACTER_PROMPT_SUFFIX, CHARACTER_IMAGE_BANANA_RATIO } from '@/lib/constants'
import { TASK_TYPE, type TaskJobData, type TaskType } from '@/lib/task/types'

const sharpMock = vi.hoisted(() =>
  vi.fn(() => {
    const chain = {
      metadata: vi.fn(async () => ({ width: 2160, height: 2160 })),
      extend: vi.fn(() => chain),
      composite: vi.fn(() => chain),
      jpeg: vi.fn(() => chain),
      toBuffer: vi.fn(async () => Buffer.from('processed-image')),
    }
    return chain
  }),
)

const generatorApiMock = vi.hoisted(() => ({
  generateImage: vi.fn<(userId: string, modelId: string, prompt: string, options?: Record<string, unknown>) => Promise<{
    success: boolean
    imageUrl: string
    async: boolean
  }>>(async () => ({
    success: true,
    imageUrl: 'https://example.com/generated.jpg',
    async: false,
  })),
}))

const asyncSubmitMock = vi.hoisted(() => ({
  queryFalStatus: vi.fn(async () => ({ completed: false, failed: false, resultUrl: null })),
}))

const arkApiMock = vi.hoisted(() => ({
  fetchWithTimeoutAndRetry: vi.fn(async () => ({
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  })),
}))

const apiConfigMock = vi.hoisted(() => ({
  getProviderConfig: vi.fn(async () => ({ apiKey: 'fal-key' })),
}))

const configServiceMock = vi.hoisted(() => ({
  getUserModelConfig: vi.fn(async () => ({
    characterModel: 'character-model-1',
    analysisModel: 'analysis-model-1',
  })),
}))

const llmClientMock = vi.hoisted(() => ({
  chatCompletionWithVision: vi.fn(async () => ({ output_text: 'AI_EXTRACTED_DESCRIPTION' })),
  getCompletionContent: vi.fn(() => 'AI_EXTRACTED_DESCRIPTION'),
}))

const cosMock = vi.hoisted(() => {
  let keyIndex = 0
  return {
    generateUniqueKey: vi.fn(() => `reference-key-${++keyIndex}.jpg`),
    getSignedUrl: vi.fn((key: string) => `https://signed.example/${key}`),
    uploadObject: vi.fn(async (_buffer: Buffer, key: string) => `cos/${key}`),
  }
})

const fontsMock = vi.hoisted(() => ({
  initializeFonts: vi.fn(async () => {}),
  createLabelSVG: vi.fn(async () => Buffer.from('<svg />')),
}))

const workersSharedMock = vi.hoisted(() => ({
  reportTaskProgress: vi.fn(async () => {}),
}))

const mediaServiceMock = vi.hoisted(() => ({
  ensureMediaObjectFromStorageKey: vi.fn(async () => ({ id: 'media-reference-generated' })),
}))

const workersUtilsMock = vi.hoisted(() => ({
  assertTaskActive: vi.fn(async () => {}),
  resolveImageSourceFromGeneration: vi.fn<(
    job: Job<TaskJobData>,
    params: { invocationKey: string },
  ) => Promise<string>>(async () => 'https://example.com/comfy-generated.jpg'),
}))

const promptI18nMock = vi.hoisted(() => ({
  PROMPT_IDS: {
    CHARACTER_IMAGE_TO_DESCRIPTION: 'character_image_to_description',
    CHARACTER_REFERENCE_TO_SHEET: 'character_reference_to_sheet',
  },
  buildPrompt: vi.fn((input: { promptId: string }) => (
    input.promptId === 'character_reference_to_sheet'
      ? 'BASE_REFERENCE_PROMPT'
      : 'ANALYSIS_PROMPT'
  )),
}))

const prismaMock = vi.hoisted(() => ({
  globalCharacterAppearance: {
    update: vi.fn<(input: { data?: Record<string, unknown>; where?: Record<string, unknown> }) => Promise<Record<string, never>>>(
      async () => ({}),
    ),
  },
  characterAppearance: {
    update: vi.fn(async () => ({})),
  },
}))

vi.mock('sharp', () => ({
  default: sharpMock,
}))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/generator-api', () => generatorApiMock)
vi.mock('@/lib/async-submit', () => asyncSubmitMock)
vi.mock('@/lib/ark-api', () => arkApiMock)
vi.mock('@/lib/api-config', () => apiConfigMock)
vi.mock('@/lib/config-service', () => configServiceMock)
vi.mock('@/lib/media/outbound-image', () => ({
  normalizeReferenceImagesForGeneration: vi.fn(async (values: string[]) => values),
}))
vi.mock('@/lib/media/service', () => mediaServiceMock)
vi.mock('@/lib/llm-client', () => llmClientMock)
vi.mock('@/lib/storage', () => cosMock)
vi.mock('@/lib/fonts', () => fontsMock)
vi.mock('@/lib/workers/shared', () => workersSharedMock)
vi.mock('@/lib/workers/utils', () => workersUtilsMock)
vi.mock('@/lib/prompt-i18n', () => promptI18nMock)

import { handleReferenceToCharacterTask } from '@/lib/workers/handlers/reference-to-character'

function buildJob(payload: Record<string, unknown>, type: TaskType): Job<TaskJobData> {
  return {
    data: {
      taskId: 'task-1',
      type,
      locale: 'zh',
      projectId: 'project-1',
      targetType: 'GlobalCharacter',
      targetId: 'target-1',
      payload,
      userId: 'user-1',
    },
  } as unknown as Job<TaskJobData>
}

function readGenerateCall(index: number) {
  const call = workersUtilsMock.resolveImageSourceFromGeneration.mock.calls[index]
  if (!call) {
    return {
      prompt: '',
      options: {} as Record<string, unknown>,
    }
  }
  const params = call[1] as { prompt?: unknown; options?: unknown } | undefined
  const prompt = typeof params?.prompt === 'string' ? params.prompt : ''
  const options = (typeof params?.options === 'object' && params.options)
    ? params.options as Record<string, unknown>
    : {}
  return { prompt, options }
}

describe('worker reference-to-character', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fails fast when reference images are missing', async () => {
    const job = buildJob({}, TASK_TYPE.ASSET_HUB_REFERENCE_TO_CHARACTER)
    await expect(handleReferenceToCharacterTask(job)).rejects.toThrow('Missing referenceImageUrl or referenceImageUrls')
  })

  it('fails fast on unsupported task type', async () => {
    const job = buildJob(
      { referenceImageUrl: 'https://example.com/ref.png' },
      'unsupported-task' as TaskType,
    )
    await expect(handleReferenceToCharacterTask(job)).rejects.toThrow('Unsupported task type')
  })

  it('uses suffix prompt and disables reference-image injection when customDescription is provided', async () => {
    const job = buildJob(
      {
        referenceImageUrls: ['https://example.com/ref-a.png', 'https://example.com/ref-b.png'],
        customDescription: '冷静黑发角色',
        characterName: 'Hero',
      },
      TASK_TYPE.ASSET_HUB_REFERENCE_TO_CHARACTER,
    )

    const result = await handleReferenceToCharacterTask(job)

    expect(result).toEqual(expect.objectContaining({ success: true }))
    expect(workersUtilsMock.resolveImageSourceFromGeneration).toHaveBeenCalledTimes(3)
    expect(fontsMock.initializeFonts).not.toHaveBeenCalled()
    expect(fontsMock.createLabelSVG).not.toHaveBeenCalled()

    const { prompt, options } = readGenerateCall(0)
    expect(prompt).toContain('冷静黑发角色')
    expect(prompt).toContain(CHARACTER_PROMPT_SUFFIX)
    expect(options.aspectRatio).toBe(CHARACTER_IMAGE_BANANA_RATIO)
    expect(options.referenceImages).toBeUndefined()
  })

  it('keeps three-view suffix in template flow and writes extracted description in background mode', async () => {
    const job = buildJob(
      {
        referenceImageUrls: [' https://example.com/ref-a.png ', 'https://example.com/ref-b.png'],
        isBackgroundJob: true,
        characterId: 'character-1',
        appearanceId: 'appearance-1',
        characterName: 'Hero',
      },
      TASK_TYPE.ASSET_HUB_REFERENCE_TO_CHARACTER,
    )

    const result = await handleReferenceToCharacterTask(job)

    expect(result).toEqual(expect.objectContaining({ success: true }))
    expect(workersUtilsMock.resolveImageSourceFromGeneration).toHaveBeenCalledTimes(3)
    expect(fontsMock.initializeFonts).not.toHaveBeenCalled()
    expect(fontsMock.createLabelSVG).not.toHaveBeenCalled()

    const { prompt, options } = readGenerateCall(0)
    expect(prompt).toContain('BASE_REFERENCE_PROMPT')
    expect(prompt).toContain(CHARACTER_PROMPT_SUFFIX)
    expect(prompt.endsWith(CHARACTER_PROMPT_SUFFIX)).toBe(true)
    expect(options.referenceImages).toEqual(['https://example.com/ref-a.png', 'https://example.com/ref-b.png'])
    expect(options.aspectRatio).toBe(CHARACTER_IMAGE_BANANA_RATIO)

    const updateArg = prismaMock.globalCharacterAppearance.update.mock.calls[0]?.[0] as {
      data?: Record<string, unknown>
      where?: Record<string, unknown>
    } | undefined
    const updateData = updateArg?.data || {}
    expect(updateArg?.where).toEqual({ id: 'appearance-1' })
    expect(updateData.description).toBe('AI_EXTRACTED_DESCRIPTION')
    expect(updateData.descriptions).toBe(JSON.stringify(Array(3).fill('AI_EXTRACTED_DESCRIPTION')))
    expect(typeof updateData.imageUrls).toBe('string')
    expect(updateData.imageUrl).toMatch(/^cos\/reference-key-\d+\.jpg$/)
    expect(updateData.imageMediaId).toBe('media-reference-generated')
    expect(mediaServiceMock.ensureMediaObjectFromStorageKey).toHaveBeenCalledWith(updateData.imageUrl)
  })

  it('persists canonical descriptions and media relation for project background conversion', async () => {
    const job = buildJob(
      {
        referenceImageUrl: 'https://example.com/ref-a.png',
        isBackgroundJob: true,
        characterId: 'character-1',
        appearanceId: 'appearance-project-1',
        characterName: 'Hero',
        count: 2,
      },
      TASK_TYPE.REFERENCE_TO_CHARACTER,
    )

    await handleReferenceToCharacterTask(job)

    const updateArg = prismaMock.characterAppearance.update.mock.calls[0]?.[0] as {
      data?: Record<string, unknown>
      where?: Record<string, unknown>
    } | undefined
    const updateData = updateArg?.data || {}
    expect(updateArg?.where).toEqual({ id: 'appearance-project-1' })
    expect(updateData.description).toBe('AI_EXTRACTED_DESCRIPTION')
    expect(updateData.descriptions).toBe(JSON.stringify(Array(2).fill('AI_EXTRACTED_DESCRIPTION')))
    expect(updateData.imageMediaId).toBe('media-reference-generated')
    expect(mediaServiceMock.ensureMediaObjectFromStorageKey).toHaveBeenCalledWith(updateData.imageUrl)
  })

  it('uses requested count when generating reference character sheets', async () => {
    const job = buildJob(
      {
        referenceImageUrls: ['https://example.com/ref-a.png'],
        characterName: 'Hero',
        count: 5,
      },
      TASK_TYPE.REFERENCE_TO_CHARACTER,
    )

    const result = await handleReferenceToCharacterTask(job)

    expect(result).toEqual(expect.objectContaining({ success: true }))
    expect(workersUtilsMock.resolveImageSourceFromGeneration).toHaveBeenCalledTimes(5)
    const cosKeys = (result as { cosKeys?: string[] }).cosKeys
    expect(cosKeys).toHaveLength(5)
    expect(cosKeys?.every((item) => item.startsWith('cos/reference-key-'))).toBe(true)
  })

  it('adds project label bars only for project reference generation', async () => {
    const job = buildJob(
      {
        referenceImageUrls: ['https://example.com/ref-a.png'],
        characterName: 'Hero',
        count: 1,
      },
      TASK_TYPE.REFERENCE_TO_CHARACTER,
    )

    await handleReferenceToCharacterTask(job)

    expect(fontsMock.initializeFonts).toHaveBeenCalledTimes(1)
    expect(fontsMock.createLabelSVG).toHaveBeenCalledTimes(1)
  })

  it('serializes ComfyUI multi-image invocations on the same BullMQ job in index order', async () => {
    configServiceMock.getUserModelConfig.mockResolvedValueOnce({
      characterModel: 'comfyui::workflow-1',
      analysisModel: '',
    })
    let active = 0
    let maxActive = 0
    const invocationOrder: string[] = []
    workersUtilsMock.resolveImageSourceFromGeneration.mockImplementation(async (_job, params) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      invocationOrder.push(params.invocationKey)
      await new Promise((resolve) => setTimeout(resolve, 0))
      active -= 1
      return 'https://example.com/comfy-generated.jpg'
    })

    await handleReferenceToCharacterTask(buildJob({
      referenceImageUrl: 'https://example.com/ref.png', count: 3,
    }, TASK_TYPE.ASSET_HUB_REFERENCE_TO_CHARACTER))

    expect(maxActive).toBe(1)
    expect(invocationOrder).toEqual([
      'task-1:reference-character:ref-char:image:0',
      'task-1:reference-character:ref-char:image:1',
      'task-1:reference-character:ref-char:image:2',
    ])
  })

  it('keeps cloud multi-image generation parallel', async () => {
    let active = 0
    let maxActive = 0
    workersUtilsMock.resolveImageSourceFromGeneration.mockImplementation(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 0))
      active -= 1
      return 'https://example.com/generated.jpg'
    })

    await handleReferenceToCharacterTask(buildJob({
      referenceImageUrl: 'https://example.com/ref.png', count: 3,
    }, TASK_TYPE.ASSET_HUB_REFERENCE_TO_CHARACTER))

    expect(maxActive).toBeGreaterThan(1)
  })

  it('stops at the first waiting ComfyUI invocation and resumes it before starting the next index', async () => {
    configServiceMock.getUserModelConfig.mockResolvedValue({
      characterModel: 'comfyui::workflow-1',
      analysisModel: '',
    })
    const firstCycle: string[] = []
    workersUtilsMock.resolveImageSourceFromGeneration.mockImplementation(async (_job, params) => {
      firstCycle.push(params.invocationKey)
      throw new DelayedError()
    })
    const job = buildJob({
      referenceImageUrl: 'https://example.com/ref.png', count: 3,
    }, TASK_TYPE.ASSET_HUB_REFERENCE_TO_CHARACTER)

    await expect(handleReferenceToCharacterTask(job)).rejects.toMatchObject({ name: 'DelayedError' })
    expect(firstCycle).toEqual(['task-1:reference-character:ref-char:image:0'])

    const secondCycle: string[] = []
    workersUtilsMock.resolveImageSourceFromGeneration.mockImplementation(async (_job, params) => {
      secondCycle.push(params.invocationKey)
      if (params.invocationKey.endsWith(':1')) throw new DelayedError()
      return 'https://example.com/comfy-generated.jpg'
    })
    await expect(handleReferenceToCharacterTask(job)).rejects.toMatchObject({ name: 'DelayedError' })
    expect(secondCycle).toEqual([
      'task-1:reference-character:ref-char:image:0',
      'task-1:reference-character:ref-char:image:1',
    ])
  })
})
