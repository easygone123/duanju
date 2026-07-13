import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

type PanelRow = {
  id: string
  updatedAt: Date
  hasDialogue: boolean
  dialogueSpeaker: string | null
  dialogueText: string | null
  dialogueEmotion: string | null
  includeDialogueInVideoPrompt: boolean
  videoPrompt: string
  firstLastFramePrompt: string | null
  estimatedDuration: number
  durationOverride: number | null
  duration: number
}

type SubmittedTaskInput = {
  targetId: string
  payload: Record<string, unknown>
}

const capabilityMock = vi.hoisted(() => vi.fn())
const submitTaskMock = vi.hoisted(() => vi.fn<(input: SubmittedTaskInput) => Promise<{ id: string }>>(async (input) => {
  void input
  return { id: 'task-1' }
}))
const panelFindFirstMock = vi.hoisted(() => vi.fn())
const panelFindManyMock = vi.hoisted(() => vi.fn<() => Promise<PanelRow[]>>(async () => []))
const panelUpdateManyMock = vi.hoisted(() => vi.fn(async (args: unknown) => {
  void args
  return { count: 1 }
}))
const getProjectModelConfigMock = vi.hoisted(() => vi.fn())
const comfyVersionFindFirstMock = vi.hoisted(() => vi.fn())
const userPreferenceFindUniqueMock = vi.hoisted(() => vi.fn())
const buildBillingInfoMock = vi.hoisted(() => vi.fn(() => null))

vi.mock('@/lib/model-capabilities/lookup', () => ({
  resolveBuiltinCapabilitiesByModelKey: capabilityMock,
}))
vi.mock('@/lib/api-auth', () => ({
  requireProjectAuthLight: vi.fn(async () => ({ session: { user: { id: 'user-1' } } })),
  isErrorResponse: vi.fn(() => false),
}))
vi.mock('@/lib/task/submitter', () => ({ submitTask: submitTaskMock }))
vi.mock('@/lib/billing', () => ({ buildDefaultTaskBillingInfo: buildBillingInfoMock }))
vi.mock('@/lib/task/has-output', () => ({ hasPanelVideoOutput: vi.fn(async () => false) }))
vi.mock('@/lib/task/resolve-locale', () => ({ resolveRequiredTaskLocale: vi.fn(() => 'zh') }))
vi.mock('@/lib/config-service', () => ({
  applyTrustedComfyVersionSnapshot: vi.fn((payload: Record<string, unknown>, versionId?: string | null) => {
    delete payload.comfyWorkflowVersionId
    if (versionId) payload.comfyWorkflowVersionId = versionId
    return payload
  }),
  getProjectModelConfig: getProjectModelConfigMock,
  resolveTrustedComfyWorkflowVersion: vi.fn(async (_userId: string, model: string | null) => (
    model?.startsWith('comfyui::') ? 'video-version-1' : null
  )),
  resolveProjectModelCapabilityGenerationOptions: vi.fn(async () => ({})),
}))
vi.mock('@/lib/model-pricing/lookup', () => ({
  resolveBuiltinPricing: vi.fn(() => ({ status: 'resolved' })),
}))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    novelPromotionPanel: {
      findMany: panelFindManyMock,
      findFirst: panelFindFirstMock,
      updateMany: panelUpdateManyMock,
    },
    comfyWorkflowVersion: { findFirst: comfyVersionFindFirstMock },
    userPreference: { findUnique: userPreferenceFindUniqueMock },
  },
}))

import { POST } from '@/app/api/novel-promotion/[projectId]/generate-video/route'

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/novel-promotion/project-1/generate-video', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-locale': 'zh' },
    body: JSON.stringify({ storyboardId: 'storyboard-1', panelIndex: 0, ...body }),
  })
}

