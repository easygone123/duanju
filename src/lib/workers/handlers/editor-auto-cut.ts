import type { Job } from 'bullmq'
import { prisma } from '@/lib/prisma'
import { executeAiTextStep } from '@/lib/ai-runtime'
import { withInternalLLMStreamCallbacks } from '@/lib/llm-observe/internal-stream-context'
import { safeParseJsonObject } from '@/lib/json-repair'
import { buildPrompt, PROMPT_IDS } from '@/lib/prompt-i18n'
import type { TaskJobData } from '@/lib/task/types'
import { reportTaskProgress } from '@/lib/workers/shared'
import { assertTaskActive } from '@/lib/workers/utils'
import {
  normalizeEditorAutoCutPlan,
  normalizeEditorAutoCutSourceClips,
} from '@/lib/novel-promotion/editor-auto-cut'
import { createWorkerLLMStreamCallbacks, createWorkerLLMStreamContext } from './llm-stream'
import { resolveAnalysisModel } from './resolve-analysis-model'

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export async function handleEditorAutoCutTask(job: Job<TaskJobData>) {
  const payload = (job.data.payload || {}) as Record<string, unknown>
  const episodeId = readText(payload.episodeId || job.data.episodeId)
  const clips = normalizeEditorAutoCutSourceClips(payload.clips)
  const instruction = readText(payload.instruction).slice(0, 4000)

  if (!episodeId) throw new Error('episodeId is required')
  if (clips.length === 0) throw new Error('EDITOR_AUTO_CUT_NO_CLIPS')

  const episode = await prisma.novelPromotionEpisode.findFirst({
    where: {
      id: episodeId,
      novelPromotionProject: { projectId: job.data.projectId },
    },
    select: {
      id: true,
      name: true,
      novelText: true,
      novelPromotionProject: {
        select: { analysisModel: true },
      },
    },
  })
  if (!episode) throw new Error('Episode not found')

  const analysisModel = await resolveAnalysisModel({
    userId: job.data.userId,
    inputModel: payload.analysisModel || payload.model,
    projectAnalysisModel: episode.novelPromotionProject.analysisModel,
  })

  const prompt = buildPrompt({
    promptId: PROMPT_IDS.NP_EDITOR_AUTO_CUT,
    locale: job.data.locale,
    variables: {
      story: readText(episode.novelText).slice(0, 30_000) || episode.name || '未提供完整剧情，请严格依据分镜素材编排。',
      instruction: instruction || '保持剧情连贯，保留全部对白，节奏自然，场景切换使用克制的转场。',
      clips_json: JSON.stringify(clips, null, 2),
    },
  })

  await reportTaskProgress(job, 20, {
    stage: 'editor_auto_cut_prepare',
    stageLabel: '正在分析全部分镜与台词',
    displayMode: 'loading',
  })
  await assertTaskActive(job, 'editor_auto_cut_prepare')

  const streamContext = createWorkerLLMStreamContext(job, 'editor_auto_cut')
  const streamCallbacks = createWorkerLLMStreamCallbacks(job, streamContext)
  let responseText = ''
  try {
    const completion = await withInternalLLMStreamCallbacks(
      streamCallbacks,
      async () => await executeAiTextStep({
        userId: job.data.userId,
        model: analysisModel,
        messages: [{ role: 'user', content: prompt }],
        reasoning: true,
        temperature: 0.2,
        projectId: job.data.projectId,
        action: 'editor_auto_cut',
        meta: {
          stepId: 'editor_auto_cut',
          stepTitle: 'ChatCut 自动剪辑',
          stepIndex: 1,
          stepTotal: 1,
        },
      }),
    )
    responseText = completion.text
  } finally {
    await streamCallbacks.flush()
  }

  if (!responseText.trim()) throw new Error('EDITOR_AUTO_CUT_EMPTY_RESPONSE')
  await assertTaskActive(job, 'editor_auto_cut_parse')

  const plan = normalizeEditorAutoCutPlan(safeParseJsonObject(responseText), clips)
  await reportTaskProgress(job, 96, {
    stage: 'editor_auto_cut_done',
    stageLabel: '自动剪辑方案已生成',
    displayMode: 'loading',
  })

  return { plan }
}
