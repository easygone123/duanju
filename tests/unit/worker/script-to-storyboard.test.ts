import type { Job } from 'bullmq'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TASK_TYPE, type TaskJobData } from '@/lib/task/types'

type VoiceLineInput = {
  lineIndex: number
  speaker: string
  content: string
  emotionStrength: number
  matchedPanel: {
    storyboardId: string
    panelIndex: number
  }
}

const reportTaskProgressMock = vi.hoisted(() => vi.fn(async () => undefined))
const assertTaskActiveMock = vi.hoisted(() => vi.fn(async () => undefined))
const chatCompletionMock = vi.hoisted(() => vi.fn(async () => ({ responseId: 'resp-1' })))
const getCompletionPartsMock = vi.hoisted(() => vi.fn(() => ({ text: 'voice lines json', reasoning: '' })))
const withInternalLLMStreamCallbacksMock = vi.hoisted(() =>
  vi.fn(async (_callbacks: unknown, fn: () => Promise<unknown>) => await fn()),
)
const resolveProjectModelCapabilityGenerationOptionsMock = vi.hoisted(() =>
  vi.fn(async () => ({ reasoningEffort: 'high' })),
)
const runScriptToStoryboardOrchestratorMock = vi.hoisted(() =>
  vi.fn(async () => ({
    clipPanels: [
      {
        clipId: 'clip-1',
        clipIndex: 0,
        finalPanels: [
          {
            panel_number: 1,
            shot_type: 'close-up',
            camera_move: 'static',
            description: 'panel desc',
            video_prompt: 'panel prompt',
            location: 'room',
            characters: ['Narrator'],
          },
        ],
      },
    ],
    summary: {
      totalPanelCount: 1,
      totalStepCount: 4,
    },
  })),
)
const parseVoiceLinesJsonMock = vi.hoisted(() => vi.fn())
const persistStoryboardOutputsMock = vi.hoisted(() => vi.fn())
const parseStoryboardRetryTargetMock = vi.hoisted(() => vi.fn())
const runScriptToStoryboardAtomicRetryMock = vi.hoisted(() => vi.fn())
const createArtifactMock = vi.hoisted(() => vi.fn(async () => undefined))
const replaceArtifactsBatchMock = vi.hoisted(() => vi.fn(async (params: unknown) => {
  void params
  return []
}))
const getRunInputSnapshotMock = vi.hoisted(() => vi.fn())
const workflowLeaseMock = vi.hoisted(() => ({
  assertWorkflowRunActive: vi.fn(async () => undefined),
  withWorkflowRunLease: vi.fn(async (params: { run: () => Promise<unknown> }) => ({
    claimed: true,
    result: await params.run(),
  })),
}))

const txState = vi.hoisted(() => ({
  createdRows: [] as Array<Record<string, unknown>>,
  deletedWhereClauses: [] as Array<Record<string, unknown>>,
}))

