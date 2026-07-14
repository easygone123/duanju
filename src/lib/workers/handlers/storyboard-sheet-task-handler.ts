import { createHash } from 'node:crypto'
import type { Job } from 'bullmq'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ensureMediaObjectFromStorageKey } from '@/lib/media/service'
import { getObjectBuffer } from '@/lib/storage'
import { assertTaskActive, resolveImageSourceFromGeneration, uploadImageSourceToCos } from '@/lib/workers/utils'
import { normalizeReferenceImagesForGeneration } from '@/lib/media/outbound-image'
import type { TaskJobData } from '@/lib/task/types'
import type { NormalizedCropRect, SixGridCellAspectRatio, SixGridProcessingOrder } from '@/lib/novel-promotion/six-grid/contracts'

const rectSchema = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  width: z.number().finite().positive().max(1),
  height: z.number().finite().positive().max(1),
}).strict().refine((rect) => rect.x + rect.width <= 1 && rect.y + rect.height <= 1, 'crop out of bounds')

const snapshotSchema = z.object({
  operation: z.enum(['generate', 'sheet_upscale', 'crop', 'panel_upscale']),
  projectId: z.string().min(1), episodeId: z.string().min(1), storyboardId: z.string().min(1),
  groupSequence: z.number().int().nonnegative(), panelId: z.string().min(1).optional(),
  sourceMediaId: z.string().min(1).optional(), sourceChecksum: z.string().min(1).optional(), sourceVersion: z.string().min(1).optional(),
  workflowId: z.string().min(1).optional(), workflowVersionId: z.string().min(1).optional(), workflowPurpose: z.enum(['generation', 'upscale']).optional(),
  cellAspectRatio: z.enum(['16:9', '9:16']),
  processingOrder: z.enum(['sheet_upscale_then_crop', 'crop_then_panel_upscale']),
  expectedSheetArtifactVersion: z.number().int().nonnegative(),
  cropRects: z.array(z.object({ cellIndex: z.number().int().min(0).max(5), normalizedCropRect: rectSchema }).strict()).length(6).optional(),
  promptSnapshot: z.string(), modelSnapshot: z.string().min(1), optionsSnapshot: z.record(z.unknown()),
  imageModel: z.string().min(1).optional(), generationOptions: z.record(z.unknown()).optional(),
  comfyWorkflowVersionId: z.string().min(1).optional(), comfyModelSnapshotVersion: z.literal(1).optional(),
  locale: z.enum(['zh', 'en']),
}).strip()

export type SixGridImageTaskSnapshot = {
  operation: 'generate' | 'sheet_upscale' | 'crop' | 'panel_upscale'
  projectId: string; episodeId: string; storyboardId: string; groupSequence: number; panelId?: string
  sourceMediaId?: string; sourceChecksum?: string; sourceVersion?: string
  workflowId?: string; workflowVersionId?: string; workflowPurpose?: 'generation' | 'upscale'
  cellAspectRatio: SixGridCellAspectRatio; processingOrder: SixGridProcessingOrder
  expectedSheetArtifactVersion: number
  cropRects?: Array<{ cellIndex: number; normalizedCropRect: NormalizedCropRect }>
  promptSnapshot: string; modelSnapshot: string; optionsSnapshot: Record<string, unknown>; locale: 'zh' | 'en'
  imageModel?: string; generationOptions?: Record<string, unknown>; comfyWorkflowVersionId?: string; comfyModelSnapshotVersion?: 1
}

export function parseSixGridImageTaskSnapshot(value: unknown): SixGridImageTaskSnapshot {
  const parsed = snapshotSchema.parse(value)
  const indexes = parsed.cropRects?.map((item) => item.cellIndex)
  if (indexes && new Set(indexes).size !== 6) throw new Error('SIX_GRID_CROP_INDEXES_INVALID')
  if (parsed.operation !== 'generate' && (!parsed.sourceMediaId || !parsed.sourceChecksum || !parsed.sourceVersion)) {
    throw new Error('SIX_GRID_SOURCE_SNAPSHOT_REQUIRED')
  }
  if ((parsed.operation === 'sheet_upscale' || parsed.operation === 'panel_upscale')
    && (!parsed.workflowId || !parsed.workflowVersionId || parsed.workflowPurpose !== 'upscale')) {
    throw new Error('SIX_GRID_UPSCALE_WORKFLOW_SNAPSHOT_REQUIRED')
  }
  if (parsed.operation === 'generate' && parsed.modelSnapshot.startsWith('comfyui::')
    && (!parsed.workflowId || !parsed.workflowVersionId || parsed.workflowPurpose !== 'generation'
      || parsed.comfyWorkflowVersionId !== parsed.workflowVersionId || parsed.comfyModelSnapshotVersion !== 1)) {
    throw new Error('SIX_GRID_GENERATION_WORKFLOW_SNAPSHOT_REQUIRED')
  }
  return {
    ...parsed,
    ...(parsed.cropRects ? { cropRects: [...parsed.cropRects].sort((a, b) => a.cellIndex - b.cellIndex) } : {}),
  } as SixGridImageTaskSnapshot
}

