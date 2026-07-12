import { createHash, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { beforeEach, describe, expect, it } from 'vitest'
import { pixelRectToNormalized } from '@/lib/novel-promotion/six-grid/crop-geometry'
import { cropSixGridSheet, type SixGridCropStorage } from '@/lib/novel-promotion/six-grid/crop-service'
import { stablePublicIdFromStorageKey } from '@/lib/media/hash'
import { resetSystemState } from '../../helpers/db-reset'
import {
  createFixtureEpisode,
  createFixtureNovelProject,
  createFixtureProject,
  createFixtureUser,
} from '../../helpers/fixtures'
import { prisma } from '../../helpers/prisma'

class TestStorage implements SixGridCropStorage {
  readonly objects = new Map<string, Buffer>()
  failUploadNumber: number | null = null
  private uploadNumber = 0
  get uploadCount() { return this.uploadNumber }

  async getObjectBuffer(key: string) {
    const bytes = this.objects.get(key)
    if (!bytes) throw new Error('missing test object')
    return Buffer.from(bytes)
  }

  async uploadObject(body: Buffer, key: string) {
    this.uploadNumber += 1
    if (this.uploadNumber === this.failUploadNumber) throw new Error('test upload failure')
    this.objects.set(key, Buffer.from(body))
    return key
  }

  async deleteObject(key: string) {
    this.objects.delete(key)
  }
}

async function createKnownSheet(width = 301, height = 201) {
  const pixels = Buffer.alloc(width * height * 3)
  const xs = [0, Math.round(width / 3), Math.round(2 * width / 3), width]
  const ys = [0, Math.round(height / 2), height]
  const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255]]
  for (let cell = 0; cell < 6; cell += 1) {
    const column = cell % 3
    const row = Math.floor(cell / 3)
    for (let y = ys[row]; y < ys[row + 1]; y += 1) {
      for (let x = xs[column]; x < xs[column + 1]; x += 1) {
        const offset = (y * width + x) * 3
        pixels[offset] = colors[cell][0]
        pixels[offset + 1] = colors[cell][1]
        pixels[offset + 2] = colors[cell][2]
      }
    }
  }
  return await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

async function seedOwnedSheet(storage: TestStorage) {
  const user = await createFixtureUser()
  const project = await createFixtureProject(user.id)
  const novelProject = await createFixtureNovelProject(project.id)
  const episode = await createFixtureEpisode(novelProject.id)
  const clip = await prisma.novelPromotionClip.create({
    data: { episodeId: episode.id, summary: 'crop fixture', content: 'six-grid sheet' },
  })
  const bytes = await createKnownSheet()
  const storageKey = `users/${user.id}/projects/${project.id}/source/${randomUUID()}.png`
  await storage.uploadObject(bytes, storageKey)
  const checksum = createHash('sha256').update(bytes).digest('hex')
  const media = await prisma.mediaObject.create({
    data: {
      publicId: stablePublicIdFromStorageKey(storageKey),
      storageKey,
      sha256: checksum,
      mimeType: 'image/png',
      sizeBytes: BigInt(bytes.length),
      width: 301,
      height: 201,
    },
  })
  const storyboard = await prisma.novelPromotionStoryboard.create({
    data: {
      episodeId: episode.id,
      clipId: clip.id,
      layoutMode: 'six_grid',
      groupSequence: 1,
      panelCount: 6,
      sheetImageMediaId: media.id,
      sheetImageUrl: `/m/${media.publicId}`,
    },
  })
  return { user, project, media, storyboard, bytes }
}

function cropInput(fixture: Awaited<ReturnType<typeof seedOwnedSheet>>) {
  return {
    userId: fixture.user.id,
    projectId: fixture.project.id,
    sourceMediaId: fixture.media.id,
    cellAspectRatio: '16:9' as const,
  }
}