const prismaMock = vi.hoisted(() => ({
  project: {
    findUnique: vi.fn(),
  },
  novelPromotionProject: {
    findUnique: vi.fn(),
  },
  novelPromotionEpisode: {
    findUnique: vi.fn(),
  },
  $transaction: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

vi.mock('@/lib/llm-client', () => ({
  chatCompletion: chatCompletionMock,
  getCompletionParts: getCompletionPartsMock,
  getCompletionContent: vi.fn(() => 'voice lines json'),
}))

vi.mock('@/lib/config-service', () => ({
  resolveProjectModelCapabilityGenerationOptions: resolveProjectModelCapabilityGenerationOptionsMock,
  getUserWorkflowConcurrencyConfig: vi.fn(async () => ({
    analysis: 2,
    image: 5,
    video: 5,
  })),
}))

vi.mock('@/lib/llm-observe/internal-stream-context', () => ({
  withInternalLLMStreamCallbacks: withInternalLLMStreamCallbacksMock,
}))

vi.mock('@/lib/logging/semantic', () => ({
  logAIAnalysis: vi.fn(),
}))

vi.mock('@/lib/logging/file-writer', () => ({
  onProjectNameAvailable: vi.fn(),
}))

vi.mock('@/lib/constants', () => ({
  buildCharactersIntroduction: vi.fn(() => 'characters-introduction'),
}))

vi.mock('@/lib/workers/shared', () => ({
  reportTaskProgress: reportTaskProgressMock,
}))

vi.mock('@/lib/workers/utils', () => ({
  assertTaskActive: assertTaskActiveMock,
}))

vi.mock('@/lib/novel-promotion/script-to-storyboard/orchestrator', () => ({
  runScriptToStoryboardOrchestrator: runScriptToStoryboardOrchestratorMock,
  JsonParseError: class JsonParseError extends Error {
    rawText: string

    constructor(message: string, rawText: string) {
      super(message)
      this.name = 'JsonParseError'
      this.rawText = rawText
    }
  },
}))
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

vi.mock('@/lib/prompt-i18n', () => ({
  PROMPT_IDS: {
    NP_AGENT_STORYBOARD_PLAN: 'plan',
    NP_AGENT_CINEMATOGRAPHER: 'cinematographer',
    NP_AGENT_ACTING_DIRECTION: 'acting',
    NP_AGENT_STORYBOARD_DETAIL: 'detail',
    NP_VOICE_ANALYSIS: 'voice-analysis',
  },
  getPromptTemplate: vi.fn(() => 'prompt-template'),
  buildPrompt: vi.fn(() => 'voice-analysis-prompt'),
}))

vi.mock('@/lib/workers/handlers/script-to-storyboard-helpers', () => ({
  asJsonRecord: (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, unknown>
  },
  buildStoryboardJsonFromClipPanels: vi.fn(() => '[]'),
  parseEffort: vi.fn(() => null),
  parseTemperature: vi.fn(() => 0.7),
  parseVoiceLinesJson: parseVoiceLinesJsonMock,
  persistStoryboardOutputs: persistStoryboardOutputsMock,
  toPositiveInt: (value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    const n = Math.floor(value)
    return n > 0 ? n : null
  },
}))
vi.mock('@/lib/workers/handlers/script-to-storyboard-atomic-retry', () => ({
  parseStoryboardRetryTarget: parseStoryboardRetryTargetMock,
  runScriptToStoryboardAtomicRetry: runScriptToStoryboardAtomicRetryMock,
}))
vi.mock('@/lib/run-runtime/workflow-lease', () => workflowLeaseMock)
vi.mock('@/lib/run-runtime/service', () => ({
  createArtifact: createArtifactMock,
  getRunInputSnapshot: getRunInputSnapshotMock,
  replaceArtifactsBatch: replaceArtifactsBatchMock,
  serializeGraphArtifactPayload: (payload: Record<string, unknown> | null) => {
    const serialized = JSON.stringify(payload)
    return { serialized, bytes: Buffer.byteLength(serialized, 'utf8'), payload }
  },
}))

import { handleScriptToStoryboardTask } from '@/lib/workers/handlers/script-to-storyboard'

function buildJob(payload: Record<string, unknown>, episodeId: string | null = 'episode-1'): Job<TaskJobData> {
  const runId = typeof payload.runId === 'string' && payload.runId.trim() ? payload.runId.trim() : 'run-test-storyboard'
  const payloadMeta = payload.meta && typeof payload.meta === 'object' && !Array.isArray(payload.meta)
    ? (payload.meta as Record<string, unknown>)
    : {}
  const normalizedPayload: Record<string, unknown> = {
    ...payload,
    runId,
    meta: {
      ...payloadMeta,
      runId,
    },
  }
  return {
    data: {
      taskId: 'task-1',
      type: TASK_TYPE.SCRIPT_TO_STORYBOARD_RUN,
      locale: 'zh',
      projectId: 'project-1',
      episodeId,
      targetType: 'NovelPromotionEpisode',
      targetId: 'episode-1',
      payload: normalizedPayload,
      userId: 'user-1',
    },
  } as unknown as Job<TaskJobData>
}

function baseVoiceRows(): VoiceLineInput[] {
  return [
    {
      lineIndex: 1,
      speaker: 'Narrator',
      content: 'Hello world',
      emotionStrength: 0.8,
      matchedPanel: {
        storyboardId: 'storyboard-1',
        panelIndex: 1,
      },
    },
  ]
}

function mockSingleSixGridGroup() {
  const group = {
    clipId: 'clip-1',
    clipIndex: 1,
    groupId: 'six-grid:1:clip-1:1',
    groupKey: 'six-grid:1:clip-1:1',
    groupSequence: 1,
    sceneKey: 'Office',
    incomingContinuity: 'start',
    outgoingContinuity: 'end',
    finalPanels: Array.from({ length: 6 }, (_, index) => ({
      panel_number: index + 1,
      shot_type: 'close-up',
      camera_move: 'static',
      description: `panel ${index + 1}`,
      video_prompt: `prompt ${index + 1}`,
      location: 'Office',
      source_text: `source ${index + 1}`,
      characters: ['Narrator'],
    })),
  }
  runScriptToStoryboardOrchestratorMock.mockResolvedValueOnce({
    clipPanels: [group],
    sixGridGroups: [group],
    phase1PanelsByClipId: { [group.groupId]: group.finalPanels },
    phase2CinematographyByClipId: {},
    phase2ActingByClipId: {},
    phase3PanelsByClipId: { [group.groupId]: group.finalPanels },
    summary: { totalPanelCount: 6, totalStepCount: 5 },
  } as never)
}

describe('worker script-to-storyboard behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    txState.createdRows = []
    txState.deletedWhereClauses = []
    parseStoryboardRetryTargetMock.mockReturnValue(null)
    runScriptToStoryboardAtomicRetryMock.mockReset()
    getRunInputSnapshotMock.mockResolvedValue({
      runId: 'run-test-storyboard',
      projectId: 'project-1',
      episodeId: 'episode-1',
      workflowType: 'script_to_storyboard_run',
      input: { storyboardGenerationMode: 'individual' },
    })

    prismaMock.project.findUnique.mockResolvedValue({
      id: 'project-1',
      name: 'Project One',
    })

    prismaMock.novelPromotionProject.findUnique.mockResolvedValue({
      id: 'np-project-1',
      analysisModel: 'llm::analysis-model',
      characters: [{ id: 'char-1', name: 'Narrator' }],
      locations: [{ id: 'loc-1', name: 'Office' }],
    })

    prismaMock.novelPromotionEpisode.findUnique.mockResolvedValue({
      id: 'episode-1',
      novelPromotionProjectId: 'np-project-1',
      novelText: 'A complete chapter text for voice analyze.',
      clips: [
        {
          id: 'clip-1',
          content: 'clip content',
          characters: JSON.stringify(['Narrator']),
          location: 'Office',
          screenplay: 'Screenplay text',
        },
      ],
    })

    prismaMock.$transaction.mockReset()

    persistStoryboardOutputsMock.mockImplementation(async ({ voiceLineRows }: { voiceLineRows: VoiceLineInput[] | null }) => {
      const rows = voiceLineRows || []
      txState.createdRows = rows.map((row) => ({
        episodeId: 'episode-1',
        lineIndex: row.lineIndex,
        speaker: row.speaker,
        content: row.content,
        emotionStrength: row.emotionStrength,
        matchedPanelId: 'panel-1',
        matchedStoryboardId: 'storyboard-1',
        matchedPanelIndex: row.matchedPanel.panelIndex,
      }))
      txState.deletedWhereClauses = [
        rows.length === 0
          ? { episodeId: 'episode-1' }
          : {
            episodeId: 'episode-1',
            lineIndex: {
              notIn: rows.map((row) => row.lineIndex),
            },
          },
      ]
      return {
        persistedStoryboards: [
          {
            storyboardId: 'storyboard-1',
            clipId: 'clip-1',
            panels: [{ id: 'panel-1', panelIndex: 1 }],
          },
        ],
        voiceLineCount: rows.length,
      }
    })

    parseVoiceLinesJsonMock.mockReturnValue(baseVoiceRows())
  })

  it('缺少 episodeId -> 显式失败', async () => {
    const job = buildJob({}, null)
    await expect(handleScriptToStoryboardTask(job)).rejects.toThrow('episodeId is required')
  })

  it('成功路径: 写入 voice line 时包含 matchedPanel 映射后的 panelId', async () => {
    const job = buildJob({ episodeId: 'episode-1' })

    const result = await handleScriptToStoryboardTask(job)

    expect(result).toEqual({
      episodeId: 'episode-1',
      storyboardCount: 1,
      panelCount: 1,
      voiceLineCount: 1,
    })

    expect(txState.createdRows).toHaveLength(1)
    expect(txState.createdRows[0]).toEqual(expect.objectContaining({
      episodeId: 'episode-1',
      lineIndex: 1,
      speaker: 'Narrator',
      content: 'Hello world',
      emotionStrength: 0.8,
      matchedPanelId: 'panel-1',
      matchedStoryboardId: 'storyboard-1',
      matchedPanelIndex: 1,
    }))
    expect(txState.deletedWhereClauses[0]).toEqual({
      episodeId: 'episode-1',
      lineIndex: {
        notIn: [1],
      },
    })
  })

  it('将任务中的不可变六宫格运行设置传给整集编排器', async () => {
    mockSingleSixGridGroup()
    getRunInputSnapshotMock.mockResolvedValueOnce({
      runId: 'run-test-storyboard',
      projectId: 'project-1',
      episodeId: 'episode-1',
      workflowType: 'script_to_storyboard_run',
      input: {
        storyboardGenerationMode: 'six_grid',
        sixGridCellAspectRatio: '16:9',
        sixGridProcessingOrder: 'sheet_upscale_then_crop',
        storyboardUpscaleModel: 'comfyui::upscale-v1',
        dialogueVideoModel: 'comfyui::dialogue-v1',
      },
    })
    const job = buildJob({
      episodeId: 'episode-1',
      storyboardGenerationMode: 'six_grid',
      sixGridCellAspectRatio: '16:9',
      sixGridProcessingOrder: 'sheet_upscale_then_crop',
      storyboardUpscaleModel: 'comfyui::upscale-v1',
      dialogueVideoModel: 'comfyui::dialogue-v1',
    })

    await handleScriptToStoryboardTask(job)

    expect(runScriptToStoryboardOrchestratorMock).toHaveBeenCalledWith(expect.objectContaining({
      runSettings: {
        storyboardGenerationMode: 'six_grid',
        sixGridCellAspectRatio: '16:9',
        sixGridProcessingOrder: 'sheet_upscale_then_crop',
        storyboardUpscaleModel: 'comfyui::upscale-v1',
        dialogueVideoModel: 'comfyui::dialogue-v1',
      },
    }))
    expect(getRunInputSnapshotMock).toHaveBeenCalledTimes(1)
  })

  it('无效整集计划在 artifact 与持久化之前失败', async () => {
    getRunInputSnapshotMock.mockResolvedValueOnce({
      runId: 'run-test-storyboard',
      projectId: 'project-1',
      episodeId: 'episode-1',
      workflowType: 'script_to_storyboard_run',
      input: { storyboardGenerationMode: 'six_grid', sixGridCellAspectRatio: '16:9' },
    })
    runScriptToStoryboardOrchestratorMock.mockRejectedValueOnce(
      Object.assign(new Error('SIX_GRID_REQUIRES_EXACTLY_SIX_PANELS'), {
        code: 'SIX_GRID_REQUIRES_EXACTLY_SIX_PANELS',
      }),
    )
    const job = buildJob({
      episodeId: 'episode-1',
      storyboardGenerationMode: 'six_grid',
      sixGridCellAspectRatio: '16:9',
    })

    await expect(handleScriptToStoryboardTask(job))
      .rejects.toMatchObject({ code: 'SIX_GRID_REQUIRES_EXACTLY_SIX_PANELS' })
    expect(createArtifactMock).not.toHaveBeenCalled()
    expect(replaceArtifactsBatchMock).not.toHaveBeenCalled()
    expect(persistStoryboardOutputsMock).not.toHaveBeenCalled()
  })

  it('保留同 clip 多组身份并交给 six-grid 原子持久化', async () => {
    getRunInputSnapshotMock.mockResolvedValueOnce({
      runId: 'run-test-storyboard',
      projectId: 'project-1',
      episodeId: 'episode-1',
      workflowType: 'script_to_storyboard_run',
      input: { storyboardGenerationMode: 'six_grid', sixGridCellAspectRatio: '16:9' },
    })
    const sixGridGroups = [1, 2].map((groupSequence) => ({
      clipId: 'clip-1',
      clipIndex: 1,
      groupId: `six-grid:${groupSequence}:clip-1:${groupSequence}`,
      groupKey: `six-grid:${groupSequence}:clip-1:${groupSequence}`,
      groupSequence,
      sceneKey: 'Office',
      incomingContinuity: groupSequence === 1 ? 'start' : 'anchor',
      outgoingContinuity: groupSequence === 1 ? 'anchor' : 'end',
      finalPanels: Array.from({ length: 6 }, (_, index) => ({
        panel_number: index + 1,
        shot_type: 'close-up',
        camera_move: 'static',
        description: `panel ${index + 1}`,
        video_prompt: `prompt ${index + 1}`,
        location: 'Office',
        characters: ['Narrator'],
      })),
    }))
    runScriptToStoryboardOrchestratorMock.mockResolvedValueOnce({
      clipPanels: sixGridGroups,
      sixGridGroups,
      phase1PanelsByClipId: Object.fromEntries(sixGridGroups.map((group) => [group.groupId, group.finalPanels])),
      phase2CinematographyByClipId: Object.fromEntries(sixGridGroups.map((group) => [group.groupId, [{ panel_number: 1 }]])),
      phase2ActingByClipId: Object.fromEntries(sixGridGroups.map((group) => [group.groupId, [{ panel_number: 1 }]])),
      phase3PanelsByClipId: Object.fromEntries(sixGridGroups.map((group) => [group.groupId, group.finalPanels])),
      summary: { totalPanelCount: 12, totalStepCount: 8 },
    } as never)
    const job = buildJob({
      episodeId: 'episode-1',
      storyboardGenerationMode: 'six_grid',
      sixGridCellAspectRatio: '16:9',
    })

    const result = await handleScriptToStoryboardTask(job)

    expect(result).toMatchObject({
      episodeId: 'episode-1',
      storyboardCount: 1,
      panelCount: 12,
      voiceLineCount: 1,
    })
    expect(persistStoryboardOutputsMock).toHaveBeenCalledWith(expect.objectContaining({
      episodeId: 'episode-1',
      runId: 'run-test-storyboard',
      clipPanels: sixGridGroups,
      voiceLineRows: baseVoiceRows(),
      runSnapshot: expect.objectContaining({ runId: 'run-test-storyboard' }),
    }))
    const artifactBatch = replaceArtifactsBatchMock.mock.calls[0]?.[0] as {
      artifacts: Array<Record<string, unknown>>
    }
    expect(artifactBatch).toMatchObject({
      runId: 'run-test-storyboard',
      artifactTypes: expect.arrayContaining([
        'storyboard.six_grid.plan',
        'storyboard.six_grid.phase1',
        'storyboard.six_grid.phase3',
      ]),
    })
    expect(artifactBatch.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stepKey: 'six_grid_episode_plan',
        artifactType: 'storyboard.six_grid.plan',
        refId: 'episode-1',
        versionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        stepKey: 'six_grid_group_1_phase1',
        artifactType: 'storyboard.six_grid.phase1',
        refId: sixGridGroups[0].groupId,
      }),
      expect.objectContaining({
        stepKey: 'six_grid_group_2_phase3_detail',
        artifactType: 'storyboard.six_grid.phase3',
        refId: sixGridGroups[1].groupId,
      }),
    ]))
  })

  it('uses six-grid GraphRun input when the worker payload says individual', async () => {
    mockSingleSixGridGroup()
    getRunInputSnapshotMock.mockResolvedValueOnce({
      runId: 'run-test-storyboard',
      projectId: 'project-1',
      episodeId: 'episode-1',
      workflowType: 'script_to_storyboard_run',
      input: { storyboardGenerationMode: 'six_grid', sixGridCellAspectRatio: '9:16' },
    })

    await handleScriptToStoryboardTask(buildJob({
      episodeId: 'episode-1',
      storyboardGenerationMode: 'individual',
    }))

    expect(runScriptToStoryboardOrchestratorMock).toHaveBeenCalledWith(expect.objectContaining({
      runSettings: expect.objectContaining({
        storyboardGenerationMode: 'six_grid',
        sixGridCellAspectRatio: '9:16',
      }),
    }))
    expect(persistStoryboardOutputsMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-test-storyboard',
    }))
  })

  it('uses individual GraphRun input when the worker payload says six-grid', async () => {
    await handleScriptToStoryboardTask(buildJob({
      episodeId: 'episode-1',
      storyboardGenerationMode: 'six_grid',
      sixGridCellAspectRatio: '16:9',
    }))

    expect(runScriptToStoryboardOrchestratorMock).toHaveBeenCalledWith(expect.objectContaining({
      runSettings: expect.objectContaining({
        storyboardGenerationMode: 'individual',
        sixGridCellAspectRatio: null,
      }),
    }))
    expect(persistStoryboardOutputsMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-test-storyboard',
    }))
  })

  it('voice 解析失败后会重试一次再成功', async () => {
    parseVoiceLinesJsonMock
      .mockImplementationOnce(() => {
        throw new Error('invalid voice json')
      })
      .mockImplementationOnce(() => baseVoiceRows())

    const job = buildJob({ episodeId: 'episode-1' })
    const result = await handleScriptToStoryboardTask(job)

    expect(result).toEqual(expect.objectContaining({
      episodeId: 'episode-1',
      voiceLineCount: 1,
    }))
    expect(chatCompletionMock).toHaveBeenCalledTimes(2)
    expect(parseVoiceLinesJsonMock).toHaveBeenCalledTimes(2)
    expect(withInternalLLMStreamCallbacksMock).toHaveBeenCalledTimes(3)
    const firstChatCall = chatCompletionMock.mock.calls[0] as unknown as [unknown, unknown, unknown, Record<string, unknown>] | undefined
    expect(firstChatCall?.[3]).toEqual(expect.objectContaining({
      action: 'voice_analyze',
      streamStepId: 'voice_analyze',
      streamStepAttempt: 1,
    }))
    const secondChatCall = chatCompletionMock.mock.calls[1] as unknown as [unknown, unknown, unknown, Record<string, unknown>] | undefined
    expect(secondChatCall?.[3]).toEqual(expect.objectContaining({
      action: 'voice_analyze',
      streamStepId: 'voice_analyze',
      streamStepAttempt: 2,
    }))
    expect(reportTaskProgressMock).toHaveBeenCalledWith(
      job,
      84,
      expect.objectContaining({
        stage: 'script_to_storyboard_step',
        stepId: 'voice_analyze',
        stepAttempt: 2,
        message: '台词分析失败，准备重试 (2/2)',
      }),
    )
  })

  it('空台词数组 -> 成功完成并清空旧台词', async () => {
    parseVoiceLinesJsonMock.mockReturnValue([])

    const job = buildJob({ episodeId: 'episode-1' })
    const result = await handleScriptToStoryboardTask(job)

    expect(result).toEqual({
      episodeId: 'episode-1',
      storyboardCount: 1,
      panelCount: 1,
      voiceLineCount: 0,
    })
    expect(txState.createdRows).toEqual([])
    expect(txState.deletedWhereClauses[0]).toEqual({
      episodeId: 'episode-1',
    })
  })

  it('phase 级重试: 仅执行原子 phase，不走整图重跑', async () => {
    parseStoryboardRetryTargetMock.mockReturnValue({
      stepKey: 'clip_clip-1_phase3_detail',
      clipId: 'clip-1',
      phase: 'phase3_detail',
    })
    runScriptToStoryboardAtomicRetryMock.mockResolvedValue({
      clipPanels: [
        {
          clipId: 'clip-1',
          clipIndex: 1,
          finalPanels: [
            {
              panel_number: 1,
              description: 'phase3 retry panel',
              location: 'Office',
            },
          ],
        },
      ],
      phase1PanelsByClipId: {},
      phase2CinematographyByClipId: {},
      phase2ActingByClipId: {},
      phase3PanelsByClipId: {
        'clip-1': [
          {
            panel_number: 1,
            description: 'phase3 retry panel',
            location: 'Office',
          },
        ],
      },
      totalPanelCount: 1,
      totalStepCount: 6,
    })

    const job = buildJob({
      episodeId: 'episode-1',
      retryStepKey: 'clip_clip-1_phase3_detail',
      retryStepAttempt: 2,
    })
    const result = await handleScriptToStoryboardTask(job)

    expect(result).toEqual({
      episodeId: 'episode-1',
      storyboardCount: 1,
      panelCount: 1,
      voiceLineCount: 0,
      retryStepKey: 'clip_clip-1_phase3_detail',
    })
    expect(runScriptToStoryboardAtomicRetryMock).toHaveBeenCalledTimes(1)
    expect(runScriptToStoryboardOrchestratorMock).not.toHaveBeenCalled()
    expect(persistStoryboardOutputsMock).toHaveBeenCalledWith(expect.objectContaining({
      episodeId: 'episode-1',
      runId: 'run-test-storyboard',
      clipPanels: [
        {
          clipId: 'clip-1',
          clipIndex: 1,
          finalPanels: [
            {
              panel_number: 1,
              description: 'phase3 retry panel',
              location: 'Office',
            },
          ],
        },
      ],
      voiceLineRows: null,
      runSnapshot: expect.objectContaining({ runId: 'run-test-storyboard' }),
    }))
  })
})
