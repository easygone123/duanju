import { ApiError } from '@/lib/api-errors'
import { isArtStyleValue } from '@/lib/constants'
import {
  importExternalGridStoryboards,
  type ExternalStoryboardImportInput,
} from '@/lib/novel-promotion/external-storyboard-import'
import { normalizeProjectDraft, validateProjectDraft } from '@/lib/projects/validation'
import { prisma } from '@/lib/prisma'

function parseJsonField(value: string | null): unknown {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

async function requireOwnedNovelProject(userId: string, projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId },
    include: { novelPromotionData: true },
  })
  if (!project?.novelPromotionData) throw new ApiError('NOT_FOUND')
  return project
}

async function requireOwnedEpisode(userId: string, projectId: string, episodeId: string) {
  const episode = await prisma.novelPromotionEpisode.findFirst({
    where: {
      id: episodeId,
      novelPromotionProject: {
        projectId,
        project: { userId },
      },
    },
  })
  if (!episode) throw new ApiError('NOT_FOUND')
  return episode
}

export async function listDuanjuProjects(input: {
  userId: string
  query?: string
  limit: number
}) {
  const where = {
    userId: input.userId,
    ...(input.query
      ? {
          OR: [
            { name: { contains: input.query } },
            { description: { contains: input.query } },
          ],
        }
      : {}),
  }
  return prisma.project.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: input.limit,
    select: {
      id: true,
      name: true,
      description: true,
      createdAt: true,
      updatedAt: true,
      lastAccessedAt: true,
      novelPromotionData: {
        select: {
          storyboardGenerationMode: true,
          videoRatio: true,
          artStyle: true,
          _count: {
            select: {
              episodes: true,
              characters: true,
              locations: true,
            },
          },
        },
      },
    },
  })
}

export async function getDuanjuProject(userId: string, projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId },
    include: {
      novelPromotionData: {
        include: {
          episodes: {
            orderBy: { episodeNumber: 'asc' },
            select: {
              id: true,
              episodeNumber: true,
              name: true,
              description: true,
              novelText: true,
              updatedAt: true,
              _count: {
                select: {
                  clips: true,
                  storyboards: true,
                  voiceLines: true,
                },
              },
            },
          },
          characters: {
            orderBy: { createdAt: 'asc' },
            include: { appearances: { orderBy: { appearanceIndex: 'asc' } } },
          },
          locations: {
            orderBy: { createdAt: 'asc' },
            include: { images: { orderBy: { imageIndex: 'asc' } } },
          },
        },
      },
    },
  })
  if (!project?.novelPromotionData) throw new ApiError('NOT_FOUND')

  return {
    ...project,
    novelPromotionData: {
      ...project.novelPromotionData,
      characters: project.novelPromotionData.characters.map((character) => ({
        ...character,
        aliases: parseJsonField(character.aliases),
        profileData: parseJsonField(character.profileData),
        appearances: character.appearances.map((appearance) => ({
          ...appearance,
          descriptions: parseJsonField(appearance.descriptions),
          imageUrls: parseJsonField(appearance.imageUrls),
        })),
      })),
      locations: project.novelPromotionData.locations.map((location) => ({
        ...location,
        images: location.images.map((image) => ({
          ...image,
          availableSlots: parseJsonField(image.availableSlots),
        })),
      })),
    },
  }
}