describe('generate-video ComfyUI first-last-frame routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    panelFindFirstMock.mockReset()
    panelFindManyMock.mockReset()
    capabilityMock.mockReturnValue(undefined)
    panelFindFirstMock.mockResolvedValue({
      id: 'panel-1', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
      hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
      includeDialogueInVideoPrompt: true, videoPrompt: 'server visual prompt', firstLastFramePrompt: null,
      estimatedDuration: 5, durationOverride: null, duration: 5,
    })
    panelFindManyMock.mockResolvedValue([])
    panelUpdateManyMock.mockResolvedValue({ count: 1 })
    comfyVersionFindFirstMock.mockResolvedValue({
      id: 'video-version-1',
      variableDefinitions: [{ name: 'duration', type: 'number', options: [5, 10] }],
    })
    userPreferenceFindUniqueMock.mockResolvedValue({
      customModels: JSON.stringify([
        { provider: 'cloud', modelId: 'normal', type: 'video' },
        { provider: 'cloud', modelId: 'dialogue', type: 'video' },
        { provider: 'cloud', modelId: 'unsupported', type: 'video' },
      ]),
      customProviders: JSON.stringify([{ id: 'cloud', apiKey: 'secret' }]),
    })
    getProjectModelConfigMock.mockImplementation(async (_projectId: string, _userId: string, overrides?: { videoModel?: string }) => ({
      videoModel: overrides?.videoModel ?? 'cloud::normal',
      dialogueVideoModel: null,
      comfyVideoWorkflowVersionId: overrides?.videoModel?.startsWith('comfyui::') ? 'video-version-1' : null,
    }))
  })

  it('accepts strict ComfyUI first-last-frame selection without consulting cloud capabilities', async () => {
    panelFindFirstMock
      .mockResolvedValueOnce({
        id: 'panel-1', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
        hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
        includeDialogueInVideoPrompt: true, videoPrompt: 'normal prompt', firstLastFramePrompt: 'first-last prompt',
        estimatedDuration: 5, durationOverride: null, duration: 5,
      })
      .mockResolvedValueOnce({ id: 'last-panel-1' })
    const response = await POST(request({
      videoModel: 'cloud::normal',
      firstLastFrame: {
        flModel: 'comfyui::wf-video',
        lastFrameStoryboardId: 'storyboard-1',
        lastFramePanelIndex: 1,
        customPrompt: 'FORGED',
        sourcePanelId: 'foreign-client-id',
      },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })
    expect(response.status).toBe(200)
    expect(capabilityMock).not.toHaveBeenCalledWith('video', 'comfyui::wf-video')
    expect(submitTaskMock).toHaveBeenCalledTimes(1)
    expect(submitTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        videoModel: 'comfyui::wf-video',
        videoPrompt: 'first-last prompt',
        firstLastFrame: {
          flModel: 'comfyui::wf-video',
          firstFrameSourcePanelId: 'panel-1',
          sourcePanelId: 'last-panel-1',
        },
        comfyWorkflowVersionId: 'video-version-1',
        comfyModelSnapshotVersion: 1,
      }),
    }))
  })

  it('resolves a persisted manual first-frame source through owner scope before task submission', async () => {
    panelFindFirstMock
      .mockResolvedValueOnce({
        id: 'panel-1', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
        hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
        includeDialogueInVideoPrompt: true, videoPrompt: 'normal prompt', firstLastFramePrompt: 'first-last prompt',
        estimatedDuration: 5, durationOverride: null, duration: 5,
        firstFrameSourceMeta: JSON.stringify({ mode: 'manual', sourcePanelId: 'manual-first-panel' }),
      })
      .mockResolvedValueOnce({ id: 'last-panel' })
      .mockResolvedValueOnce({ id: 'manual-first-panel' })

    const response = await POST(request({
      firstLastFrame: {
        flModel: 'comfyui::wf-video',
        lastFrameStoryboardId: 'storyboard-2',
        lastFramePanelIndex: 0,
        firstFrameSourcePanelId: 'forged-client-first',
      },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    expect(panelFindFirstMock).toHaveBeenLastCalledWith(expect.objectContaining({
      where: {
        id: 'manual-first-panel',
        storyboard: { episode: { novelPromotionProject: {
          projectId: 'project-1', project: { userId: 'user-1' },
        } } },
      },
    }))
    expect(submitTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        firstLastFrame: {
          flModel: 'comfyui::wf-video',
          firstFrameSourcePanelId: 'manual-first-panel',
          sourcePanelId: 'last-panel',
        },
      }),
    }))
  })

  it('rejects a last frame outside the authorized project before billing or submission', async () => {
    panelFindFirstMock
      .mockResolvedValueOnce({
        id: 'panel-1', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
        hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
        includeDialogueInVideoPrompt: true, videoPrompt: 'normal prompt', firstLastFramePrompt: 'first-last prompt',
        estimatedDuration: 5, durationOverride: null, duration: 5,
      })
      .mockResolvedValueOnce(null)

    const response = await POST(request({
      firstLastFrame: {
        flModel: 'comfyui::wf-video',
        lastFrameStoryboardId: 'foreign-storyboard',
        lastFramePanelIndex: 0,
      },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(400)
    expect(panelFindFirstMock).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        storyboardId: 'foreign-storyboard',
        storyboard: { episode: { novelPromotionProject: {
          projectId: 'project-1', project: { userId: 'user-1' },
        } } },
      }),
    }))
    expect(buildBillingInfoMock).not.toHaveBeenCalled()
    expect(submitTaskMock).not.toHaveBeenCalled()
  })

  it('uses firstLastFramePrompt for first-last-frame tasks and videoPrompt for normal tasks', async () => {
    const panel = {
      id: 'panel-1', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
      hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
      includeDialogueInVideoPrompt: true, videoPrompt: 'NORMAL VISUAL PROMPT', firstLastFramePrompt: 'FIRST LAST VISUAL PROMPT',
      estimatedDuration: 5, durationOverride: null, duration: 5,
    }
    panelFindFirstMock
      .mockResolvedValueOnce(panel)
      .mockResolvedValueOnce({ id: 'last-panel-1' })
      .mockResolvedValueOnce(panel)

    const firstLastResponse = await POST(request({
      firstLastFrame: {
        flModel: 'comfyui::wf-video',
        lastFrameStoryboardId: 'storyboard-1',
        lastFramePanelIndex: 1,
      },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })
    const normalResponse = await POST(request({ useProjectRouting: true }), {
      params: Promise.resolve({ projectId: 'project-1' }),
    })

    expect(firstLastResponse.status).toBe(200)
    expect(normalResponse.status).toBe(200)
    expect(submitTaskMock.mock.calls.map(([input]) => input.payload.videoPrompt)).toEqual([
      'FIRST LAST VISUAL PROMPT',
      'NORMAL VISUAL PROMPT',
    ])
  })

  it('continues rejecting unsupported cloud first-last-frame models', async () => {
    const response = await POST(request({
      videoModel: 'cloud::normal',
      firstLastFrame: { flModel: 'cloud::unsupported' },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })
    expect(response.status).toBe(400)
    expect(submitTaskMock).not.toHaveBeenCalled()
  })

  it('does not let malformed comfy-like keys bypass strict parsing', async () => {
    const response = await POST(request({
      videoModel: 'cloud::normal',
      firstLastFrame: { flModel: 'comfyui:wf-video' },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })
    expect(response.status).toBe(400)
    expect(capabilityMock).not.toHaveBeenCalledWith('video', 'comfyui:wf-video')
  })

  it('ignores forged client prompt and effective duration and snapshots server resolution', async () => {
    capabilityMock.mockReturnValue({ video: { durationOptions: [5, 10] } })
    panelFindFirstMock.mockResolvedValue({
      id: 'panel-1', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
      hasDialogue: true, dialogueSpeaker: '阿青', dialogueText: '跟我走。', dialogueEmotion: '急切',
      includeDialogueInVideoPrompt: true, videoPrompt: '人物推开门',
      estimatedDuration: 7.2, durationOverride: null, duration: 7.2,
    })
    getProjectModelConfigMock.mockResolvedValue({
      videoModel: 'cloud::normal', dialogueVideoModel: 'cloud::dialogue', comfyVideoWorkflowVersionId: null,
    })

    const response = await POST(request({
      submittedPrompt: 'FORGED', effectiveDuration: 1, requestedDuration: 1,
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    expect(submitTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        videoModel: 'cloud::dialogue',
        videoPrompt: expect.stringContaining('跟我走。'),
        requestedDuration: 7.2,
        effectiveDuration: 10,
        videoModelReason: 'dialogue_project_model',
      }),
    }))
  })

  it('removes forged root and first-last-frame prompts from the submitted task payload', async () => {
    const response = await POST(request({
      customPrompt: 'FORGED ROOT PROMPT',
      firstLastFrame: {
        flModel: 'comfyui::wf-video',
        customPrompt: 'FORGED FIRST LAST PROMPT',
      },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    const submitted = submitTaskMock.mock.calls[0]?.[0] as { payload: Record<string, unknown> }
    expect(submitted.payload.videoPrompt).toBe('server visual prompt')
    expect(submitted.payload).not.toHaveProperty('customPrompt')
    expect(submitted.payload.firstLastFrame).toEqual({
      flModel: 'comfyui::wf-video', firstFrameSourcePanelId: 'panel-1',
    })
  })

  it('routes each batch panel through dialogue-aware project models', async () => {
    panelFindManyMock.mockResolvedValue([
      {
        id: 'panel-dialogue', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
        hasDialogue: true, dialogueSpeaker: '阿青', dialogueText: '跟我走。', dialogueEmotion: '急切',
        includeDialogueInVideoPrompt: true, videoPrompt: '人物推开门', firstLastFramePrompt: null,
        estimatedDuration: 5, durationOverride: null, duration: 5,
      },
      {
        id: 'panel-normal', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
        hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
        includeDialogueInVideoPrompt: true, videoPrompt: '空镜扫过街道', firstLastFramePrompt: null,
        estimatedDuration: 5, durationOverride: null, duration: 5,
      },
    ])
    getProjectModelConfigMock.mockResolvedValue({
      videoModel: 'cloud::normal', dialogueVideoModel: 'cloud::dialogue', comfyVideoWorkflowVersionId: null,
    })

    const response = await POST(request({
      all: true,
      episodeId: 'episode-1',
      videoModel: 'cloud::normal',
      useProjectRouting: true,
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    expect(submitTaskMock.mock.calls.map(([input]) => ({
      targetId: input.targetId,
      videoModel: input.payload.videoModel,
      reason: input.payload.videoModelReason,
    }))).toEqual([
      { targetId: 'panel-dialogue', videoModel: 'cloud::dialogue', reason: 'dialogue_project_model' },
      { targetId: 'panel-normal', videoModel: 'cloud::normal', reason: 'normal_project_model' },
    ])
  })

  it('ignores an injected explicitVideoModel for batch project routing', async () => {
    panelFindManyMock.mockResolvedValue([
      {
        id: 'panel-dialogue', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
        hasDialogue: true, dialogueSpeaker: '阿青', dialogueText: '走。', dialogueEmotion: '急切',
        includeDialogueInVideoPrompt: true, videoPrompt: '人物转身', firstLastFramePrompt: '不应使用',
        estimatedDuration: 5, durationOverride: null, duration: 5,
      },
    ])
    getProjectModelConfigMock.mockResolvedValue({
      videoModel: 'cloud::normal', dialogueVideoModel: 'cloud::dialogue', comfyVideoWorkflowVersionId: null,
    })

    const response = await POST(request({
      all: true, episodeId: 'episode-1', useProjectRouting: true,
      videoModel: 'cloud::normal', explicitVideoModel: 'cloud::unsupported',
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    const payload = submitTaskMock.mock.calls[0]?.[0].payload
    expect(payload).toMatchObject({ videoModel: 'cloud::dialogue', videoModelReason: 'dialogue_project_model' })
    expect(payload).not.toHaveProperty('explicitVideoModel')
  })

  it('ignores an injected firstLastFrame model for batch project routing', async () => {
    panelFindManyMock.mockResolvedValue([
      {
        id: 'panel-normal', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
        hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
        includeDialogueInVideoPrompt: true, videoPrompt: '空镜', firstLastFramePrompt: '不应使用',
        estimatedDuration: 5, durationOverride: null, duration: 5,
      },
    ])
    getProjectModelConfigMock.mockResolvedValue({
      videoModel: 'cloud::normal', dialogueVideoModel: 'cloud::dialogue', comfyVideoWorkflowVersionId: null,
    })

    const response = await POST(request({
      all: true, episodeId: 'episode-1', useProjectRouting: true, videoModel: 'cloud::normal',
      firstLastFrame: { flModel: 'comfyui::wf-video', sourcePanelId: 'foreign-client-id' },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    const payload = submitTaskMock.mock.calls[0]?.[0].payload
    expect(payload).toMatchObject({ videoModel: 'cloud::normal', videoModelReason: 'normal_project_model' })
    expect(payload).not.toHaveProperty('firstLastFrame')
  })

  it('rejects stale duration override before submission and never mutates the estimate', async () => {
    panelUpdateManyMock.mockResolvedValue({ count: 0 })
    const response = await POST(request({
      durationOverride: 8,
      expectedPanelUpdatedAt: '2026-07-13T01:02:03.000Z',
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(409)
    expect(panelUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: { durationOverride: 8 },
    }))
    expect((panelUpdateManyMock.mock.calls[0]?.[0] as { data: object }).data).not.toHaveProperty('estimatedDuration')
    expect(submitTaskMock).not.toHaveBeenCalled()
  })

  it('clears an override with null while preserving estimated duration', async () => {
    const response = await POST(request({
      durationOverride: null,
      expectedPanelUpdatedAt: '2026-07-13T01:02:03.000Z',
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    expect(panelUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: { durationOverride: null },
    }))
    expect((panelUpdateManyMock.mock.calls[0]?.[0] as { data: object }).data).not.toHaveProperty('estimatedDuration')
  })

  it('does not let forged Comfy generationOptions define the duration contract', async () => {
    panelFindFirstMock.mockResolvedValue({
      id: 'panel-1', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
      hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
      includeDialogueInVideoPrompt: true, videoPrompt: 'server prompt',
      estimatedDuration: 7.2, durationOverride: null, duration: 7.2,
    })
    const response = await POST(request({
      videoModel: 'comfyui::wf-video',
      generationOptions: { duration: 999 },
      effectiveDuration: 999,
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    expect(submitTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        requestedDuration: 7.2,
        effectiveDuration: 10,
        generationOptions: expect.objectContaining({ duration: 10 }),
        comfyWorkflowVersionId: 'video-version-1',
      }),
    }))
  })

  it('blocks an unavailable configured dialogue model before billing submission', async () => {
    panelFindFirstMock.mockResolvedValue({
      id: 'panel-1', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
      hasDialogue: true, dialogueSpeaker: '阿青', dialogueText: '走。', dialogueEmotion: '急切',
      includeDialogueInVideoPrompt: true, videoPrompt: '人物转身',
      estimatedDuration: 5, durationOverride: null, duration: 5,
    })
    getProjectModelConfigMock.mockResolvedValue({
      videoModel: 'cloud::normal', dialogueVideoModel: 'cloud::forbidden', comfyVideoWorkflowVersionId: null,
    })

    const response = await POST(request({ useProjectRouting: true, videoModel: 'cloud::normal' }), {
      params: Promise.resolve({ projectId: 'project-1' }),
    })

    expect(response.status).toBe(400)
    expect(submitTaskMock).not.toHaveBeenCalled()
  })
})
