import { createHash, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stablePublicIdFromStorageKey } from '@/lib/media/hash'
import { acquireCropClaim } from '@/lib/novel-promotion/six-grid/crop-claim'
import { cropSixGridSheet, type SixGridCropStorage } from '@/lib/novel-promotion/six-grid/crop-service'
import { resetSystemState } from '../../helpers/db-reset'
import {
  createFixtureEpisode,
  createFixtureNovelProject,
  createFixtureProject,
  createFixtureUser,
} from '../../helpers/fixtures'
import { prisma } from '../../helpers/prisma'

class ClaimTestStorage implements SixGridCropStorage {
  readonly objects: Map<string, Buffer>
  uploads = 0
  onUpload?: (key: string) => Promise<void>

  constructor(objects = new Map<string, Buffer>()) { this.objects = objects }

  async getObjectBuffer(key: string) {
    const bytes = this.objects.get(key)
    if (!bytes) throw new Error('missing')
    return Buffer.from(bytes)
  }

  async uploadObject(body: Buffer, key: string) {
    this.uploads += 1
    if (this.onUpload) await this.onUpload(key)
    this.objects.set(key, Buffer.from(body))
    return key
  }

  async deleteObject(key: string) { this.objects.delete(key) }
}

async function seedSource(storage: ClaimTestStorage, options?: {
  bytes?: Buffer
  mimeType?: string
  sha256?: string | null
}) {
  const user = await createFixtureUser()
  const project = await createFixtureProject(user.id)
  const novelProject = await createFixtureNovelProject(project.id)
  const episode = await createFixtureEpisode(novelProject.id)
  const clip = await prisma.novelPromotionClip.create({
    data: { episodeId: episode.id, summary: 'claim fixture', content: 'crop claim' },
  })
  const bytes = options?.bytes ?? await sharp({
    create: { width: 301, height: 201, channels: 3, background: '#336699' },
  }).png().toBuffer()
  const metadata = await sharp(bytes).metadata()
  const storageKey = `users/${user.id}/projects/${project.id}/source/${randomUUID()}`
  await storage.uploadObject(bytes, storageKey)
  const media = await prisma.mediaObject.create({
    data: {
      publicId: stablePublicIdFromStorageKey(storageKey),
      storageKey,
      sha256: options?.sha256 === undefined
        ? createHash('sha256').update(bytes).digest('hex')
        : options.sha256,
      mimeType: options?.mimeType ?? `image/${metadata.format}`,
      sizeBytes: BigInt(bytes.length),
      width: metadata.width,
      height: metadata.height,
    },
  })
  await prisma.novelPromotionStoryboard.create({
    data: {
      episodeId: episode.id,
      clipId: clip.id,
      layoutMode: 'six_grid',
      groupSequence: 1,
      panelCount: 6,
      sheetImageMediaId: media.id,
    },
  })
  return { user, project, media, bytes }
}

function input(fixture: Awaited<ReturnType<typeof seedSource>>) {
  return {
    userId: fixture.user.id,
    projectId: fixture.project.id,
    sourceMediaId: fixture.media.id,
    cellAspectRatio: '16:9' as const,
  }
}