export async function getDuanjuEpisode(input: {
  userId: string
  projectId: string
  episodeId: string
}) {
  await requireOwnedEpisode(input.userId, input.projectId, input.episodeId)
  const episode = await prisma.novelPromotionEpisode.findUnique({
    where: { id: input.episodeId },
    include: {
      clips: { orderBy: { createdAt: 'asc' } },
      storyboards: {
        orderBy: [{ groupSequence: 'asc' }, { createdAt: 'asc' }],
        include: {
          panels: { orderBy: { panelIndex: 'asc' } },
        },
      },
      voiceLines: { orderBy: { lineIndex: 'asc' } },
    },
  })
  if (!episode) throw new ApiError('NOT_FOUND')
  return {
    ...episode,
    storyboards: episode.storyboards.map((storyboard) => ({
      ...storyboard,
      storyboardTextJson: parseJsonField(storyboard.storyboardTextJson),
      continuityAnchor: parseJsonField(storyboard.continuityAnchor),
      sheetGenerationOptionsSnapshot: parseJsonField(storyboard.sheetGenerationOptionsSnapshot),
      panels: storyboard.panels.map((panel) => ({
        ...panel,
        characters: parseJsonField(panel.characters),
        props: parseJsonField(panel.props),
        actingNotes: parseJsonField(panel.actingNotes),
        firstFrameSourceMeta: parseJsonField(panel.firstFrameSourceMeta),
        lastFrameSourceMeta: parseJsonField(panel.lastFrameSourceMeta),
      })),
    })),
  }
}

export async function createDuanjuProject(input: {
  userId: string
  name: string
  description?: string
}) {
  const draft = { name: input.name, description: input.description || null }
  if (validateProjectDraft(draft)) throw new ApiError('INVALID_PARAMS')
  const normalized = normalizeProjectDraft(draft)
  const preference = await prisma.userPreference.findUnique({
    where: { userId: input.userId },
  })

  return prisma.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        name: normalized.name,
        description: normalized.description,
        userId: input.userId,
      },
    })
    await tx.novelPromotionProject.create({
      data: {
        projectId: project.id,
        ...(preference
          ? {
              analysisModel: preference.analysisModel,
              characterModel: preference.characterModel,
              locationModel: preference.locationModel,
              storyboardModel: preference.storyboardModel,
              editModel: preference.editModel,
              videoModel: preference.videoModel,
              audioModel: preference.audioModel,
              videoRatio: preference.videoRatio,
              artStyle: isArtStyleValue(preference.artStyle)
                ? preference.artStyle
                : 'american-comic',
              ttsRate: preference.ttsRate,
            }
          : {}),
      },
    })
    return project
  })
}

export async function createDuanjuEpisode(input: {
  userId: string
  projectId: string
  name: string
  description?: string
  novelText?: string
}) {
  const project = await requireOwnedNovelProject(input.userId, input.projectId)
  const lastEpisode = await prisma.novelPromotionEpisode.findFirst({
    where: { novelPromotionProjectId: project.novelPromotionData!.id },
    orderBy: { episodeNumber: 'desc' },
  })
  const episode = await prisma.novelPromotionEpisode.create({
    data: {
      novelPromotionProjectId: project.novelPromotionData!.id,
      episodeNumber: (lastEpisode?.episodeNumber || 0) + 1,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      novelText: input.novelText,
    },
  })
  await prisma.novelPromotionProject.update({
    where: { id: project.novelPromotionData!.id },
    data: { lastEpisodeId: episode.id },
  })
  return episode
}

export async function updateDuanjuEpisode(input: {
  userId: string
  projectId: string
  episodeId: string
  name?: string
  description?: string | null
  novelText?: string | null
  srtContent?: string | null
}) {
  await requireOwnedEpisode(input.userId, input.projectId, input.episodeId)
  const data = {
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
    ...(input.novelText !== undefined ? { novelText: input.novelText } : {}),
    ...(input.srtContent !== undefined ? { srtContent: input.srtContent } : {}),
  }
  if (Object.keys(data).length === 0) throw new ApiError('INVALID_PARAMS')
  return prisma.novelPromotionEpisode.update({
    where: { id: input.episodeId },
    data,
  })
}

