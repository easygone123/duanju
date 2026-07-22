import type { Job } from 'bullmq'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyEditorAutoCutPlan,
  normalizeEditorAutoCutPlan,
  normalizeEditorAutoCutSourceClips,
} from '@/lib/novel-promotion/editor-auto-cut'
import type { VideoEditorProject } from '@/features/video-editor/types/editor.types'
import { TASK_TYPE, type TaskJobData } from '@/lib/task/types'

const prismaMock = vi.hoisted(() => ({
  novelPromotionEpisode: { findFirst: vi.fn() },
}))

const aiRuntimeMock = vi.hoisted(() => ({
  executeAiTextStep: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/ai-runtime', () => aiRuntimeMock)
vi.mock('@/lib/llm-observe/internal-stream-context', () => ({
  withInternalLLMStreamCallbacks: vi.fn(async (_callbacks: unknown, run: () => Promise<unknown>) => await run()),
}))
vi.mock('@/lib/prompt-i18n', () => ({
  PROMPT_IDS: { NP_EDITOR_AUTO_CUT: 'np_editor_auto_cut' },
  buildPrompt: vi.fn(() => 'editor-auto-cut-prompt'),
}))
vi.mock('@/lib/workers/shared', () => ({ reportTaskProgress: vi.fn(async () => undefined) }))
vi.mock('@/lib/workers/utils', () => ({ assertTaskActive: vi.fn(async () => undefined) }))
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
vi.mock('@/lib/workers/handlers/resolve-analysis-model', () => ({
  resolveAnalysisModel: vi.fn(async () => 'provider::analysis-model'),
}))

import { handleEditorAutoCutTask } from '@/lib/workers/handlers/editor-auto-cut'

const sourceClips = normalizeEditorAutoCutSourceClips([
  {
    clipId: 'clip-1',
    panelId: 'panel-1',
    storyboardId: 'storyboard-1',
    sourceOrder: 0,
    durationSeconds: 4,
    description: '开场对白',
    subtitleText: '你终于来了',
    hasVoiceAudio: true,
  },
  {
    clipId: 'clip-2',
    panelId: 'panel-2',
    storyboardId: 'storyboard-1',
    sourceOrder: 1,
    durationSeconds: 3,
    description: '无对白反应镜头',
    subtitleText: '',
    hasVoiceAudio: false,
  },
])

describe('editor auto cut', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.novelPromotionEpisode.findFirst.mockResolvedValue({
      id: 'episode-1',
      name: '第一集',
      novelText: '完整剧情',
      novelPromotionProject: { analysisModel: 'provider::analysis-model' },
    })
    aiRuntimeMock.executeAiTextStep.mockResolvedValue({
      text: JSON.stringify({
        summary: '保留对白并加快反应镜头',
        rhythm: '自然紧凑',
        decisions: sourceClips.map((clip) => ({
          panelId: clip.panelId,
          include: true,
          order: clip.sourceOrder,
          trimStartSeconds: 0,
          trimEndSeconds: clip.durationSeconds,
          transition: 'dissolve',
          transitionDurationSeconds: 0.3,
          subtitleStyle: 'default',
          reason: '保持剧情连续',
        })),
      }),
      reasoning: '',
    })
  })

  it('normalizes AI decisions and never trims clips with timed speech', () => {
    const plan = normalizeEditorAutoCutPlan({
      summary: '紧凑剪辑',
      rhythm: '先稳后快',
      decisions: [
        {
          panelId: 'panel-1',
          include: true,
          order: 1,
          trimStartSeconds: 1,
          trimEndSeconds: 2,
          transition: 'dissolve',
          transitionDurationSeconds: 0.4,
          subtitleStyle: 'cinematic',
          reason: '保留对白',
        },
        {
          panelId: 'panel-2',
          include: true,
          order: 0,
          trimStartSeconds: 0.5,
          trimEndSeconds: 2.5,
          transition: 'invalid',
          transitionDurationSeconds: 99,
        },
      ],
    }, sourceClips)

    expect(plan.decisions[0]).toMatchObject({
      panelId: 'panel-1',
      trimStartSeconds: 0,
      trimEndSeconds: 4,
      transition: 'dissolve',
    })
    expect(plan.decisions[1]).toMatchObject({
      panelId: 'panel-2',
      trimStartSeconds: 0.5,
      trimEndSeconds: 2.5,
      transition: 'none',
      transitionDurationSeconds: 1.2,
    })
  })

  it('applies only decisions to trusted source clips and preserves media attachments', () => {
    const project: VideoEditorProject = {
      id: 'source-project',
      episodeId: 'episode-1',
      schemaVersion: '1.0',
      config: { fps: 30, width: 1920, height: 1080 },
      bgmTrack: [],
      timeline: sourceClips.map((clip) => ({
        id: clip.clipId,
        src: `/trusted/${clip.clipId}.mp4`,
        durationInFrames: clip.durationSeconds * 30,
        attachment: clip.panelId === 'panel-1' ? {
          audio: { src: '/trusted/voice.mp3', volume: 1 },
          subtitle: { text: clip.subtitleText, style: 'default' },
        } : undefined,
        metadata: {
          panelId: clip.panelId,
          storyboardId: clip.storyboardId,
          description: clip.description,
        },
      })),
    }
    const plan = normalizeEditorAutoCutPlan({
      decisions: [
        {
          panelId: 'panel-1',
          order: 1,
          trimStartSeconds: 0,
          trimEndSeconds: 4,
          transition: 'fade',
          transitionDurationSeconds: 0.3,
          subtitleStyle: 'cinematic',
          reason: '对白落点',
        },
        {
          panelId: 'panel-2',
          order: 0,
          trimStartSeconds: 0.5,
          trimEndSeconds: 2.5,
          transition: 'dissolve',
          transitionDurationSeconds: 0.4,
        },
      ],
    }, sourceClips)

    const edited = applyEditorAutoCutPlan(project, plan, 'saved-project')
    expect(edited.id).toBe('saved-project')
    expect(edited.timeline.map((clip) => clip.metadata.panelId)).toEqual(['panel-2', 'panel-1'])
    expect(edited.timeline[0]).toMatchObject({
      src: '/trusted/clip-2.mp4',
      durationInFrames: 60,
      trim: { from: 15, to: 75 },
      transition: { type: 'dissolve', durationInFrames: 12 },
    })
    expect(edited.timeline[1]).toMatchObject({
      src: '/trusted/clip-1.mp4',
      attachment: {
        audio: { src: '/trusted/voice.mp3' },
        subtitle: { text: '你终于来了', style: 'cinematic' },
      },
      metadata: { autoCutReason: '对白落点' },
    })
    expect(edited.timeline[1].transition).toBeUndefined()
  })

  it('fills missing decisions so an incomplete model response cannot drop source shots', () => {
    const plan = normalizeEditorAutoCutPlan({
      decisions: [{ panelId: 'panel-1', include: false }],
    }, sourceClips)

    expect(plan.decisions).toHaveLength(2)
    expect(plan.decisions.find((decision) => decision.panelId === 'panel-2')?.include).toBe(true)
  })

  it('runs the configured analysis model and returns a normalized worker plan', async () => {
    const job = {
      data: {
        taskId: 'task-editor-auto-cut-1',
        type: TASK_TYPE.EDITOR_AUTO_CUT,
        locale: 'zh',
        projectId: 'project-1',
        episodeId: 'episode-1',
        targetType: 'NovelPromotionEpisode',
        targetId: 'episode-1',
        payload: {
          episodeId: 'episode-1',
          clips: sourceClips,
          instruction: '节奏紧凑，保留全部对白',
          analysisModel: 'provider::analysis-model',
        },
        userId: 'user-1',
      },
    } as unknown as Job<TaskJobData>

    const result = await handleEditorAutoCutTask(job)

    expect(result.plan.summary).toBe('保留对白并加快反应镜头')
    expect(result.plan.decisions).toHaveLength(2)
    expect(aiRuntimeMock.executeAiTextStep).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      model: 'provider::analysis-model',
      projectId: 'project-1',
      action: 'editor_auto_cut',
    }))
  })
})