describe('six-grid crop durable claims and image safety', () => {
  beforeEach(async () => {
    await resetSystemState()
    await prisma.mediaObject.deleteMany()
    await prisma.sixGridCropClaim.deleteMany()
  })

  it('rejects an active durable claim without writing outputs', async () => {
    const storage = new ClaimTestStorage()
    const fixture = await seedSource(storage)
    await prisma.sixGridCropClaim.create({
      data: {
        claimKey: `six-grid-crop:${fixture.media.id}:v1`,
        ownerToken: randomUUID(),
        leaseUntil: new Date(Date.now() + 60_000),
      },
    })

    await expect(cropSixGridSheet(input(fixture), { storage }))
      .rejects.toThrow('SIX_GRID_CROP_BUSY')
    expect(storage.uploads).toBe(1)
    expect(await prisma.mediaObject.count()).toBe(1)
  })

  it('uses database time so an application clock far in the future cannot steal an active claim', async () => {
    const sourceMediaId = randomUUID()
    await prisma.sixGridCropClaim.create({
      data: {
        claimKey: `six-grid-crop:${sourceMediaId}:v1`,
        ownerToken: 'db-clock-owner',
        leaseUntil: new Date(Date.now() + 60_000),
      },
    })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2099-01-01T00:00:00.000Z'))
    try {
      await expect(acquireCropClaim({ sourceMediaId })).rejects.toThrow('SIX_GRID_CROP_BUSY')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a source whose declared sha does not match its owned bytes with zero output writes', async () => {
    const storage = new ClaimTestStorage()
    const fixture = await seedSource(storage, { sha256: '0'.repeat(64) })

    await expect(cropSixGridSheet(input(fixture), { storage }))
      .rejects.toThrow('SIX_GRID_SOURCE_IDENTITY_MISMATCH')
    expect(storage.uploads).toBe(1)
    expect(await prisma.mediaObject.count()).toBe(1)
  })

  it('allows a legacy source without declared sha and records the computed checksum in lineage', async () => {
    const storage = new ClaimTestStorage()
    const fixture = await seedSource(storage, { sha256: null })

    const outputs = await cropSixGridSheet(input(fixture), { storage })
    const checksum = createHash('sha256').update(fixture.bytes).digest('hex')
    expect(outputs.every((output) => output.lineage.sourceChecksum === checksum)).toBe(true)
    expect((await prisma.mediaObject.findUniqueOrThrow({ where: { id: fixture.media.id } })).sha256).toBeNull()
  })

  it('rejects a reused output whose declared size differs from stored bytes', async () => {
    const storage = new ClaimTestStorage()
    const fixture = await seedSource(storage)
    const outputs = await cropSixGridSheet(input(fixture), { storage })
    const uploadsBefore = storage.uploads
    await prisma.mediaObject.update({
      where: { id: outputs[0].mediaId },
      data: { sizeBytes: BigInt((storage.objects.get(outputs[0].storageKey)?.length ?? 0) + 1) },
    })

    await expect(cropSixGridSheet(input(fixture), { storage }))
      .rejects.toThrow('SIX_GRID_CROP_IDENTITY_CONFLICT')
    expect(storage.uploads).toBe(uploadsBefore)
  })

  it('rejects JPEG EXIF orientation before creating outputs', async () => {
    const storage = new ClaimTestStorage()
    const jpeg = await sharp({
      create: { width: 301, height: 201, channels: 3, background: '#884422' },
    }).jpeg().withMetadata({ orientation: 6 }).toBuffer()
    const fixture = await seedSource(storage, { bytes: jpeg, mimeType: 'image/jpeg' })

    await expect(cropSixGridSheet(input(fixture), { storage }))
      .rejects.toThrow('SIX_GRID_SOURCE_IMAGE_INVALID')
    expect(storage.uploads).toBe(1)
  })

  it('runs no more than one Sharp pipeline at a time', async () => {
    const storage = new ClaimTestStorage()
    const fixture = await seedSource(storage)
    let active = 0
    let maximum = 0
    const onSharpPipelineActivity = (delta: 1 | -1) => {
      active += delta
      maximum = Math.max(maximum, active)
    }

    await cropSixGridSheet(input(fixture), { storage, onSharpPipelineActivity } as never)
    expect(maximum).toBe(1)
    expect(active).toBe(0)
  })

  it('rejects an invalid cell ratio even when no manual crop is present', async () => {
    const storage = new ClaimTestStorage()
    const fixture = await seedSource(storage)

    await expect(cropSixGridSheet({ ...input(fixture), cellAspectRatio: '1:1' as never }, { storage }))
      .rejects.toThrow('CROP_ASPECT_RATIO_INVALID')
    expect(storage.uploads).toBe(1)
  })

  it('lets only one independent service instance write while the other sees a busy claim', async () => {
    const firstStorage = new ClaimTestStorage()
    const fixture = await seedSource(firstStorage)
    const secondStorage = new ClaimTestStorage(firstStorage.objects)
    firstStorage.onUpload = async (key) => {
      if (key.includes('/six-grid-crops/')) await new Promise((resolve) => setTimeout(resolve, 30))
    }

    const results = await Promise.allSettled([
      cropSixGridSheet(input(fixture), { storage: firstStorage }),
      cropSixGridSheet(input(fixture), { storage: secondStorage }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')
      .map((result) => (result as PromiseRejectedResult).reason.message)).toEqual(['SIX_GRID_CROP_BUSY'])
    expect(await prisma.mediaObject.count()).toBe(7)
    expect(firstStorage.objects.size).toBe(7)
  })

  it('keeps a short lease alive while one storage operation exceeds the lease duration', async () => {
    const firstStorage = new ClaimTestStorage()
    const fixture = await seedSource(firstStorage)
    const secondStorage = new ClaimTestStorage(firstStorage.objects)
    let signalSlowUpload = () => {}
    const slowUploadStarted = new Promise<void>((resolve) => { signalSlowUpload = resolve })
    let delayed = false
    firstStorage.onUpload = async (key) => {
      if (!delayed && key.includes('/six-grid-crops/')) {
        delayed = true
        signalSlowUpload()
        await new Promise((resolve) => setTimeout(resolve, 650))
      }
    }

    const first = cropSixGridSheet(input(fixture), { storage: firstStorage, claimLeaseMs: 300 })
    const firstSettled = first.then(
      (value) => ({ value, error: null }),
      (error: Error) => ({ value: null, error }),
    )
    await Promise.race([
      slowUploadStarted,
      new Promise((resolve) => setTimeout(resolve, 100)),
    ])
    await new Promise((resolve) => setTimeout(resolve, 400))
    await expect(cropSixGridSheet(input(fixture), { storage: secondStorage, claimLeaseMs: 300 }))
      .rejects.toThrow('SIX_GRID_CROP_BUSY')
    const outcome = await firstSettled
    if (outcome.error) throw outcome.error
    expect(outcome.value).toHaveLength(6)
  })

  it('takes over an expired claim and completes deterministic partial artifacts', async () => {
    const storage = new ClaimTestStorage()
    const fixture = await seedSource(storage)
    const outputs = await cropSixGridSheet(input(fixture), { storage })
    await prisma.mediaObject.deleteMany({ where: { id: { in: outputs.slice(2).map((item) => item.mediaId) } } })
    for (const item of outputs.slice(2)) await storage.deleteObject(item.storageKey)
    await prisma.sixGridCropClaim.create({
      data: {
        claimKey: `six-grid-crop:${fixture.media.id}:v1`,
        ownerToken: 'crashed-owner',
        leaseUntil: new Date(Date.now() - 1_000),
      },
    })

    const recovered = await cropSixGridSheet(input(fixture), { storage })
    expect(recovered).toHaveLength(6)
    expect(recovered.slice(0, 2).map((item) => item.mediaId)).toEqual(outputs.slice(0, 2).map((item) => item.mediaId))
    expect(await prisma.mediaObject.count()).toBe(7)
    expect(storage.objects.size).toBe(7)
    expect(await prisma.sixGridCropClaim.count()).toBe(0)
  })

  it('does not compensate another owner after losing its claim and later recovers the reservation', async () => {
    const storage = new ClaimTestStorage()
    const fixture = await seedSource(storage)
    let stolen = false
    storage.onUpload = async (key) => {
      if (!stolen && key.includes('/six-grid-crops/')) {
        stolen = true
        await prisma.sixGridCropClaim.update({
          where: { claimKey: `six-grid-crop:${fixture.media.id}:v1` },
          data: { ownerToken: 'new-owner', leaseUntil: new Date(Date.now() + 60_000) },
        })
      }
    }

    await expect(cropSixGridSheet(input(fixture), { storage }))
      .rejects.toThrow('SIX_GRID_CROP_CLAIM_LOST')
    expect(await prisma.mediaObject.count()).toBe(2)
    expect(storage.objects.size).toBe(2)
    expect(await prisma.sixGridCropClaim.findUniqueOrThrow({
      where: { claimKey: `six-grid-crop:${fixture.media.id}:v1` },
    })).toMatchObject({ ownerToken: 'new-owner' })

    storage.onUpload = undefined
    await prisma.sixGridCropClaim.updateMany({ data: { leaseUntil: new Date(Date.now() - 1_000) } })
    await expect(cropSixGridSheet(input(fixture), { storage })).resolves.toHaveLength(6)
    expect(await prisma.mediaObject.count()).toBe(7)
    expect(storage.objects.size).toBe(7)
  })
})
