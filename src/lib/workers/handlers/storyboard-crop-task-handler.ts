import type { Job } from 'bullmq'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { cropSixGridSheet, type SixGridCropArtifact } from '@/lib/novel-promotion/six-grid/crop-service'
import type { TaskJobData } from '@/lib/task/types'
import { buildSixGridTaskDedupeKey, parseSixGridImageTaskSnapshot, sourceMatchesSnapshot, type SixGridImageTaskSnapshot } from './storyboard-sheet-task-handler'
import { getObjectBuffer } from '@/lib/storage'
import { assertTaskActive } from '@/lib/workers/utils'
import { resolveStoryboardGridSpec, type GridStoryboardMode, type StoryboardGridSpec } from '@/lib/novel-promotion/grid-storyboard/spec'

type CropArtifact = Pick<SixGridCropArtifact, 'cellIndex' | 'mediaId' | 'url' | 'normalizedCropRect'> & { lineage: unknown }
type CurrentCropPanel = {
  id: string
  gridCellIndex: number | null
  imageMediaId: string | null
  imageUrl: string | null
}

type CropTransactionClient = {
  lockStoryboard: (input: {
    storyboardId: string
    sourceMediaId: string
    expectedSheetArtifactVersion: number
    processingOrder: SixGridImageTaskSnapshot['processingOrder']
    mode?: GridStoryboardMode
    userId?: string
    projectId?: string
    episodeId?: string
  }) => Promise<boolean>
  novelPromotionPanel: {
    findMany: (args: unknown) => Promise<CurrentCropPanel[]>
    update: (args: unknown) => Promise<unknown>
  }
}
type Transaction = (callback: (tx: CropTransactionClient) => Promise<void>) => Promise<unknown>

export async function commitSixGridCropBatch(input: {
  storyboardId: string
  sourceMediaId: string
  expectedSheetArtifactVersion: number
  processingOrder: SixGridImageTaskSnapshot['processingOrder']
  taskLineage: string
  gridSpec?: StoryboardGridSpec
  userId?: string
  projectId?: string
  episodeId?: string
  artifacts: CropArtifact[]
}, dependencies: { transaction?: Transaction } = {}) {
  const gridSpec = input.gridSpec ?? resolveStoryboardGridSpec('six_grid', '16:9')
  if (input.artifacts.length !== gridSpec.panelCount
    || new Set(input.artifacts.map((item) => item.cellIndex)).size !== gridSpec.panelCount
    || input.artifacts.some((item) => item.cellIndex < 0 || item.cellIndex >= gridSpec.panelCount)) {
    throw new Error('SIX_GRID_CROP_BATCH_INCOMPLETE')
  }
  const runTransaction = dependencies.transaction ?? defaultCropTransaction
  await runTransaction(async (tx) => {
    const locked = await tx.lockStoryboard({
      storyboardId: input.storyboardId,
      sourceMediaId: input.sourceMediaId,
      expectedSheetArtifactVersion: input.expectedSheetArtifactVersion,
      processingOrder: input.processingOrder,
      mode: gridSpec.mode,
      userId: input.userId,
      projectId: input.projectId,
      episodeId: input.episodeId,
    })
    if (!locked) throw new Error('SIX_GRID_SOURCE_STALE')
    const currentPanels = await tx.novelPromotionPanel.findMany({
      where: { storyboardId: input.storyboardId },
      select: { id: true, gridCellIndex: true, imageMediaId: true, imageUrl: true },
    })
    if (currentPanels.length !== gridSpec.panelCount) throw new Error('SIX_GRID_CROP_BATCH_INCOMPLETE')
    const currentByCell = new Map(currentPanels.map((panel) => [panel.gridCellIndex, panel]))
    for (const artifact of [...input.artifacts].sort((a, b) => a.cellIndex - b.cellIndex)) {
      const previous = currentByCell.get(artifact.cellIndex)
      if (!previous) throw new Error('SIX_GRID_CROP_BATCH_INCOMPLETE')
      await tx.novelPromotionPanel.update({
        where: { id: previous.id },
        data: {
          previousImageMediaId: previous.imageMediaId,
          previousImageUrl: previous.imageUrl,
          croppedImageMediaId: artifact.mediaId,
          croppedImageUrl: artifact.url,
          normalizedCropRect: JSON.stringify(artifact.normalizedCropRect),
          upscaledImageMediaId: null,
          upscaledImageUrl: null,
          imageMediaId: artifact.mediaId,
          imageUrl: artifact.url,
          imageDerivation: 'six_grid_crop',
          imageLineage: JSON.stringify({ artifact: artifact.lineage, taskLineage: input.taskLineage }),
        },
      })
    }
  })
}

