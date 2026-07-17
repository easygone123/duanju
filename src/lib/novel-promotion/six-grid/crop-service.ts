import { createHash } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import {
  createCropMedia,
  preflightExistingCropMedia,
  uploadReservedCropMedia,
  type CropMediaRow,
  type PreparedCrop,
  type SixGridCropStorage,
} from './crop-artifact-store'
import {
  deleteObject as deleteStoredObject,
  getObjectBuffer,
  uploadObject as uploadStoredObject,
} from '@/lib/storage'
import {
  acquireCropClaim,
  releaseCropClaim,
  startCropClaimHeartbeat,
  type CropClaimHeartbeat,
} from './crop-claim'
import type { NormalizedCropRect, SixGridCellAspectRatio } from './contracts'
import {
  computeGridPixelRects,
  validateManualGridCrop,
} from '@/lib/novel-promotion/grid-storyboard/crop-geometry'
import {
  resolveStoryboardGridSpec,
  type StoryboardGridSpec,
} from '@/lib/novel-promotion/grid-storyboard/spec'
import {
  assertSixGridCellAspectRatio,
  computeSixGridPixelRects,
  pixelRectToNormalized,
  validateManualSixGridCrop,
  type PixelRect,
} from './crop-geometry'
import {
  extractCropPng,
  readCropSourceMetadata,
  type SharpPipelineObserver,
} from './crop-image'
import { readSixGridCropLimits } from './limits'

const ARTIFACT_VERSION = 1

export type { SixGridCropStorage } from './crop-artifact-store'

const defaultStorage: SixGridCropStorage = {
  getObjectBuffer,
  uploadObject: uploadStoredObject,
  deleteObject: deleteStoredObject,
}

export type SixGridCropLineage = {
  sourceMediaId: string
  sourceStorageKey: string
  sourceDimensions: { width: number; height: number }
  sourceChecksum: string
  sourceVersion: string
  cropRect: PixelRect
  processingStage: 'six_grid_crop'
  artifactVersion: number
  outputChecksum: string
  outputDimensions: { width: number; height: number }
}

export type SixGridCropArtifact = {
  cellIndex: number
  mediaId: string
  storageKey: string
  url: string
  pixelRect: PixelRect
  normalizedCropRect: NormalizedCropRect
  lineage: SixGridCropLineage
}

export type GridCropSheetInput = {
  userId: string
  projectId: string
  sourceMediaId: string
  cellAspectRatio: SixGridCellAspectRatio
  storyboardId?: string
  expectedSheetArtifactVersion?: number
  gridSpec?: StoryboardGridSpec & { version?: 1 }
  manualOverrides?: Array<{ cellIndex: number; normalizedCropRect: NormalizedCropRect }>
}

export async function cropGridSheet(input: GridCropSheetInput, dependencies: {
  storage?: SixGridCropStorage
  claimLeaseMs?: number
  onSharpPipelineActivity?: SharpPipelineObserver
} = {}): Promise<SixGridCropArtifact[]> {
  assertSixGridCellAspectRatio(input.cellAspectRatio)
  const limits = readSixGridCropLimits()
  const storage = dependencies.storage ?? defaultStorage
  const owned = await findOwnedSheetMedia(input)
  const source = owned?.media
  if (!owned || !source || !source.storageKey || !source.mimeType?.startsWith('image/')) {
    throw new Error('SIX_GRID_SOURCE_NOT_FOUND_OR_FORBIDDEN')
  }
  const gridSpec = resolveOwnedGridSpec(owned.storyboard, input)
  const resolvedInput = { ...input, gridSpec }
  const owner = await acquireCropClaim({ sourceMediaId: source.id, leaseMs: dependencies.claimLeaseMs })
  const heartbeat = startCropClaimHeartbeat(owner)
  try {
    await heartbeat.fence()
    const sourceBytes = await readSourceBytes(
      storage,
      source.storageKey,
      source.sizeBytes,
      limits.maxSourceBytes,
    )
    await heartbeat.fence()
    const sourceChecksum = sha256(sourceBytes)
    if (source.sha256 && source.sha256 !== sourceChecksum) {
      throw new Error('SIX_GRID_SOURCE_IDENTITY_MISMATCH')
    }
    const dimensions = await readCropSourceMetadata(sourceBytes, dependencies.onSharpPipelineActivity)
    await heartbeat.fence()
    const rects = resolveCropRects(resolvedInput, dimensions)
    const prepared = await prepareCropIdentities({
      input: resolvedInput,
      source,
      sourceBytes,
      sourceChecksum,
      dimensions,
      rects,
      observer: dependencies.onSharpPipelineActivity,
      heartbeat,
    })
    await heartbeat.fence()
    const existing = await preflightExistingCropMedia(storage, prepared, async () => await heartbeat.fence())
    await heartbeat.fence()
    const outputs: SixGridCropArtifact[] = []
    for (const artifact of prepared) {
      let media = existing.get(artifact.storageKey)?.media
      if (!media || existing.get(artifact.storageKey)?.needsUpload) {
        await heartbeat.fence()
        const bytes = await extractCropPng(sourceBytes, artifact.pixelRect, dependencies.onSharpPipelineActivity)
        if (bytes.length !== artifact.outputSize || sha256(bytes) !== artifact.outputChecksum) {
          throw new Error('SIX_GRID_CROP_IDENTITY_CONFLICT')
        }
        await heartbeat.fence()
        media = media
          ? await uploadReservedCropMedia(storage, media, artifact, bytes, async () => await heartbeat.fence())
          : await createCropMedia(storage, artifact, bytes, async () => await heartbeat.fence())
        await heartbeat.fence()
      }
      outputs.push(toArtifact(artifact, media, source, sourceChecksum, dimensions))
    }
    return outputs
  } catch (error) {
    if (isStableCropError(error)) throw error
    throw new Error('SIX_GRID_CROP_BATCH_FAILED')
  } finally {
    await heartbeat.stop()
    await releaseCropClaim(owner).catch(() => false)
  }
}

