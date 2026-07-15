import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  viralReplication: { updateMany: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
  userPreference: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}))
const txMock = vi.hoisted(() => ({
  mediaObject: { create: vi.fn() },
  project: { create: vi.fn() },
  novelPromotionProject: { create: vi.fn() },
  novelPromotionEpisode: { create: vi.fn() },
  viralReplication: { updateMany: vi.fn() },
}))
const probeVideoMock = vi.hoisted(() => vi.fn())
const uploadObjectStreamMock = vi.hoisted(() => vi.fn())
const deleteObjectMock = vi.hoisted(() => vi.fn())
const submitTaskMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/viral-replication/ffmpeg', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/viral-replication/ffmpeg')>()),
  probeVideo: probeVideoMock,
}))
vi.mock('@/lib/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage')>()),
  uploadObjectStream: uploadObjectStreamMock,
  deleteObject: deleteObjectMock,
}))
vi.mock('@/lib/task/submitter', () => ({ submitTask: submitTaskMock }))

function mp4Bytes(payloadBytes = 32): Buffer {
  const prefix = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
  return Buffer.concat([prefix, Buffer.alloc(payloadBytes)])
}

function videoRequest(bytes: Buffer): Request {
  return new Request('http://localhost/video', {
    method: 'PUT', headers: { 'content-type': 'video/mp4' }, body: new Uint8Array(bytes) as BodyInit,
  })
}