export function resolveSheetAspectRatio(cellRatio: SixGridCellAspectRatio) {
  return cellRatio === '16:9' ? '8:3' : '27:32'
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  return JSON.stringify(value)
}

export function buildSixGridTaskDedupeKey(snapshot: SixGridImageTaskSnapshot) {
  const identity = {
    operation: snapshot.operation, target: snapshot.panelId || snapshot.storyboardId,
    sourceMediaId: snapshot.sourceMediaId, sourceChecksum: snapshot.sourceChecksum, sourceVersion: snapshot.sourceVersion,
    workflowId: snapshot.workflowId, workflowVersionId: snapshot.workflowVersionId,
    cellAspectRatio: snapshot.cellAspectRatio, processingOrder: snapshot.processingOrder,
    cropRects: snapshot.cropRects ? [...snapshot.cropRects].sort((a, b) => a.cellIndex - b.cellIndex) : undefined,
    promptSnapshot: snapshot.promptSnapshot, modelSnapshot: snapshot.modelSnapshot,
    options: snapshot.optionsSnapshot, generationOptions: snapshot.generationOptions,
    expectedSheetArtifactVersion: snapshot.expectedSheetArtifactVersion,
  }
  return `six-grid:${snapshot.operation}:${createHash('sha256').update(stable(identity)).digest('hex')}`
}

export function sourceMatchesSnapshot(media: { id: string; sha256: string | null; updatedAt: Date | string }, snapshot: SixGridImageTaskSnapshot) {
  const version = media.updatedAt instanceof Date ? media.updatedAt.toISOString() : media.updatedAt
  return media.id === snapshot.sourceMediaId
    && (media.sha256 || `media:${media.id}`) === snapshot.sourceChecksum
    && version === snapshot.sourceVersion
}

