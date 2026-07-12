import { createHash } from 'node:crypto'
import { stablePublicIdFromStorageKey } from '@/lib/media/hash'
import { prisma } from '@/lib/prisma'
import type { NormalizedCropRect } from './contracts'
import type { PixelRect } from './crop-geometry'

export interface SixGridCropStorage {
  getObjectBuffer(key: string): Promise<Buffer>
  uploadObject(body: Buffer, key: string, maxRetries?: number, contentType?: string): Promise<string>
  deleteObject(key: string): Promise<void>
}

export type PreparedCrop = {
  cellIndex: number
  pixelRect: PixelRect
  normalizedCropRect: NormalizedCropRect
  outputChecksum: string
  outputSize: number
  storageKey: string
}

export type CropMediaRow = Awaited<ReturnType<typeof prisma.mediaObject.findUniqueOrThrow>>
export type ExistingCropState = { media: CropMediaRow; needsUpload: boolean }

export async function preflightExistingCropMedia(
  storage: SixGridCropStorage,
  prepared: PreparedCrop[],
  afterEach?: () => Promise<void>,
) {
  const rows = await prisma.mediaObject.findMany({
    where: { storageKey: { in: prepared.map((artifact) => artifact.storageKey) } },
  })
  const result = new Map<string, ExistingCropState>()
  const byKey = new Map(rows.map((media) => [media.storageKey, media]))
  for (const artifact of prepared) {
    const media = byKey.get(artifact.storageKey)
    if (!media) {
      await afterEach?.()
      continue
    }
    assertCropMediaIdentity(media, artifact)
    let needsUpload = false
    try {
      await afterEach?.()
      const bytes = await storage.getObjectBuffer(media.storageKey)
      await afterEach?.()
      if (bytes.length !== artifact.outputSize || sha256(bytes) !== artifact.outputChecksum) {
        throw new Error('SIX_GRID_CROP_IDENTITY_CONFLICT')
      }
    } catch (error) {
      if ((error as Error).message === 'SIX_GRID_CROP_IDENTITY_CONFLICT') throw error
      needsUpload = true
    }
    result.set(media.storageKey, { media, needsUpload })
    await afterEach?.()
  }
  return result
}

export async function createCropMedia(
  storage: SixGridCropStorage,
  artifact: PreparedCrop,
  bytes: Buffer,
  fence?: () => Promise<void>,
) {
  let media: CropMediaRow
  try {
    await fence?.()
    media = await prisma.mediaObject.create({ data: cropMediaData(artifact) })
    await fence?.()
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error
    await fence?.()
    media = await prisma.mediaObject.findUniqueOrThrow({ where: { storageKey: artifact.storageKey } })
    await fence?.()
    assertCropMediaIdentity(media, artifact)
  }
  return await uploadReservedCropMedia(storage, media, artifact, bytes, fence)
}

export async function uploadReservedCropMedia(
  storage: SixGridCropStorage,
  media: CropMediaRow,
  artifact: PreparedCrop,
  bytes: Buffer,
  fence?: () => Promise<void>,
) {
  await fence?.()
  await storage.uploadObject(bytes, artifact.storageKey, 1, 'image/png')
  await fence?.()
  return media
}

function assertCropMediaIdentity(media: CropMediaRow, artifact: PreparedCrop) {
  if (media.sha256 !== artifact.outputChecksum
    || media.mimeType !== 'image/png'
    || Number(media.sizeBytes) !== artifact.outputSize
    || media.width !== artifact.pixelRect.width
    || media.height !== artifact.pixelRect.height) {
    throw new Error('SIX_GRID_CROP_IDENTITY_CONFLICT')
  }
}

function cropMediaData(artifact: PreparedCrop) {
  return {
    publicId: stablePublicIdFromStorageKey(artifact.storageKey),
    storageKey: artifact.storageKey,
    sha256: artifact.outputChecksum,
    mimeType: 'image/png',
    sizeBytes: BigInt(artifact.outputSize),
    width: artifact.pixelRect.width,
    height: artifact.pixelRect.height,
  }
}

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex')
}