describe('viral replication streamed upload service', () => {
  let tempRoot: string

  beforeEach(async () => {
    vi.clearAllMocks()
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'viral-upload-test-'))
    prismaMock.userPreference.findUnique.mockResolvedValue({
      analysisModel: 'openai::analysis-v1', characterModel: 'image::character', locationModel: 'image::location',
      storyboardModel: 'image::storyboard', editModel: 'image::edit', videoModel: 'video::v1', audioModel: 'audio::v1',
      videoRatio: '9:16', videoResolution: '720p', artStyle: 'realistic', ttsRate: '+50%', imageResolution: '2K',
    })
    prismaMock.viralReplication.findFirst.mockResolvedValue({
      id: 'rep-1', userId: 'user-1', status: 'uploading', videoRatio: '16:9', artStyle: 'japanese-anime',
      brief: '原创方向', reportJson: null, reportVersion: 1, errorMessage: null, durationMs: null,
      confirmedAt: null, createdAt: new Date(), updatedAt: new Date(), project: null, episode: null, sourceVideoMedia: null,
    })
    prismaMock.viralReplication.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.viralReplication.update.mockResolvedValue({ id: 'rep-1', status: 'failed' })
    probeVideoMock.mockResolvedValue({
      durationMs: 30_000, formatName: 'mov,mp4,m4a,3gp,3g2,mj2', majorBrand: 'isom',
      videoStreamIndex: 0, width: 1080, height: 1920, hasVideo: true, hasAudio: false, hasSubtitles: false,
      videoStreams: [], audioStreams: [], subtitleStreams: [],
    })
    uploadObjectStreamMock.mockResolvedValue('viral-replications/rep-1/source.mp4')
    txMock.mediaObject.create.mockResolvedValue({ id: 'media-1' })
    txMock.project.create.mockResolvedValue({ id: 'project-1' })
    txMock.novelPromotionProject.create.mockResolvedValue({ id: 'novel-1' })
    txMock.novelPromotionEpisode.create.mockResolvedValue({ id: 'episode-1' })
    txMock.viralReplication.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof txMock) => unknown) => callback(txMock))
    submitTaskMock.mockResolvedValue({ taskId: 'task-1', success: true })
  })

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('cuts off an over-limit request before probing, storage, or project creation', async () => {
    const { uploadViralReplicationVideo } = await import('@/lib/viral-replication/service')
    await expect(uploadViralReplicationVideo({
      id: 'rep-1', userId: 'user-1', request: videoRequest(mp4Bytes(64)), mimeType: 'video/mp4', locale: 'zh', maxBytes: 20, tempRoot,
    })).rejects.toMatchObject({ code: 'INVALID_PARAMS', details: { code: 'VIRAL_VIDEO_TOO_LARGE', field: 'video' } })
    expect(probeVideoMock).not.toHaveBeenCalled()
    expect(uploadObjectStreamMock).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(txMock.project.create).not.toHaveBeenCalled()
    expect(txMock.novelPromotionEpisode.create).not.toHaveBeenCalled()
    expect(await fs.readdir(tempRoot)).toEqual([])
  })

  it('creates no project, episode, media, or task when FFprobe validation fails', async () => {
    probeVideoMock.mockResolvedValueOnce({
      durationMs: 5_000, formatName: 'mov,mp4', majorBrand: 'isom', videoStreamIndex: 0, width: 100, height: 100,
      hasVideo: true, hasAudio: false, hasSubtitles: false,
      videoStreams: [], audioStreams: [], subtitleStreams: [],
    })
    const { uploadViralReplicationVideo } = await import('@/lib/viral-replication/service')
    await expect(uploadViralReplicationVideo({
      id: 'rep-1', userId: 'user-1', request: videoRequest(mp4Bytes()), mimeType: 'video/mp4', locale: 'zh', tempRoot,
    })).rejects.toMatchObject({ code: 'INVALID_PARAMS', details: { code: 'INVALID_VIDEO_DURATION', field: 'video' } })
    expect(uploadObjectStreamMock).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(submitTaskMock).not.toHaveBeenCalled()
    expect(await fs.readdir(tempRoot)).toEqual([])
  })

  it('rejects a missing current analysis model before locking or creating any draft records', async () => {
    prismaMock.userPreference.findUnique.mockResolvedValueOnce({ analysisModel: null })
    const { uploadViralReplicationVideo } = await import('@/lib/viral-replication/service')
    await expect(uploadViralReplicationVideo({
      id: 'rep-1', userId: 'user-1', request: videoRequest(mp4Bytes()), mimeType: 'video/mp4', locale: 'zh', tempRoot,
    })).rejects.toBeDefined()
    expect(prismaMock.viralReplication.updateMany).not.toHaveBeenCalled()
    expect(uploadObjectStreamMock).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(submitTaskMock).not.toHaveBeenCalled()
  })

  it('creates source media, project settings, episode, and analyzing link exactly once before task submission', async () => {
    const { uploadViralReplicationVideo } = await import('@/lib/viral-replication/service')
    const result = await uploadViralReplicationVideo({
      id: 'rep-1', userId: 'user-1', request: videoRequest(mp4Bytes()), mimeType: 'video/mp4', locale: 'zh', tempRoot,
      now: new Date('2026-07-15T08:09:10.000Z'),
    })
    expect(result).toMatchObject({ status: 'analyzing', projectId: 'project-1', episodeId: 'episode-1', taskId: 'task-1' })
    expect(uploadObjectStreamMock).toHaveBeenCalledTimes(1)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(txMock.mediaObject.create).toHaveBeenCalledTimes(1)
    expect(txMock.mediaObject.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      storageKey: 'viral-replications/rep-1/source.mp4', durationMs: 30_000, width: 1080, height: 1920,
    }) })
    expect(txMock.project.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: 'user-1', name: '爆款复刻-20260715-080910' }) })
    expect(txMock.novelPromotionProject.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      projectId: 'project-1', analysisModel: 'openai::analysis-v1', videoRatio: '16:9', artStyle: 'japanese-anime',
    }) })
    expect(txMock.novelPromotionEpisode.create).toHaveBeenCalledWith({ data: { novelPromotionProjectId: 'novel-1', episodeNumber: 1, name: '第 1 集' } })
    expect(txMock.viralReplication.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'analyzing', projectId: 'project-1', episodeId: 'episode-1', sourceVideoMediaId: 'media-1', analysisModelSnapshot: 'openai::analysis-v1', durationMs: 30_000 }),
    }))
    expect(submitTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1', projectId: 'project-1', episodeId: 'episode-1', type: 'viral_video_analysis',
      targetType: 'ViralReplication', targetId: 'rep-1', maxAttempts: 1,
      payload: expect.objectContaining({ sourceVideoMediaId: 'media-1', analysisModelSnapshot: 'openai::analysis-v1' }),
    }))
    expect(await fs.readdir(tempRoot)).toEqual([])
  })

  it('deletes the stored object best-effort when the database transaction fails', async () => {
    prismaMock.$transaction.mockRejectedValueOnce(new Error('db unavailable'))
    const { uploadViralReplicationVideo } = await import('@/lib/viral-replication/service')
    await expect(uploadViralReplicationVideo({
      id: 'rep-1', userId: 'user-1', request: videoRequest(mp4Bytes()), mimeType: 'video/mp4', locale: 'zh', tempRoot,
    })).rejects.toThrow('db unavailable')
    expect(deleteObjectMock).toHaveBeenCalledWith(expect.stringMatching(/^viral-replications\/rep-1\/.+\.mp4$/))
    expect(submitTaskMock).not.toHaveBeenCalled()
  })

  it('marks the replication failed but preserves its project and source when task submission fails', async () => {
    submitTaskMock.mockRejectedValueOnce(new Error('queue unavailable'))
    const { uploadViralReplicationVideo } = await import('@/lib/viral-replication/service')
    const result = await uploadViralReplicationVideo({
      id: 'rep-1', userId: 'user-1', request: videoRequest(mp4Bytes()), mimeType: 'video/mp4', locale: 'zh', tempRoot,
    })
    expect(result).toMatchObject({ status: 'failed', projectId: 'project-1', sourceVideoMediaId: 'media-1' })
    expect(prismaMock.viralReplication.update).toHaveBeenCalledWith({
      where: { id: 'rep-1' }, data: { status: 'failed', errorMessage: expect.any(String) },
    })
    expect(deleteObjectMock).not.toHaveBeenCalled()
  })

  it('allows only one concurrent caller to acquire an uploading session', async () => {
    prismaMock.viralReplication.updateMany.mockResolvedValueOnce({ count: 0 })
    const { uploadViralReplicationVideo } = await import('@/lib/viral-replication/service')
    await expect(uploadViralReplicationVideo({
      id: 'rep-1', userId: 'user-1', request: videoRequest(mp4Bytes()), mimeType: 'video/mp4', locale: 'zh', tempRoot,
    })).rejects.toBeDefined()
    expect(probeVideoMock).not.toHaveBeenCalled()
    expect(uploadObjectStreamMock).not.toHaveBeenCalled()
  })

  it('never exposes the internal concurrency lock as a user-facing error', async () => {
    prismaMock.viralReplication.findFirst.mockResolvedValueOnce({
      id: 'rep-1', status: 'uploading', brief: '方向', videoRatio: '9:16', artStyle: 'realistic',
      reportJson: null, reportVersion: 1, errorMessage: '__viral_upload_lock__:private-token', durationMs: null,
      confirmedAt: null, createdAt: new Date(), updatedAt: new Date(), project: null, episode: null, sourceVideoMedia: null,
    })
    const { getOwnedViralReplicationDetail } = await import('@/lib/viral-replication/service')
    await expect(getOwnedViralReplicationDetail('rep-1', 'user-1')).resolves.toMatchObject({ errorMessage: null })
  })
})