export async function handleStoryboardSheetTask(job: Job<TaskJobData>) {
  await assertTaskActive(job, 'six_grid_sheet_entry')
  const snapshot = parseSixGridImageTaskSnapshot(job.data.payload)
  if (snapshot.operation !== 'generate' && snapshot.operation !== 'sheet_upscale') throw new Error('SIX_GRID_SHEET_OPERATION_INVALID')
  const storyboard = await prisma.novelPromotionStoryboard.findFirst({
    where: { id: snapshot.storyboardId, episodeId: snapshot.episodeId, layoutMode: 'six_grid' },
    include: { sheetImageMedia: true, upscaledSheetImageMedia: true },
  })
  if (!storyboard) throw new Error('SIX_GRID_SHEET_STALE')
  const lineage = buildSixGridTaskDedupeKey(snapshot)
  const current = snapshot.operation === 'generate' ? storyboard.sheetImageMedia : storyboard.upscaledSheetImageMedia
  if (storyboard.sheetArtifactVersion === snapshot.expectedSheetArtifactVersion + 1
    && current?.storageKey && (snapshot.operation === 'generate'
      ? storyboard.sheetGenerationOptionsSnapshot?.includes(lineage)
      : hasUpscaleHistoryLineage(storyboard.imageHistory, lineage))) {
    await getObjectBuffer(current.storageKey)
    return { storyboardId: storyboard.id, mediaId: current.id, reconciled: true }
  }
  if (storyboard.sheetArtifactVersion !== snapshot.expectedSheetArtifactVersion) throw new Error('SIX_GRID_SHEET_STALE')
  if (snapshot.operation === 'sheet_upscale' && (!storyboard.sheetImageMedia || !sourceMatchesSnapshot(storyboard.sheetImageMedia, snapshot))) throw new Error('SIX_GRID_SOURCE_STALE')
  const sourceMedia = snapshot.operation === 'sheet_upscale' ? storyboard.sheetImageMedia : null
  const references = sourceMedia ? await prepareVerifiedSourceReferences(sourceMedia, snapshot.modelSnapshot.startsWith('comfyui::')) : null
  await assertTaskActive(job, 'six_grid_sheet_before_provider')
  const generated = await resolveImageSourceFromGeneration(job, {
    userId: job.data.userId, modelId: snapshot.modelSnapshot,
    invocationKey: `${job.data.taskId}:${lineage}`, comfyWorkflowVersionId: snapshot.workflowVersionId,
    prompt: snapshot.promptSnapshot,
    options: { ...snapshot.optionsSnapshot, aspectRatio: resolveSheetAspectRatio(snapshot.cellAspectRatio), ...(references ? { referenceImages: references.remote } : {}) },
    ...(references ? { comfyReferenceImages: references.comfy } : {}),
    allowTaskExternalIdResume: !snapshot.modelSnapshot.startsWith('comfyui::'),
  })
  await assertTaskActive(job, 'six_grid_sheet_after_provider')
  await assertTaskActive(job, 'six_grid_sheet_before_upload')
  const key = await uploadImageSourceToCos(generated, snapshot.operation === 'generate' ? 'storyboard-sheet' : 'storyboard-sheet-upscale', storyboard.id)
  await assertTaskActive(job, 'six_grid_sheet_after_upload')
  const media = await ensureMediaObjectFromStorageKey(key)
  const options = JSON.stringify({ ...snapshot.optionsSnapshot, lineage })
  const nextHistory = snapshot.operation === 'sheet_upscale'
    ? appendUpscaleHistory(storyboard.imageHistory, {
      type: 'six_grid_sheet_upscale', lineage, sourceMediaId: snapshot.sourceMediaId!,
      sourceChecksum: snapshot.sourceChecksum!, sourceVersion: snapshot.sourceVersion!,
      outputMediaId: media.id, workflowId: snapshot.workflowId!, workflowVersionId: snapshot.workflowVersionId!,
      modelSnapshot: snapshot.modelSnapshot, optionsSnapshot: snapshot.optionsSnapshot,
    })
    : null
  await assertTaskActive(job, 'six_grid_sheet_before_persist')
  const updated = await prisma.novelPromotionStoryboard.updateMany({
    where: { id: storyboard.id, sheetArtifactVersion: snapshot.expectedSheetArtifactVersion,
      ...(snapshot.operation === 'sheet_upscale' ? {
        sheetImageMediaId: snapshot.sourceMediaId, sheetImageMedia: { is: sourceSnapshotWhere(snapshot) },
        imageHistory: storyboard.imageHistory,
      } : {}) },
    data: snapshot.operation === 'generate'
      ? { sheetImageMediaId: media.id, sheetImageUrl: media.url, sheetPromptSnapshot: snapshot.promptSnapshot, sheetModelSnapshot: snapshot.modelSnapshot, sheetGenerationOptionsSnapshot: options, sheetArtifactVersion: { increment: 1 } }
      : { upscaledSheetImageMediaId: media.id, upscaledSheetImageUrl: media.url, imageHistory: nextHistory, sheetArtifactVersion: { increment: 1 } },
  })
  if (updated.count !== 1) throw new Error('SIX_GRID_SHEET_STALE')
  return { storyboardId: storyboard.id, mediaId: media.id, reconciled: false }
}