export async function cropSixGridSheet(
  input: GridCropSheetInput,
  dependencies: Parameters<typeof cropGridSheet>[1] = {},
): Promise<SixGridCropArtifact[]> {
  return cropGridSheet(input, dependencies)
}

async function prepareCropIdentities(input: {
  input: GridCropSheetInput & { gridSpec: StoryboardGridSpec }
  source: CropMediaRow
  sourceBytes: Buffer
  sourceChecksum: string
  dimensions: { width: number; height: number }
  rects: Array<{ cellIndex: number; pixelRect: PixelRect }>
  observer?: SharpPipelineObserver
  heartbeat: CropClaimHeartbeat
}): Promise<PreparedCrop[]> {
  const result: PreparedCrop[] = []
  for (const { cellIndex, pixelRect } of input.rects) {
    await input.heartbeat.fence()
    const bytes = await extractCropPng(input.sourceBytes, pixelRect, input.observer)
    const normalizedCropRect = pixelRectToNormalized(pixelRect, input.dimensions)
    const identity = sha256(Buffer.from(JSON.stringify({
      sourceMediaId: input.source.id,
      sourceStorageKey: input.source.storageKey,
      sourceChecksum: input.sourceChecksum,
      normalizedCropRect,
      artifactVersion: ARTIFACT_VERSION,
      ...(input.input.gridSpec.mode === 'four_grid' ? { gridMode: 'four_grid' } : {}),
    })))
    result.push({
      cellIndex,
      pixelRect,
      normalizedCropRect,
      outputChecksum: sha256(bytes),
      outputSize: bytes.length,
      storageKey: `users/${input.input.userId}/projects/${input.input.projectId}/six-grid-crops/${input.source.id}/${identity}.png`,
    })
    await input.heartbeat.fence()
  }
  return result
}

function resolveCropRects(
  input: GridCropSheetInput & { gridSpec: StoryboardGridSpec },
  dimensions: { width: number; height: number },
) {
  const automatic = input.gridSpec.mode === 'six_grid'
    ? computeSixGridPixelRects(dimensions)
    : computeGridPixelRects(dimensions, input.gridSpec)
  const overrides = new Map<number, PixelRect>()
  for (const override of input.manualOverrides ?? []) {
    if (overrides.has(override.cellIndex)) throw new Error('SIX_GRID_CROP_OVERRIDE_DUPLICATE')
    overrides.set(override.cellIndex, input.gridSpec.mode === 'six_grid'
      ? validateManualSixGridCrop({
          ...override,
          cellAspectRatio: input.cellAspectRatio,
          dimensions,
        })
      : validateManualGridCrop({
          ...override,
          spec: input.gridSpec,
          dimensions,
        }))
  }
  return automatic.map(({ cellIndex, ...autoRect }) => ({
    cellIndex,
    pixelRect: overrides.get(cellIndex) ?? autoRect,
  }))
}

