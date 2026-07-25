import { prisma } from '@/lib/prisma'
import { encodeImageUrls } from '@/lib/contracts/image-urls-contract'
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
  novelPromotionCharacter: {
    create(args: Record<string, unknown>): Promise<{ id: string }>
  }
  characterAppearance: {
    create(args: Record<string, unknown>): Promise<unknown>
  }
  novelPromotionLocation: {
    create(args: Record<string, unknown>): Promise<{ id: string }>
  }
  locationImage: {
    create(args: Record<string, unknown>): Promise<unknown>
  }
  novelPromotionClip: {
    create(args: Record<string, unknown>): Promise<{ id: string }>
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

function uniqueNonEmpty(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

function buildViralClipContent(
  storyboard: ViralStoryboardGenerationV1['storyboards'][number],
) {
  return storyboard.panels.map((panel) => {
    const startSeconds = (panel.startMs / 1_000).toFixed(1)
    const endSeconds = (panel.endMs / 1_000).toFixed(1)
    return [
      `【${startSeconds}-${endSeconds}秒】${panel.description}`,
      `景别：${panel.shotType}`,
      `运镜：${panel.cameraMove}`,
      `场景：${panel.location}`,
      panel.characters.length > 0 ? `角色：${panel.characters.join('、')}` : null,
      panel.audioText ? `原声音频：${panel.audioText}` : null,
      `画面要求：${panel.imagePrompt}`,
      `动作要求：${panel.videoPrompt}`,
    ].filter(Boolean).join('\n')
  }).join('\n\n')
}

export async function persistViralStoryboardGeneration(
  input: {
    replicationId: string
    userId: string
    projectId: string
    episodeId: string
    generation: ViralStoryboardGenerationV1
    transcriptText?: string | null
    sourceAudioMediaId?: string | null
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
        srtContent: input.transcriptText || null,
        audioMediaId: input.sourceAudioMediaId || null,
      },
    })

    for (const character of input.generation.characters) {
      const created = await tx.novelPromotionCharacter.create({
        data: {
          novelPromotionProjectId: episode.novelPromotionProjectId,
          name: character.name,
          introduction: character.description,
          profileData: JSON.stringify({
            visual_keywords: [character.description],
            expected_appearances: [{
              appearanceIndex: 0,
              description: character.description,
            }],
          }),
          profileConfirmed: false,
        },
        select: { id: true },
      })
      await tx.characterAppearance.create({
        data: {
          characterId: created.id,
          appearanceIndex: 0,
          changeReason: '爆款原声重绘初始形象',
          description: character.description,
          descriptions: JSON.stringify([character.description]),
          imageUrls: encodeImageUrls([]),
          previousImageUrls: encodeImageUrls([]),
        },
      })
    }

    for (const location of input.generation.locations) {
      const created = await tx.novelPromotionLocation.create({
        data: {
          novelPromotionProjectId: episode.novelPromotionProjectId,
          name: location.name,
          summary: location.description,
        },
        select: { id: true },
      })
      await tx.locationImage.create({
        data: {
          locationId: created.id,
          imageIndex: 0,
          description: location.description,
          isSelected: false,
        },
      })
    }

    for (const generatedStoryboard of input.generation.storyboards) {
      const firstPanel = generatedStoryboard.panels[0]
      const lastPanel = generatedStoryboard.panels[generatedStoryboard.panels.length - 1]
      const duration = Math.ceil(generatedStoryboard.panels.reduce(
        (total, panel) => total + panel.durationSeconds,
        0,
      ))
      const characters = uniqueNonEmpty(
        generatedStoryboard.panels.flatMap((panel) => panel.characters),
      )
      const locations = uniqueNonEmpty(
        generatedStoryboard.panels.map((panel) => panel.location),
      )
      await tx.novelPromotionClip.create({
        data: {
          episodeId: input.episodeId,
          start: Math.floor(firstPanel.startMs / 1_000),
          end: Math.ceil(lastPanel.endMs / 1_000),
          summary: generatedStoryboard.summary,
          content: buildViralClipContent(generatedStoryboard),
          duration,
          shotCount: generatedStoryboard.panels.length,
          characters: characters.length > 0 ? JSON.stringify(characters) : null,
          location: locations[0] || null,
        },
      })
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