describe('six-grid crop artifact service', () => {
  beforeEach(async () => {
    await resetSystemState()
    await prisma.mediaObject.deleteMany()
  })

  it('stores six exact lossless crops with verifiable geometry and lineage, without domain mutation', async () => {
    const storage = new TestStorage()
    const fixture = await seedOwnedSheet(storage)
    const storyboardBefore = await prisma.novelPromotionStoryboard.findUniqueOrThrow({ where: { id: fixture.storyboard.id } })
    const outputs = await cropSixGridSheet(cropInput(fixture), { storage })
    expect(outputs).toHaveLength(6)
    expect(outputs.map((output) => output.cellIndex)).toEqual([0, 1, 2, 3, 4, 5])
    expect(outputs.reduce((area, output) => area + output.pixelRect.width * output.pixelRect.height, 0)).toBe(301 * 201)
    for (const output of outputs) {
      const stored = storage.objects.get(output.storageKey)
      expect(stored).toBeDefined()
      const metadata = await sharp(stored).metadata()
      expect(metadata.format).toBe('png')
      expect({ width: metadata.width, height: metadata.height }).toEqual({
        width: output.pixelRect.width,
        height: output.pixelRect.height,
      })
      expect(output.lineage).toMatchObject({
        sourceMediaId: fixture.media.id,
        sourceStorageKey: fixture.media.storageKey,
        sourceDimensions: { width: 301, height: 201 },
        sourceChecksum: fixture.media.sha256,
        cropRect: output.pixelRect,
        processingStage: 'six_grid_crop',
        artifactVersion: 1,
        outputDimensions: { width: output.pixelRect.width, height: output.pixelRect.height },
      })
      expect(output.lineage.outputChecksum).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(await prisma.mediaObject.count()).toBe(7)
    expect(await prisma.novelPromotionPanel.count()).toBe(0)
    expect(await prisma.novelPromotionStoryboard.findUniqueOrThrow({ where: { id: fixture.storyboard.id } })).toEqual(storyboardBefore)
    const repeated = await cropSixGridSheet(cropInput(fixture), { storage })
    expect(repeated.map((item) => item.mediaId)).toEqual(outputs.map((item) => item.mediaId))
    expect(await prisma.mediaObject.count()).toBe(7)
  })

  it('uses a validated manual crop for one cell and keeps automatic geometry for the others', async () => {
    const storage = new TestStorage()
    const fixture = await seedOwnedSheet(storage)
    const manualRect = { x: 10, y: 10, width: 80, height: 45 }
    const outputs = await cropSixGridSheet({
      ...cropInput(fixture),
      manualOverrides: [{
        cellIndex: 0,
        normalizedCropRect: pixelRectToNormalized(manualRect, { width: 301, height: 201 }),
      }],
    }, { storage })
    expect(outputs[0].pixelRect).toEqual(manualRect)
    expect(await sharp(storage.objects.get(outputs[0].storageKey)).metadata()).toMatchObject({ width: 80, height: 45 })
    expect(outputs.slice(1).map((item) => item.pixelRect.width * item.pixelRect.height)
      .reduce((total, area) => total + area, 0)).toBe(301 * 201 - 100 * 101)
  })

  it('rejects an invalid override before writing any crop artifacts', async () => {
    const storage = new TestStorage()
    const fixture = await seedOwnedSheet(storage)
    await expect(cropSixGridSheet({
      ...cropInput(fixture),
      manualOverrides: [{
        cellIndex: 0,
        normalizedCropRect: pixelRectToNormalized(
          { x: 80, y: 10, width: 80, height: 45 },
          { width: 301, height: 201 },
        ),
      }],
    }, { storage })).rejects.toThrow('CROP_OUT_OF_CELL')
    expect(await prisma.mediaObject.count()).toBe(1)
    expect(storage.objects.size).toBe(1)
  })

  it('rejects another user even when they know the source media id', async () => {
    const storage = new TestStorage()
    const fixture = await seedOwnedSheet(storage)
    const stranger = await createFixtureUser()
    await expect(cropSixGridSheet({ ...cropInput(fixture), userId: stranger.id }, { storage }))
      .rejects.toThrow('SIX_GRID_SOURCE_NOT_FOUND_OR_FORBIDDEN')
    expect(await prisma.mediaObject.count()).toBe(1)
    expect(storage.objects.size).toBe(1)
  })

  it('rejects invalid image bytes with a stable error before creating outputs', async () => {
    const storage = new TestStorage()
    const fixture = await seedOwnedSheet(storage)
    const invalidBytes = Buffer.from('not an image')
    storage.objects.set(fixture.media.storageKey, invalidBytes)
    await prisma.mediaObject.update({
      where: { id: fixture.media.id },
      data: {
        sha256: createHash('sha256').update(invalidBytes).digest('hex'),
        sizeBytes: BigInt(invalidBytes.length),
      },
    })
    await expect(cropSixGridSheet(cropInput(fixture), { storage }))
      .rejects.toThrow('SIX_GRID_SOURCE_IMAGE_INVALID')
    expect(await prisma.mediaObject.count()).toBe(1)
    expect(storage.objects.size).toBe(1)
  })

  it('rejects declared oversize media before reading or writing crop artifacts', async () => {
    const storage = new TestStorage()
    const fixture = await seedOwnedSheet(storage)
    await prisma.mediaObject.update({
      where: { id: fixture.media.id },
      data: { sizeBytes: BigInt(50 * 1024 * 1024 + 1) },
    })
    await expect(cropSixGridSheet(cropInput(fixture), { storage }))
      .rejects.toThrow('SIX_GRID_SOURCE_TOO_LARGE')
    expect(await prisma.mediaObject.count()).toBe(1)
    expect(storage.objects.size).toBe(1)
  })

  it('fences a concurrent request and converges its retry on the same artifacts', async () => {
    const storage = new TestStorage()
    const fixture = await seedOwnedSheet(storage)
    const concurrent = await Promise.allSettled([
      cropSixGridSheet(cropInput(fixture), { storage }),
      cropSixGridSheet(cropInput(fixture), { storage }),
    ])
    const first = concurrent.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof cropSixGridSheet>>> => result.status === 'fulfilled')?.value
    expect(first).toHaveLength(6)
    if (!first) throw new Error('expected one crop request to succeed')
    expect(concurrent.find((result) => result.status === 'rejected'))
      .toMatchObject({ reason: { message: 'SIX_GRID_CROP_BUSY' } })
    const retry = await cropSixGridSheet(cropInput(fixture), { storage })
    expect(retry.map((item) => item.mediaId)).toEqual(first.map((item) => item.mediaId))
    expect(new Set(first.map((item) => item.storageKey)).size).toBe(6)
    expect(await prisma.mediaObject.count()).toBe(7)
    expect(storage.objects.size).toBe(7)
  })

  it('rejects a mismatched deterministic MediaObject without overwriting its stored bytes', async () => {
    const storage = new TestStorage()
    const fixture = await seedOwnedSheet(storage)
    const initial = await cropSixGridSheet(cropInput(fixture), { storage })
    const conflicting = initial[5]
    const sentinel = Buffer.from('pre-existing unrelated bytes')
    storage.objects.set(conflicting.storageKey, sentinel)
    await prisma.mediaObject.deleteMany({ where: { id: { in: initial.slice(0, 2).map((item) => item.mediaId) } } })
    for (const item of initial.slice(0, 2)) await storage.deleteObject(item.storageKey)
    await prisma.mediaObject.update({
      where: { id: conflicting.mediaId },
      data: { sha256: 'mismatched-checksum' },
    })
    const uploadsBeforeConflict = storage.uploadCount

    await expect(cropSixGridSheet(cropInput(fixture), { storage }))
      .rejects.toThrow('SIX_GRID_CROP_IDENTITY_CONFLICT')
    expect(storage.uploadCount).toBe(uploadsBeforeConflict)
    expect(storage.objects.get(conflicting.storageKey)).toEqual(sentinel)
    expect(await prisma.mediaObject.findUniqueOrThrow({ where: { id: conflicting.mediaId } }))
      .toMatchObject({ sha256: 'mismatched-checksum' })
    expect(await prisma.mediaObject.count()).toBe(5)
  })

  it('retains deterministic partials after failure and reuses them on the next claim', async () => {
    const storage = new TestStorage()
    const fixture = await seedOwnedSheet(storage)
    storage.failUploadNumber = 4 // source upload was number 1, so the third crop fails.

    await expect(cropSixGridSheet(cropInput(fixture), { storage }))
      .rejects.toThrow('SIX_GRID_CROP_BATCH_FAILED')
    const partial = await prisma.mediaObject.findMany({
      where: { storageKey: { contains: '/six-grid-crops/' } },
      orderBy: { storageKey: 'asc' },
    })
    expect(partial).toHaveLength(3)
    expect(storage.objects.size).toBe(3) // source plus two completed crops
    expect(await prisma.novelPromotionPanel.count()).toBe(0)
    const recovered = await cropSixGridSheet(cropInput(fixture), { storage })
    expect(recovered).toHaveLength(6)
    expect(recovered.filter((item) => partial.some((row) => row.id === item.mediaId))).toHaveLength(3)
    expect(await prisma.mediaObject.count()).toBe(7)
    expect(storage.objects.size).toBe(7)
  })
})