export async function upsertDuanjuCharacter(input: {
  userId: string
  projectId: string
  characterId?: string
  name: string
  introduction?: string
  aliases?: string[]
  appearanceDescription?: string
}) {
  const project = await requireOwnedNovelProject(input.userId, input.projectId)
  let characterId = input.characterId
  if (characterId) {
    const owned = await prisma.novelPromotionCharacter.findFirst({
      where: {
        id: characterId,
        novelPromotionProject: { projectId: input.projectId, project: { userId: input.userId } },
      },
      select: { id: true },
    })
    if (!owned) throw new ApiError('NOT_FOUND')
    await prisma.novelPromotionCharacter.update({
      where: { id: characterId },
      data: {
        name: input.name.trim(),
        introduction: input.introduction?.trim() || null,
        aliases: input.aliases ? JSON.stringify(input.aliases) : undefined,
      },
    })
  } else {
    const character = await prisma.novelPromotionCharacter.create({
      data: {
        novelPromotionProjectId: project.novelPromotionData!.id,
        name: input.name.trim(),
        introduction: input.introduction?.trim() || null,
        aliases: input.aliases ? JSON.stringify(input.aliases) : null,
      },
    })
    characterId = character.id
  }

  if (input.appearanceDescription !== undefined) {
    const description = input.appearanceDescription.trim()
    await prisma.characterAppearance.upsert({
      where: { characterId_appearanceIndex: { characterId, appearanceIndex: 0 } },
      create: {
        characterId,
        appearanceIndex: 0,
        changeReason: '初始形象',
        description,
        descriptions: JSON.stringify([description]),
        imageUrls: '[]',
        previousImageUrls: '[]',
      },
      update: {
        description,
        descriptions: JSON.stringify([description]),
      },
    })
  }
  return prisma.novelPromotionCharacter.findUnique({
    where: { id: characterId },
    include: { appearances: { orderBy: { appearanceIndex: 'asc' } } },
  })
}

export async function upsertDuanjuLocation(input: {
  userId: string
  projectId: string
  locationId?: string
  name: string
  summary?: string
  assetKind: 'location' | 'prop'
  imageDescription?: string
}) {
  const project = await requireOwnedNovelProject(input.userId, input.projectId)
  let locationId = input.locationId
  if (locationId) {
    const owned = await prisma.novelPromotionLocation.findFirst({
      where: {
        id: locationId,
        novelPromotionProject: { projectId: input.projectId, project: { userId: input.userId } },
      },
      select: { id: true },
    })
    if (!owned) throw new ApiError('NOT_FOUND')
    await prisma.novelPromotionLocation.update({
      where: { id: locationId },
      data: {
        name: input.name.trim(),
        summary: input.summary?.trim() || null,
        assetKind: input.assetKind,
      },
    })
  } else {
    const location = await prisma.novelPromotionLocation.create({
      data: {
        novelPromotionProjectId: project.novelPromotionData!.id,
        name: input.name.trim(),
        summary: input.summary?.trim() || null,
        assetKind: input.assetKind,
      },
    })
    locationId = location.id
  }
  if (input.imageDescription !== undefined) {
    await prisma.locationImage.upsert({
      where: { locationId_imageIndex: { locationId, imageIndex: 0 } },
      create: {
        locationId,
        imageIndex: 0,
        description: input.imageDescription.trim(),
      },
      update: { description: input.imageDescription.trim() },
    })
  }
  return prisma.novelPromotionLocation.findUnique({
    where: { id: locationId },
    include: { images: { orderBy: { imageIndex: 'asc' } } },
  })
}

export async function importDuanjuStoryboards(input: {
  userId: string
  projectId: string
  data: ExternalStoryboardImportInput
}) {
  return importExternalGridStoryboards(input)
}

export async function listDuanjuTasks(input: {
  userId: string
  projectId: string
  episodeId?: string
  limit: number
}) {
  await requireOwnedNovelProject(input.userId, input.projectId)
  return prisma.task.findMany({
    where: {
      userId: input.userId,
      projectId: input.projectId,
      ...(input.episodeId ? { episodeId: input.episodeId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: input.limit,
    select: {
      id: true,
      episodeId: true,
      type: true,
      targetType: true,
      targetId: true,
      status: true,
      progress: true,
      attempt: true,
      externalId: true,
      errorCode: true,
      errorMessage: true,
      queuedAt: true,
      startedAt: true,
      finishedAt: true,
      heartbeatAt: true,
      createdAt: true,
      updatedAt: true,
    },
  })
}
