import type { Job } from 'bullmq'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TASK_TYPE, type TaskJobData } from '@/lib/task/types'

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  novelPromotionCharacter: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(async () => ({})),
  },
  characterAppearance: {
    create: vi.fn(async () => ({})),
    deleteMany: vi.fn(async () => ({ count: 1 })),
  },
}))

const llmMock = vi.hoisted(() => ({
  chatCompletion: vi.fn(async () => ({ id: 'completion-1' })),
  getCompletionContent: vi.fn(),
}))

const helperMock = vi.hoisted(() => ({
  resolveProjectModel: vi.fn(async () => ({
    id: 'project-1',
    novelPromotionData: {
      id: 'np-project-1',
      analysisModel: 'llm::analysis-1',
    },
  })),
}))

const workerMock = vi.hoisted(() => ({
  reportTaskProgress: vi.fn(async () => undefined),
  assertTaskActive: vi.fn(async () => undefined),
}))

const promptMock = vi.hoisted(() => ({
  buildPrompt: vi.fn((_input: { variables: { character_profiles: string } }) => 'character-visual-prompt'),
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/llm-client', () => llmMock)
vi.mock('@/types/character-profile', () => ({
  validateProfileData: vi.fn(() => true),
  stringifyProfileData: vi.fn((value: unknown) => JSON.stringify(value)),
}))
vi.mock('@/lib/llm-observe/internal-stream-context', () => ({
  withInternalLLMStreamCallbacks: vi.fn(async (_callbacks: unknown, fn: () => Promise<unknown>) => await fn()),
}))
vi.mock('@/lib/workers/shared', () => ({ reportTaskProgress: workerMock.reportTaskProgress }))
vi.mock('@/lib/workers/utils', () => ({ assertTaskActive: workerMock.assertTaskActive }))
vi.mock('@/lib/workers/handlers/llm-stream', () => ({
  createWorkerLLMStreamContext: vi.fn(() => ({ streamRunId: 'run-1', nextSeqByStepLane: {} })),
  createWorkerLLMStreamCallbacks: vi.fn(() => ({
    onStage: vi.fn(),
    onChunk: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
    flush: vi.fn(async () => undefined),
  })),
}))
vi.mock('@/lib/workers/handlers/character-profile-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/workers/handlers/character-profile-helpers')>(
    '@/lib/workers/handlers/character-profile-helpers',
  )
  return {
    ...actual,
    resolveProjectModel: helperMock.resolveProjectModel,
  }
})
vi.mock('@/lib/prompt-i18n', () => ({
  PROMPT_IDS: { NP_AGENT_CHARACTER_VISUAL: 'np_agent_character_visual' },
  buildPrompt: promptMock.buildPrompt,
}))

import { handleCharacterProfileTask } from '@/lib/workers/handlers/character-profile'

function buildJob(type: TaskJobData['type'], payload: Record<string, unknown>): Job<TaskJobData> {
  return {
    data: {
      taskId: 'task-character-profile-1',
      type,
      locale: 'zh',
      projectId: 'project-1',
      episodeId: null,
      targetType: 'NovelPromotionCharacter',
      targetId: 'character-1',
      payload,
      userId: 'user-1',
    },
  } as unknown as Job<TaskJobData>
}

describe('worker character-profile behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
      return await callback(prismaMock)
    })

    llmMock.getCompletionContent.mockReturnValue(
      JSON.stringify({
        characters: [
          {
            appearances: [
              {
                change_reason: '默认形象',
                descriptions: ['二十五岁男性，剑眉星目，黑色短发，身穿深蓝风衣与黑色长靴。'],
              },
            ],
          },
        ],
      }),
    )

    prismaMock.novelPromotionCharacter.findFirst.mockImplementation(async (args: { where: { id: string } }) => ({
      id: args.where.id,
      name: args.where.id === 'character-2' ? 'Villain' : '我',
      aliases: JSON.stringify(args.where.id === 'character-2' ? [] : ['林墨']),
      introduction: args.where.id === 'character-2'
        ? '故事反派'
        : '故事主角，小说以第一人称「我」叙述。',
      profileData: JSON.stringify({ archetype: 'lead' }),
      profileConfirmed: false,
      novelPromotionProjectId: 'np-project-1',
    }))

    prismaMock.novelPromotionCharacter.findMany.mockResolvedValue([
      {
        id: 'character-1',
        name: 'Hero',
        profileData: JSON.stringify({ archetype: 'lead' }),
        profileConfirmed: false,
      },
      {
        id: 'character-2',
        name: 'Villain',
        profileData: JSON.stringify({ archetype: 'antagonist' }),
        profileConfirmed: false,
      },
    ])
  })

  it('unsupported task type -> explicit error', async () => {
    const job = buildJob(TASK_TYPE.AI_CREATE_CHARACTER, {})
    await expect(handleCharacterProfileTask(job)).rejects.toThrow('Unsupported character profile task type')
  })

  it('confirm profile success -> rebuilds appearances and marks profileConfirmed', async () => {
    const job = buildJob(TASK_TYPE.CHARACTER_PROFILE_CONFIRM, { characterId: 'character-1' })
    const result = await handleCharacterProfileTask(job)

    expect(prismaMock.characterAppearance.deleteMany).toHaveBeenCalledWith({
      where: { characterId: 'character-1' },
    })
    expect(prismaMock.characterAppearance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        characterId: 'character-1',
        appearanceIndex: 0,
        changeReason: '默认形象',
        description: '二十五岁男性，剑眉星目，黑色短发，身穿深蓝风衣与黑色长靴。',
      }),
    })

    expect(prismaMock.novelPromotionCharacter.update).toHaveBeenCalledWith({
      where: { id: 'character-1' },
      data: {
        profileData: JSON.stringify({ archetype: 'lead' }),
        profileConfirmed: true,
      },
    })

    expect(result).toEqual(expect.objectContaining({
      success: true,
      character: expect.objectContaining({
        id: 'character-1',
        profileConfirmed: true,
      }),
    }))

    const promptInput = promptMock.buildPrompt.mock.calls[0]![0]
    const profile = JSON.parse(promptInput.variables.character_profiles)[0]
    expect(profile).toMatchObject({
      name: '我',
      aliases: ['林墨'],
      introduction: '故事主角，小说以第一人称「我」叙述。',
      archetype: 'lead',
    })
  })

  it('rejects a one-character visual description instead of persisting it', async () => {
    llmMock.getCompletionContent.mockReturnValue(JSON.stringify({
      characters: [{ appearances: [{ change_reason: '初始形象', descriptions: ['我'] }] }],
    }))

    const job = buildJob(TASK_TYPE.CHARACTER_PROFILE_CONFIRM, { characterId: 'character-1' })

    await expect(handleCharacterProfileTask(job)).rejects.toThrow('AI返回格式错误: 形象描述无效')
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.characterAppearance.create).not.toHaveBeenCalled()
  })

  it('batch confirm -> loops through all unconfirmed characters and returns count', async () => {
    const job = buildJob(TASK_TYPE.CHARACTER_PROFILE_BATCH_CONFIRM, {})
    const result = await handleCharacterProfileTask(job)

    expect(result).toEqual({
      success: true,
      count: 2,
    })
    expect(prismaMock.characterAppearance.create).toHaveBeenCalledTimes(2)
  })

  it('reconfirm with existing appearances -> replaces old rows instead of colliding on unique index', async () => {
    const job = buildJob(TASK_TYPE.CHARACTER_PROFILE_CONFIRM, { characterId: 'character-1' })

    await expect(handleCharacterProfileTask(job)).resolves.toEqual(expect.objectContaining({
      success: true,
    }))

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(prismaMock.characterAppearance.deleteMany).toHaveBeenCalledWith({
      where: { characterId: 'character-1' },
    })
    expect(prismaMock.characterAppearance.create).toHaveBeenCalledTimes(1)
  })
})
