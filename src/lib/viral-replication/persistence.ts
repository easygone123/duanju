import { prisma } from '@/lib/prisma'
import { VIRAL_REPLICATION_STATUS } from './constants'
import type { ViralStoryboardGenerationV1 } from './contracts'

type PersistenceTransaction = {
  novelPromotionEpisode: {
    findFirst(args: Record<string, unknown>): Promise<{
      id: string
      novelPromotionProjectId: string
      _count: { clips: number; storyboards: number }
    } | null>
    update(args: Record<string, unknown>): Promise<unknown>
  }
  novelPromotionClip: {
    create(args: Record<string, unknown>): Promise<{ id: string }>
  }
  novelPromotionStoryboard: {
    create(args: Record<string, unknown>): Promise<{ id: string }>
  }
  novelPromotionPanel: {
    create(args: Record<string, unknown>): Promise<unknown>
  }
  novelPromotionProject: {
    update(args: Record<string, unknown>): Promise<unknown>
  }
  viralReplication: {
    updateMany(args: Record<string, unknown>): Promise<{ count: number }>
  }
}

type PersistencePrisma = {
  $transaction<T>(callback: (tx: PersistenceTransaction) => Promise<T>): Promise<T>
}

export async function persistViralStoryboardGeneration(
  input: {
    replicationId: string
    userId: string
    projectId: string
    episodeId: string
    generation: ViralStoryboardGenerationV1
  },
  database: PersistencePrisma = prisma as unknown as PersistencePrisma,
): Promise<void> {
  await database.$transaction(async (tx) => {
    const episode = await tx.novelPromotionEpisode.findFirst({
      where: {
        id: input.episodeId,
        novelPromotionProject: { projectId: input.projectId },
      },
      select: {
        id: true,
        novelPromotionProjectId: true,
        _count: { select: { clips: true, storyboards: true } },
      },
    })
    if (!episode) throw new Error('VIRAL_EPISODE_NOT_FOUND')
    if (episode._count.clips > 0 || episode._count.storyboards > 0) {
      throw new Error('VIRAL_EPISODE_NOT_EMPTY')
    }

    await tx.novelPromotionEpisode.update({
      where: { id: input.episodeId },
      data: {
        name: input.generation.title,
        description: input.generation.synopsis,
        novelText: input.generation.novelText,
      },
    })

    for (const generatedStoryboard of input.generation.storyboards) {
      const duration = Math.ceil(generatedStoryboard.panels.reduce(
        (total, panel) => total + panel.durationSeconds,
        0,
      ))
      const clip = await tx.novelPromotionClip.create({
        data: {
          episodeId: input.episodeId,
          summary: generatedStoryboard.summary,
          content: generatedStoryboard.summary,
          duration,
          shotCount: generatedStoryboard.panels.length,
        },
      })
      const storyboard = await tx.novelPromotionStoryboard.create({
        data: {
          episodeId: input.episodeId,
          clipId: clip.id,
          panelCount: generatedStoryboard.panels.length,
          storyboardTextJson: JSON.stringify({
            schemaVersion: 1,
            sequence: generatedStoryboard.sequence,
            summary: generatedStoryboard.summary,
            panels: generatedStoryboard.panels,
          }),
          layoutMode: 'individual',
          groupSequence: generatedStoryboard.sequence,
        },
      })

      for (const panel of generatedStoryboard.panels) {
        await tx.novelPromotionPanel.create({
          data: {
            storyboardId: storyboard.id,
            panelIndex: panel.panelIndex,
            panelNumber: panel.panelIndex + 1,
            duration: panel.durationSeconds,
            shotType: panel.shotType,
            cameraMove: panel.cameraMove,
            description: panel.description,
            imagePrompt: panel.imagePrompt,
            videoPrompt: panel.videoPrompt,
          },
        })
      }
    }

    await tx.novelPromotionProject.update({
      where: { id: episode.novelPromotionProjectId },
      data: { lastEpisodeId: input.episodeId },
    })
    const completed = await tx.viralReplication.updateMany({
      where: {
        id: input.replicationId,
        userId: input.userId,
        status: VIRAL_REPLICATION_STATUS.GENERATING,
      },
      data: {
        status: VIRAL_REPLICATION_STATUS.COMPLETED,
        errorMessage: null,
      },
    })
    if (completed.count !== 1) throw new Error('VIRAL_GENERATION_SUPERSEDED')
  })
}