function toArtifact(
  artifact: PreparedCrop,
  media: CropMediaRow,
  source: CropMediaRow,
  sourceChecksum: string,
  dimensions: { width: number; height: number },
): SixGridCropArtifact {
  return {
    cellIndex: artifact.cellIndex,
    mediaId: media.id,
    storageKey: media.storageKey,
    url: `/m/${encodeURIComponent(media.publicId)}`,
    pixelRect: artifact.pixelRect,
    normalizedCropRect: artifact.normalizedCropRect,
    lineage: {
      sourceMediaId: source.id,
      sourceStorageKey: source.storageKey,
      sourceDimensions: dimensions,
      sourceChecksum,
      sourceVersion: source.updatedAt.toISOString(),
      cropRect: artifact.pixelRect,
      processingStage: 'six_grid_crop',
      artifactVersion: ARTIFACT_VERSION,
      outputChecksum: artifact.outputChecksum,
      outputDimensions: { width: artifact.pixelRect.width, height: artifact.pixelRect.height },
    },
  }
}

async function findOwnedSheetMedia(input: GridCropSheetInput) {
  const storyboard = await prisma.novelPromotionStoryboard.findFirst({
    where: {
      ...(input.storyboardId ? { id: input.storyboardId } : {}),
      ...(input.expectedSheetArtifactVersion !== undefined
        ? { sheetArtifactVersion: input.expectedSheetArtifactVersion }
        : {}),
      ...(input.gridSpec ? { layoutMode: input.gridSpec.mode } : {}),
      OR: [{ sheetImageMediaId: input.sourceMediaId }, { upscaledSheetImageMediaId: input.sourceMediaId }],
      episode: { novelPromotionProject: { projectId: input.projectId, project: { userId: input.userId } } },
    },
    select: {
      id: true,
      layoutMode: true,
      sixGridCellAspectRatio: true,
      sheetArtifactVersion: true,
      sheetImageMedia: true,
      upscaledSheetImageMedia: true,
    },
  })
  if (storyboard?.sheetImageMedia?.id === input.sourceMediaId) {
    return { storyboard, media: storyboard.sheetImageMedia }
  }
  if (storyboard?.upscaledSheetImageMedia?.id === input.sourceMediaId) {
    return { storyboard, media: storyboard.upscaledSheetImageMedia }
  }
  return null
}

function resolveOwnedGridSpec(
  storyboard: { layoutMode: string; sixGridCellAspectRatio: string | null },
  input: GridCropSheetInput,
): StoryboardGridSpec {
  let canonical: StoryboardGridSpec
  try {
    canonical = resolveStoryboardGridSpec(storyboard.layoutMode, storyboard.sixGridCellAspectRatio)
  } catch {
    throw new Error('SIX_GRID_SOURCE_NOT_FOUND_OR_FORBIDDEN')
  }
  if (canonical.cellAspectRatio !== input.cellAspectRatio) {
    throw new Error('SIX_GRID_SOURCE_NOT_FOUND_OR_FORBIDDEN')
  }
  if (input.gridSpec && (input.gridSpec.mode !== canonical.mode
    || input.gridSpec.columns !== canonical.columns
    || input.gridSpec.rows !== canonical.rows
    || input.gridSpec.panelCount !== canonical.panelCount
    || input.gridSpec.cellAspectRatio !== canonical.cellAspectRatio
    || input.gridSpec.sheetAspectRatio !== canonical.sheetAspectRatio)) {
    throw new Error('SIX_GRID_SOURCE_NOT_FOUND_OR_FORBIDDEN')
  }
  return canonical
}

async function readSourceBytes(
  storage: SixGridCropStorage,
  key: string,
  declaredSize: bigint | null,
  maxSourceBytes: number,
) {
  if (declaredSize != null && Number(declaredSize) > maxSourceBytes) {
    throw new Error('SIX_GRID_SOURCE_TOO_LARGE')
  }
  let bytes: Buffer
  try { bytes = await storage.getObjectBuffer(key) } catch { throw new Error('SIX_GRID_SOURCE_READ_FAILED') }
  if (bytes.length === 0 || bytes.length > maxSourceBytes) throw new Error('SIX_GRID_SOURCE_TOO_LARGE')
  return bytes
}

function isStableCropError(error: unknown) {
  const message = (error as Error).message ?? ''
  return message.startsWith('SIX_GRID_SOURCE_')
    || message.startsWith('SIX_GRID_CROP_IDENTITY_')
    || message === 'SIX_GRID_CROP_CLAIM_LOST'
    || message === 'SIX_GRID_CROP_EXTRACT_FAILED'
    || message.startsWith('CROP_')
    || message.startsWith('GRID_')
}

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex')
}
