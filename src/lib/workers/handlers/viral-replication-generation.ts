import type { Job } from 'bullmq'

import { safeParseJson } from '@/lib/json-repair'
import { getCompletionContent } from '@/lib/llm/completion-parts'
import { runModelGatewayTextCompletion } from '@/lib/model-gateway/llm'
import { prisma } from '@/lib/prisma'
import type { TaskJobData } from '@/lib/task/types'
import {
  VIRAL_REPLICATION_STATUS,
  VIRAL_STORYBOARD_GENERATION_FAILED,
} from '@/lib/viral-replication/constants'
import {
  parseViralAnalysisReport,
  parseViralStoryboardGeneration,
  type ViralStoryboardGenerationV1,
} from '@/lib/viral-replication/contracts'
import { persistViralStoryboardGeneration } from '@/lib/viral-replication/persistence'
import { buildViralStoryboardGenerationPrompt } from '@/lib/viral-replication/prompts'
import { reportTaskProgress } from '@/lib/workers/shared'

type GenerationRecord = {
  id: string
  userId: string
  projectId: string | null
  episodeId: string | null
  sourceVideoMediaId: string | null
  status: string
  brief: string
  videoRatio: string
  artStyle: string
  analysisModelSnapshot: string | null
  durationMs: number | null
  transcriptText: string | null
  reportJson: unknown
}

type GenerationPrisma = {
  viralReplication: {
    findFirst(args: Record<string, unknown>): Promise<GenerationRecord | null>
    updateMany(args: Record<string, unknown>): Promise<{ count: number }>
  }
}

type TextCompletion = Awaited<ReturnType<typeof runModelGatewayTextCompletion>>

export type ViralReplicationGenerationDependencies = {
  prisma: GenerationPrisma
  runText(input: Parameters<typeof runModelGatewayTextCompletion>[0]): Promise<TextCompletion>
  persist(input: {
    replicationId: string
    userId: string
    projectId: string
    episodeId: string
    generation: ViralStoryboardGenerationV1
    transcriptText: string | null
    sourceAudioMediaId: string | null
  }): Promise<void>
  reportProgress(
    job: Job<TaskJobData>,
    progress: number,
    payload?: Record<string, unknown>,
  ): Promise<unknown>
}

const defaultDependencies: ViralReplicationGenerationDependencies = {
  prisma: prisma as unknown as GenerationPrisma,
  runText: runModelGatewayTextCompletion,
  persist: persistViralStoryboardGeneration,
  reportProgress: reportTaskProgress,
}

function requirePinnedModel(job: Job<TaskJobData>, record: GenerationRecord): string {
  const payloadModel = job.data.payload?.analysisModelSnapshot
  if (typeof payloadModel !== 'string' || !payloadModel.trim()) {
    throw new Error('VIRAL_GENERATION_MODEL_MISSING')
  }
  if (!record.analysisModelSnapshot || payloadModel !== record.analysisModelSnapshot) {
    throw new Error('VIRAL_GENERATION_MODEL_SUPERSEDED')
  }
  return payloadModel
}

export function createViralReplicationGenerationHandler(
  dependencies: ViralReplicationGenerationDependencies,
) {
  return async function handle(job: Job<TaskJobData>): Promise<{ replicationId: string }> {
    let replication: GenerationRecord | null = null
    try {
      replication = await dependencies.prisma.viralReplication.findFirst({
        where: {
          id: job.data.targetId,
          userId: job.data.userId,
          status: VIRAL_REPLICATION_STATUS.GENERATING,
        },
        select: {
          id: true,
          userId: true,
          projectId: true,
          episodeId: true,
          sourceVideoMediaId: true,
          status: true,
          brief: true,
          videoRatio: true,
          artStyle: true,
          analysisModelSnapshot: true,
          durationMs: true,
          transcriptText: true,
          reportJson: true,
        },
      })
      if (!replication) throw new Error('VIRAL_GENERATION_NOT_ACTIVE')
      if (!replication.projectId || !replication.episodeId) {
        throw new Error('VIRAL_GENERATION_TARGET_MISSING')
      }
      if (!replication.durationMs || !replication.reportJson) {
        throw new Error('VIRAL_GENERATION_REPORT_MISSING')
      }
      const model = requirePinnedModel(job, replication)
      const report = parseViralAnalysisReport(replication.reportJson, replication.durationMs)

      await dependencies.reportProgress(job, 10, {
        stage: 'viral_storyboard_generation',
        stageLabel: '按原声字幕生成重绘分镜',
        displayMode: 'detail',
      })
      const completion = await dependencies.runText({
        userId: replication.userId,
        model,
        messages: [{
          role: 'user',
          content: buildViralStoryboardGenerationPrompt({
            locale: job.data.locale,
            brief: replication.brief,
            videoRatio: replication.videoRatio,
            artStyle: replication.artStyle,
            report,
            transcriptText: replication.transcriptText,
          }),
        }],
        options: {
          temperature: 0.2,
          projectId: replication.projectId,
          action: 'viral_storyboard_generation',
        },
      })
      const generation = parseViralStoryboardGeneration(
        safeParseJson(getCompletionContent(completion)),
        {
          report,
          transcriptText: replication.transcriptText,
          artStyle: replication.artStyle,
        },
      )
      await dependencies.reportProgress(job, 90, {
        stage: 'viral_storyboard_persistence',
        stageLabel: '保存原声剧情分镜',
        displayMode: 'detail',
      })
      await dependencies.persist({
        replicationId: replication.id,
        userId: replication.userId,
        projectId: replication.projectId,
        episodeId: replication.episodeId,
        generation,
        transcriptText: replication.transcriptText,
        sourceAudioMediaId: replication.sourceVideoMediaId,
      })
      return { replicationId: replication.id }
    } catch (error: unknown) {
      if (replication) {
        await dependencies.prisma.viralReplication.updateMany({
          where: {
            id: replication.id,
            userId: replication.userId,
            status: VIRAL_REPLICATION_STATUS.GENERATING,
          },
          data: {
            status: VIRAL_REPLICATION_STATUS.FAILED,
            errorMessage: VIRAL_STORYBOARD_GENERATION_FAILED,
          },
        })
      }
      throw error
    }
  }
}

const defaultHandler = createViralReplicationGenerationHandler(defaultDependencies)

export async function handleViralReplicationGenerationTask(job: Job<TaskJobData>) {
  return await defaultHandler(job)
}
