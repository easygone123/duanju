import { Prisma } from '@prisma/client'
import { ApiError } from '@/lib/api-errors'
import { prisma } from '@/lib/prisma'
import { TASK_STATUS, TASK_TYPE } from '@/lib/task/types'

export type SixGridUploadIdentity = {
  userId: string
  projectId: string
  episodeId: string
  storyboardId: string
}

export type ReplaceSixGridSheetInput = SixGridUploadIdentity & {
  expectedSheetArtifactVersion: number
  media: {
    id: string
    url: string
  }
}

export type SixGridUploadTaskQuery = {
  where: {
    userId: string
    projectId: string
    episodeId: string
    targetType: 'NovelPromotionStoryboard'
    targetId: string
    type: { in: string[] }
    status: { in: string[] }
  }
  select: { id: true }
}

export type SixGridStoryboardReplacement = SixGridUploadIdentity & {
  expectedSheetArtifactVersion: number
  mediaId: string
  url: string
}

type SixGridUploadTaskReader = {
  findActiveTask(input: SixGridUploadTaskQuery): Promise<{ id: string } | null>
}

export interface SixGridUploadTransaction extends SixGridUploadTaskReader {
  lockOwnedStoryboard(input: SixGridUploadIdentity): Promise<boolean>
  replaceOwnedStoryboard(input: SixGridStoryboardReplacement): Promise<{ count: number }>
  clearStoryboardPanels(storyboardId: string): Promise<{ count: number }>
  readStoryboardSheet(storyboardId: string): Promise<{
    sheetImageMediaId: string | null
    sheetImageUrl: string | null
    sheetArtifactVersion: number
  } | null>
}

export interface SixGridUploadStore extends SixGridUploadTaskReader {
  transaction<T>(operation: (transaction: SixGridUploadTransaction) => Promise<T>): Promise<T>
}

const defaultSixGridUploadStore: SixGridUploadStore = {
  findActiveTask: (input) => prisma.task.findFirst(input),
  transaction: (operation) => prisma.$transaction((tx) => operation({
    lockOwnedStoryboard: async (input) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT storyboard.id
        FROM novel_promotion_storyboards AS storyboard
        INNER JOIN novel_promotion_episodes AS episode
          ON episode.id = storyboard.episodeId
        INNER JOIN novel_promotion_projects AS promotion
          ON promotion.id = episode.novelPromotionProjectId
        INNER JOIN projects AS project
          ON project.id = promotion.projectId
        WHERE storyboard.id = ${input.storyboardId}
          AND storyboard.episodeId = ${input.episodeId}
          AND storyboard.layoutMode = 'six_grid'
          AND project.id = ${input.projectId}
          AND project.userId = ${input.userId}
        LIMIT 1
        FOR UPDATE
      `)
      return rows.length === 1
    },
    findActiveTask: (input) => tx.task.findFirst(input),
    replaceOwnedStoryboard: (input) => tx.novelPromotionStoryboard.updateMany({
      where: {
        id: input.storyboardId,
        episodeId: input.episodeId,
        layoutMode: 'six_grid',
        sheetArtifactVersion: input.expectedSheetArtifactVersion,
        episode: {
          novelPromotionProject: {
            projectId: input.projectId,
            project: { userId: input.userId },
          },
        },
      },
      data: {
        sheetImageMediaId: input.mediaId,
        sheetImageUrl: input.url,
        upscaledSheetImageMediaId: null,
        upscaledSheetImageUrl: null,
        imageHistory: null,
        lastError: null,
        sheetArtifactVersion: { increment: 1 },
      },
    }),
    clearStoryboardPanels: (storyboardId) => tx.novelPromotionPanel.updateMany({
      where: { storyboardId },
      data: {
        imageMediaId: null,
        imageUrl: null,
        imageHistory: null,
        candidateImages: null,
        previousImageMediaId: null,
        previousImageUrl: null,
        normalizedCropRect: null,
        croppedImageMediaId: null,
        croppedImageUrl: null,
        upscaledImageMediaId: null,
        upscaledImageUrl: null,
        imageDerivation: null,
        imageLineage: null,
      },
    }),
    readStoryboardSheet: (storyboardId) => tx.novelPromotionStoryboard.findUnique({
      where: { id: storyboardId },
      select: {
        sheetImageMediaId: true,
        sheetImageUrl: true,
        sheetArtifactVersion: true,
      },
    }),
  }), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
}

export async function assertSixGridUploadAvailable(
  input: SixGridUploadIdentity,
  store: SixGridUploadTaskReader = defaultSixGridUploadStore,
): Promise<void> {
  const activeTask = await store.findActiveTask({
    where: {
      userId: input.userId,
      projectId: input.projectId,
      episodeId: input.episodeId,
      targetType: 'NovelPromotionStoryboard',
      targetId: input.storyboardId,
      type: {
        in: [
          TASK_TYPE.STORYBOARD_SHEET_GENERATE,
          TASK_TYPE.STORYBOARD_SHEET_UPSCALE,
          TASK_TYPE.STORYBOARD_SHEET_CROP,
        ],
      },
      status: { in: [TASK_STATUS.QUEUED, TASK_STATUS.PROCESSING] },
    },
    select: { id: true },
  })
  if (activeTask) throw new ApiError('CONFLICT', { code: 'SIX_GRID_UPLOAD_BUSY' })
}

export async function replaceSixGridSheet(
  input: ReplaceSixGridSheetInput,
  store: SixGridUploadStore = defaultSixGridUploadStore,
): Promise<{ mediaId: string; url: string; sheetArtifactVersion: number }> {
  await assertSixGridUploadAvailable(input, store)
  try {
    return await store.transaction(async (transaction) => {
      if (!await transaction.lockOwnedStoryboard(input)) {
        throw new ApiError('CONFLICT', { code: 'SIX_GRID_UPLOAD_STALE' })
      }
      await assertSixGridUploadAvailable(input, transaction)

      const storyboard = await transaction.replaceOwnedStoryboard({
        userId: input.userId,
        projectId: input.projectId,
        episodeId: input.episodeId,
        storyboardId: input.storyboardId,
        expectedSheetArtifactVersion: input.expectedSheetArtifactVersion,
        mediaId: input.media.id,
        url: input.media.url,
      })
      if (storyboard.count !== 1) {
        throw new ApiError('CONFLICT', { code: 'SIX_GRID_UPLOAD_STALE' })
      }

      const panels = await transaction.clearStoryboardPanels(input.storyboardId)
      if (panels.count !== 6) {
        throw new ApiError('CONFLICT', { code: 'SIX_GRID_UPLOAD_PANEL_SET_CHANGED' })
      }

      const current = await transaction.readStoryboardSheet(input.storyboardId)
      if (!current || current.sheetImageMediaId === null || current.sheetImageUrl === null) {
        throw new ApiError('CONFLICT', { code: 'SIX_GRID_UPLOAD_STALE' })
      }
      return {
        mediaId: current.sheetImageMediaId,
        url: current.sheetImageUrl,
        sheetArtifactVersion: current.sheetArtifactVersion,
      }
    })
  } catch (error) {
    if (isPrismaTransactionConflict(error)) {
      throw new ApiError('CONFLICT', { code: 'SIX_GRID_UPLOAD_STALE' })
    }
    throw error
  }
}

function isPrismaTransactionConflict(error: unknown): error is { code: 'P2034' } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2034'
}