export async function handleStoryboardPanelUpscaleTask(job: Job<TaskJobData>) {
  await assertTaskActive(job, 'six_grid_panel_upscale_entry')
  const snapshot = parseSixGridImageTaskSnapshot(job.data.payload)
  if (snapshot.operation !== 'panel_upscale' || !snapshot.panelId) throw new Error('SIX_GRID_PANEL_UPSCALE_SNAPSHOT_INVALID')
  const panel = await prisma.novelPromotionPanel.findFirst({ where: { id: snapshot.panelId, storyboardId: snapshot.storyboardId }, include: { imageMedia: true, upscaledImageMedia: true } })
  if (!panel) throw new Error('SIX_GRID_SOURCE_STALE')
  const lineage = buildSixGridTaskDedupeKey(snapshot)
  if (panel.upscaledImageMedia?.storageKey && panel.imageLineage?.includes(lineage)) {
    await getObjectBuffer(panel.upscaledImageMedia.storageKey)
    return { panelId: panel.id, mediaId: panel.upscaledImageMedia.id, reconciled: true }
  }
  if (!panel.imageMedia || !sourceMatchesSnapshot(panel.imageMedia, snapshot)) throw new Error('SIX_GRID_SOURCE_STALE')
  const references = await prepareVerifiedSourceReferences(panel.imageMedia, snapshot.modelSnapshot.startsWith('comfyui::'))
  await assertTaskActive(job, 'six_grid_panel_upscale_before_provider')
  const generated = await resolveImageSourceFromGeneration(job, { userId: job.data.userId, modelId: snapshot.modelSnapshot,
    invocationKey: `${job.data.taskId}:${lineage}`, comfyWorkflowVersionId: snapshot.workflowVersionId, prompt: snapshot.promptSnapshot,
    options: { ...snapshot.optionsSnapshot, referenceImages: references.remote }, comfyReferenceImages: references.comfy,
    allowTaskExternalIdResume: !snapshot.modelSnapshot.startsWith('comfyui::') })
  await assertTaskActive(job, 'six_grid_panel_upscale_after_provider')
  await assertTaskActive(job, 'six_grid_panel_upscale_before_upload')
  const key = await uploadImageSourceToCos(generated, 'storyboard-panel-upscale', panel.id)
  await assertTaskActive(job, 'six_grid_panel_upscale_after_upload')
  const media = await ensureMediaObjectFromStorageKey(key)
  const advancesCurrent = media.id !== panel.imageMediaId
  await assertTaskActive(job, 'six_grid_panel_upscale_before_persist')
  const updated = await prisma.novelPromotionPanel.updateMany({ where: {
    id: panel.id, imageMediaId: snapshot.sourceMediaId, imageMedia: { is: sourceSnapshotWhere(snapshot) },
  }, data: {
    ...(advancesCurrent ? { previousImageMediaId: panel.imageMediaId, previousImageUrl: panel.imageUrl } : {}),
    upscaledImageMediaId: media.id, upscaledImageUrl: media.url,
    imageMediaId: media.id, imageUrl: media.url, imageDerivation: 'panel_upscale', imageLineage: JSON.stringify({ lineage, sourceMediaId: snapshot.sourceMediaId }),
  } })
  if (updated.count !== 1) throw new Error('SIX_GRID_SOURCE_STALE')
  return { panelId: panel.id, mediaId: media.id, reconciled: false }
}

function sourceSnapshotWhere(snapshot: SixGridImageTaskSnapshot) {
  const updatedAt = new Date(snapshot.sourceVersion!)
  if (!Number.isFinite(updatedAt.getTime())) throw new Error('SIX_GRID_SOURCE_SNAPSHOT_INVALID')
  return {
    id: snapshot.sourceMediaId,
    updatedAt,
    sha256: snapshot.sourceChecksum === `media:${snapshot.sourceMediaId}` ? null : snapshot.sourceChecksum,
  }
}

async function prepareVerifiedSourceReferences(media: { storageKey: string | null }, comfy: boolean) {
  if (!media.storageKey) throw new Error('SIX_GRID_SOURCE_STORAGE_MISSING')
  await getObjectBuffer(media.storageKey)
  return {
    remote: comfy ? [] : await normalizeReferenceImagesForGeneration([media.storageKey]),
    comfy: [media.storageKey],
  }
}

type SheetUpscaleHistoryEntry = {
  type: 'six_grid_sheet_upscale'; lineage: string; sourceMediaId: string; sourceChecksum: string; sourceVersion: string
  outputMediaId: string; workflowId: string; workflowVersionId: string; modelSnapshot: string; optionsSnapshot: Record<string, unknown>
}

function parseImageHistory(raw: string | null): unknown[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : [{ type: 'legacy_image_history', value: parsed }]
  } catch {
    return [{ type: 'legacy_image_history_raw', value: raw }]
  }
}

function appendUpscaleHistory(raw: string | null, entry: SheetUpscaleHistoryEntry) {
  const history = parseImageHistory(raw)
  if (!history.some((item) => item && typeof item === 'object' && (item as { lineage?: unknown }).lineage === entry.lineage)) history.push(entry)
  const serialized = JSON.stringify(history)
  if (history.length > 200 || serialized.length > 256_000) throw new Error('SIX_GRID_IMAGE_HISTORY_LIMIT')
  return serialized
}

function hasUpscaleHistoryLineage(raw: string | null, lineage: string) {
  return parseImageHistory(raw).some((item) => item && typeof item === 'object'
    && (item as { type?: unknown }).type === 'six_grid_sheet_upscale'
    && (item as { lineage?: unknown }).lineage === lineage)
}
