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

export interface SixGridUploadTransaction {
  replaceOwnedStoryboard(input: SixGridStoryboardReplacement): Promise<{ count: number }>
  clearStoryboardPanels(storyboardId: string): Promise<{ count: number }>
  readStoryboardSheet(storyboardId: string): Promise<{
    sheetImageMediaId: string | null
    sheetImageUrl: string | null
    sheetArtifactVersion: number
  } | null>
}

export interface SixGridUploadStore {
  findActiveTask(input: SixGridUploadTaskQuery): Promise<{ id: string } | null>
  transaction<T>(operation: (transaction: SixGridUploadTransaction) => Promise<T>): Promise<T>
}

const defaultSixGridUploadStore: SixGridUploadStore = {
  findActiveTask: (input) => prisma.task.findFirst(input),
  transaction: (operation) => prisma.$transaction((tx) => operation({
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
  store: SixGridUploadStore = defaultSixGridUploadStore,
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
  return store.transaction(async (transaction) => {
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
}