const defaultCropTransaction: Transaction = async (callback) => prisma.$transaction(async (tx) => {
  await callback({
    lockStoryboard: async (input) => {
      if (input.userId && input.projectId && input.episodeId && input.mode) {
        const sourceColumn = input.processingOrder === 'sheet_upscale_then_crop'
          ? Prisma.sql`storyboard.upscaledSheetImageMediaId`
          : Prisma.sql`storyboard.sheetImageMediaId`
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
            AND storyboard.layoutMode = ${input.mode}
            AND storyboard.sheetArtifactVersion = ${input.expectedSheetArtifactVersion}
            AND ${sourceColumn} = ${input.sourceMediaId}
            AND project.id = ${input.projectId}
            AND project.userId = ${input.userId}
          LIMIT 1
          FOR UPDATE
        `)
        return rows.length === 1
      }
      const rows = input.processingOrder === 'sheet_upscale_then_crop'
        ? await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT id
            FROM novel_promotion_storyboards
            WHERE id = ${input.storyboardId}
              AND sheetArtifactVersion = ${input.expectedSheetArtifactVersion}
              AND upscaledSheetImageMediaId = ${input.sourceMediaId}
            LIMIT 1
            FOR UPDATE
          `)
        : await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT id
            FROM novel_promotion_storyboards
            WHERE id = ${input.storyboardId}
              AND sheetArtifactVersion = ${input.expectedSheetArtifactVersion}
              AND sheetImageMediaId = ${input.sourceMediaId}
            LIMIT 1
            FOR UPDATE
          `)
      return rows.length === 1
    },
    novelPromotionPanel: {
      findMany: (args) => tx.novelPromotionPanel.findMany(
        args as Prisma.NovelPromotionPanelFindManyArgs,
      ) as unknown as Promise<CurrentCropPanel[]>,
      update: (args) => tx.novelPromotionPanel.update(
        args as Prisma.NovelPromotionPanelUpdateArgs,
      ),
    },
  })
})

export async function executeSixGridCrop(snapshotValue: unknown, dependencies: {
  userId: string
  crop?: typeof cropSixGridSheet
  transaction?: Transaction
  assertActive?: (stage: string) => Promise<void>
}) {
  const snapshot = parseSixGridImageTaskSnapshot(snapshotValue)
  if (snapshot.operation !== 'crop' || !snapshot.sourceMediaId || !snapshot.cropRects) {
    throw new Error('SIX_GRID_CROP_SNAPSHOT_INVALID')
  }
  const crop = dependencies.crop ?? cropSixGridSheet
  await dependencies.assertActive?.('six_grid_crop_before_crop')
  const artifacts = await crop({
    userId: dependencies.userId,
    projectId: snapshot.projectId,
    storyboardId: snapshot.storyboardId,
    sourceMediaId: snapshot.sourceMediaId,
    expectedSheetArtifactVersion: snapshot.expectedSheetArtifactVersion,
    cellAspectRatio: snapshot.cellAspectRatio,
    gridSpec: snapshot.gridSpec,
    manualOverrides: snapshot.cropRects,
  })
  await dependencies.assertActive?.('six_grid_crop_after_crop')
  await commitSixGridCropBatch({
    storyboardId: snapshot.storyboardId,
    sourceMediaId: snapshot.sourceMediaId,
    expectedSheetArtifactVersion: snapshot.expectedSheetArtifactVersion,
    processingOrder: snapshot.processingOrder,
    taskLineage: buildSixGridTaskDedupeKey(snapshot),
    gridSpec: snapshot.gridSpec,
    userId: dependencies.userId,
    projectId: snapshot.projectId,
    episodeId: snapshot.episodeId,
    artifacts,
  }, { transaction: dependencies.transaction })
  return { storyboardId: snapshot.storyboardId, mediaIds: artifacts.map((item) => item.mediaId) }
}

export async function handleStoryboardCropTask(job: Job<TaskJobData>) {
  await assertTaskActive(job, 'six_grid_crop_entry')
  const snapshot = parseSixGridImageTaskSnapshot(job.data.payload)
  if (!snapshot.sourceMediaId || !snapshot.cropRects) throw new Error('SIX_GRID_CROP_SNAPSHOT_INVALID')
  const source = await prisma.mediaObject.findUnique({ where: { id: snapshot.sourceMediaId }, select: { id: true, sha256: true, updatedAt: true } })
  if (!source || !sourceMatchesSnapshot(source, snapshot)) throw new Error('SIX_GRID_SOURCE_STALE')
  const reconciled = await reconcileCommittedCrop(snapshot)
  if (reconciled) return { storyboardId: snapshot.storyboardId, mediaIds: reconciled, reconciled: true }
  await assertTaskActive(job, 'six_grid_crop_before_crop')
  let artifacts: SixGridCropArtifact[]
  try {
    artifacts = await cropSixGridSheet({
      userId: job.data.userId,
      projectId: job.data.projectId,
      storyboardId: snapshot.storyboardId,
      sourceMediaId: snapshot.sourceMediaId,
      expectedSheetArtifactVersion: snapshot.expectedSheetArtifactVersion,
      cellAspectRatio: snapshot.cellAspectRatio,
      gridSpec: snapshot.gridSpec,
      manualOverrides: snapshot.cropRects,
    })
  } catch (error) {
    throw toRetryableCropError(error)
  }
  await assertTaskActive(job, 'six_grid_crop_after_crop')
  await assertTaskActive(job, 'six_grid_crop_before_persist')
  await commitSixGridCropBatch({
    storyboardId: snapshot.storyboardId,
    sourceMediaId: snapshot.sourceMediaId,
    expectedSheetArtifactVersion: snapshot.expectedSheetArtifactVersion,
    processingOrder: snapshot.processingOrder,
    taskLineage: buildSixGridTaskDedupeKey(snapshot),
    gridSpec: snapshot.gridSpec,
    userId: job.data.userId,
    projectId: snapshot.projectId,
    episodeId: snapshot.episodeId,
    artifacts,
  })
  return { storyboardId: snapshot.storyboardId, mediaIds: artifacts.map((item) => item.mediaId) }
}

async function reconcileCommittedCrop(snapshot: SixGridImageTaskSnapshot) {
  const taskLineage = buildSixGridTaskDedupeKey(snapshot)
  const panels = await prisma.novelPromotionPanel.findMany({
    where: {
      storyboardId: snapshot.storyboardId,
      storyboard: {
        is: {
          id: snapshot.storyboardId,
          episodeId: snapshot.episodeId,
          layoutMode: snapshot.gridSpec?.mode ?? 'six_grid',
          sheetArtifactVersion: snapshot.expectedSheetArtifactVersion,
          episode: {
            novelPromotionProject: {
              projectId: snapshot.projectId,
            },
          },
        },
      },
    },
    select: { gridCellIndex: true, croppedImageMediaId: true, imageMediaId: true, imageLineage: true, croppedImageMedia: true },
    orderBy: { gridCellIndex: 'asc' },
  })
  const panelCount = snapshot.gridSpec?.panelCount ?? 6
  if (panels.length !== panelCount || panels.some((panel) => !panel.croppedImageMedia?.storageKey
    || panel.imageMediaId !== panel.croppedImageMediaId || !panel.imageLineage?.includes(taskLineage))) return null
  for (const panel of panels) await getObjectBuffer(panel.croppedImageMedia!.storageKey)
  return panels.map((panel) => panel.croppedImageMediaId!)
}

export function toRetryableCropError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (!['SIX_GRID_CROP_BUSY', 'SIX_GRID_CROP_CLAIM_LOST', 'SIX_GRID_SOURCE_READ_FAILED', 'SIX_GRID_CROP_BATCH_FAILED'].includes(message)) return error
  return Object.assign(new Error(message), { code: 'WORKER_EXECUTION_ERROR' as const })
}
