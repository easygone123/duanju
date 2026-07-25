import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../../helpers/prisma'

const probeVideoMock = vi.hoisted(() => vi.fn())
const extractSourceAudioMock = vi.hoisted(() => vi.fn())
const uploadObjectStreamMock = vi.hoisted(() => vi.fn())
const deleteObjectMock = vi.hoisted(() => vi.fn())
const submitTaskMock = vi.hoisted(() => vi.fn())
const storageState = vi.hoisted(() => ({ key: '' }))

vi.mock('@/lib/viral-replication/ffmpeg', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/viral-replication/ffmpeg')>()),
  probeVideo: probeVideoMock,
  extractSourceAudio: extractSourceAudioMock,
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

describe('viral replication streamed upload with real database', () => {
  let tempRoot: string
  let userId: string
  let replicationId: string
  let storagePrefix: string

  async function artifactCounts() {
    return {
      projects: await prisma.project.count({ where: { userId } }),
      episodes: await prisma.novelPromotionEpisode.count({
        where: { novelPromotionProject: { project: { userId } } },
      }),
      media: await prisma.mediaObject.count({ where: { storageKey: { startsWith: storagePrefix } } }),
    }
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    const suffix = randomUUID().slice(0, 8)
    storagePrefix = `viral-test/${suffix}/`
    storageState.key = `${storagePrefix}source.mp4`
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'viral-upload-db-test-'))
    const user = await prisma.user.create({ data: { name: `viral_upload_${suffix}` } })
    userId = user.id
    await prisma.userPreference.create({
      data: {
        userId,
        analysisModel: 'openai::analysis-v1',
        characterModel: 'image::character',
        locationModel: 'image::location',
        storyboardModel: 'image::storyboard',
        editModel: 'image::edit',
        videoModel: 'video::v1',
        audioModel: 'audio::v1',
        videoRatio: '9:16',
        videoResolution: '720p',
        artStyle: 'realistic',
        ttsRate: '+50%',
        imageResolution: '2K',
      },
    })
    const replication = await prisma.viralReplication.create({
      data: {
        userId,
        brief: '原创方向',
        videoRatio: '16:9',
        artStyle: 'japanese-anime',
        storyboardGenerationMode: 'six_grid',
        status: 'uploading',
      },
    })
    replicationId = replication.id
    probeVideoMock.mockResolvedValue({
      durationMs: 30_000, formatName: 'mov,mp4,m4a,3gp,3g2,mj2', majorBrand: 'isom',
      videoStreamIndex: 0, width: 1080, height: 1920, hasVideo: true, hasAudio: false, hasSubtitles: false,
      videoStreams: [], audioStreams: [], subtitleStreams: [],
    })
    uploadObjectStreamMock.mockImplementation(async () => storageState.key)
    submitTaskMock.mockResolvedValue({ taskId: `task-${suffix}`, success: true })
  })

  afterEach(async () => {
    await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.mediaObject.deleteMany({ where: { storageKey: { startsWith: storagePrefix } } })
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('cuts off an over-limit request and persists zero project, episode, or media rows', async () => {
    const { uploadViralReplicationVideo } = await import('@/lib/viral-replication/service')
    await expect(uploadViralReplicationVideo({
      id: replicationId, userId, request: videoRequest(mp4Bytes(64)), mimeType: 'video/mp4', locale: 'zh',
      maxBytes: 20, tempRoot,
    })).rejects.toMatchObject({ code: 'INVALID_PARAMS', details: { code: 'VIRAL_VIDEO_TOO_LARGE' } })
    expect(probeVideoMock).not.toHaveBeenCalled()
    expect(uploadObjectStreamMock).not.toHaveBeenCalled()
    expect(submitTaskMock).not.toHaveBeenCalled()
    expect(await artifactCounts()).toEqual({ projects: 0, episodes: 0, media: 0 })
    expect(await prisma.viralReplication.findUnique({ where: { id: replicationId } })).toMatchObject({
      status: 'uploading', errorMessage: null, projectId: null, episodeId: null, sourceVideoMediaId: null,
    })
    expect(await fs.readdir(tempRoot)).toEqual([])
  })

  it('persists zero project, episode, or media rows when FFprobe validation fails', async () => {
    probeVideoMock.mockResolvedValueOnce({
      durationMs: 5_000, formatName: 'mov,mp4', majorBrand: 'isom', videoStreamIndex: 0, width: 100, height: 100,
      hasVideo: true, hasAudio: false, hasSubtitles: false, videoStreams: [], audioStreams: [], subtitleStreams: [],
    })
    const { uploadViralReplicationVideo } = await import('@/lib/viral-replication/service')
    await expect(uploadViralReplicationVideo({
      id: replicationId, userId, request: videoRequest(mp4Bytes()), mimeType: 'video/mp4', locale: 'zh', tempRoot,
    })).rejects.toMatchObject({ code: 'INVALID_PARAMS', details: { code: 'INVALID_VIDEO_DURATION' } })
    expect(uploadObjectStreamMock).not.toHaveBeenCalled()
    expect(submitTaskMock).not.toHaveBeenCalled()
    expect(await artifactCounts()).toEqual({ projects: 0, episodes: 0, media: 0 })
    expect(await fs.readdir(tempRoot)).toEqual([])
  })

  it('rejects a missing current analysis model before creating draft records', async () => {
    await prisma.userPreference.update({ where: { userId }, data: { analysisModel: null } })
    const { uploadViralReplicationVideo } = await import('@/lib/viral-replication/service')
    await expect(uploadViralReplicationVideo({
      id: replicationId, userId, request: videoRequest(mp4Bytes()), mimeType: 'video/mp4', locale: 'zh', tempRoot,
    })).rejects.toMatchObject({ code: 'INVALID_PARAMS', details: { code: 'ANALYSIS_MODEL_REQUIRED' } })
    expect(uploadObjectStreamMock).not.toHaveBeenCalled()
    expect(submitTaskMock).not.toHaveBeenCalled()
    expect(await artifactCounts()).toEqual({ projects: 0, episodes: 0, media: 0 })
  })

  it('persists every source and draft relation exactly once before submitting analysis', async () => {
    const { uploadViralReplicationVideo } = await import('@/lib/viral-replication/service')
    const result = await uploadViralReplicationVideo({
      id: replicationId, userId, request: videoRequest(mp4Bytes()), mimeType: 'video/mp4', locale: 'zh', tempRoot,
      now: new Date('2026-07-15T08:09:10.000Z'),
    })
    expect(result).toMatchObject({ id: replicationId, status: 'analyzing', taskId: expect.any(String) })
    expect(await artifactCounts()).toEqual({ projects: 1, episodes: 1, media: 1 })

    const persisted = await prisma.viralReplication.findUnique({
      where: { id: replicationId },
      include: { project: { include: { novelPromotionData: { include: { episodes: true } } } }, episode: true, sourceVideoMedia: true },
    })
    expect(persisted).toMatchObject({
      status: 'analyzing', analysisModelSnapshot: 'openai::analysis-v1', durationMs: 30_000,
      project: {
        id: result.projectId,
        name: '爆款复刻-20260715-080910',
        novelPromotionData: {
          analysisModel: 'openai::analysis-v1',
          videoRatio: '16:9',
          artStyle: 'japanese-anime',
          storyboardGenerationMode: 'six_grid',
          episodes: [{ id: result.episodeId, episodeNumber: 1, name: '第 1 集' }],
        },
      },
      episode: { id: result.episodeId },
      sourceVideoMedia: {
        id: result.sourceVideoMediaId, storageKey: storageState.key, mimeType: 'video/mp4',
        sizeBytes: BigInt(mp4Bytes().length), width: 1080, height: 1920, durationMs: 30_000,
      },
    })
    expect(submitTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      userId, projectId: result.projectId, episodeId: result.episodeId,
      type: 'viral_video_analysis', targetType: 'ViralReplication', targetId: replicationId, maxAttempts: 1,
      payload: { sourceVideoMediaId: result.sourceVideoMediaId, analysisModelSnapshot: 'openai::analysis-v1' },
    }))
    expect(await fs.readdir(tempRoot)).toEqual([])
  })

  it('extracts embedded audio into an owned episode audio asset', async () => {
    probeVideoMock.mockResolvedValueOnce({
      durationMs: 30_000, formatName: 'mov,mp4,m4a,3gp,3g2,mj2', majorBrand: 'isom',
      videoStreamIndex: 0, width: 1080, height: 1920, hasVideo: true, hasAudio: true, hasSubtitles: false,
      videoStreams: [], audioStreams: [{ index: 1, codecName: 'aac', channels: 2, sampleRate: 48_000 }],
      subtitleStreams: [],
    })
    extractSourceAudioMock.mockImplementationOnce(async (_sourcePath: string, outputPath: string) => {
      await fs.writeFile(outputPath, 'director source audio')
    })
    uploadObjectStreamMock.mockImplementation(async (
      _streamFactory: unknown,
      requestedKey: string,
    ) => requestedKey.endsWith('.mp3') ? `${storagePrefix}source.mp3` : storageState.key)

    const { uploadViralReplicationVideo } = await import('@/lib/viral-replication/service')
    const result = await uploadViralReplicationVideo({
      id: replicationId, userId, request: videoRequest(mp4Bytes()), mimeType: 'video/mp4', locale: 'zh', tempRoot,
    })

    expect(result).toMatchObject({
      sourceVideoMediaId: expect.any(String),
      sourceAudioMediaId: expect.any(String),
    })
    const episode = await prisma.novelPromotionEpisode.findUniqueOrThrow({
      where: { id: result.episodeId },
      include: { audioMedia: true },
    })
    expect(episode.audioMedia).toMatchObject({
      id: result.sourceAudioMediaId,
      storageKey: `${storagePrefix}source.mp3`,
      mimeType: 'audio/mpeg',
      durationMs: 30_000,
    })
    expect(episode.audioMediaId).not.toBe(result.sourceVideoMediaId)
    expect(extractSourceAudioMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('source-audio.mp3'),
      1,
    )
    expect(await artifactCounts()).toEqual({ projects: 1, episodes: 1, media: 2 })
    expect(await fs.readdir(tempRoot)).toEqual([])
  })

  it('compensates storage and rolls back every database row when the transaction fails', async () => {
    storageState.key = `${storagePrefix}${'x'.repeat(600)}`
    const { uploadViralReplicationVideo } = await import('@/lib/viral-replication/service')
    await expect(uploadViralReplicationVideo({
      id: replicationId, userId, request: videoRequest(mp4Bytes()), mimeType: 'video/mp4', locale: 'zh', tempRoot,
    })).rejects.toBeDefined()
    expect(deleteObjectMock).toHaveBeenCalledWith(storageState.key)
    expect(submitTaskMock).not.toHaveBeenCalled()
    expect(await artifactCounts()).toEqual({ projects: 0, episodes: 0, media: 0 })
    expect(await prisma.viralReplication.findUnique({ where: { id: replicationId } })).toMatchObject({
      status: 'uploading', errorMessage: null, projectId: null, episodeId: null, sourceVideoMediaId: null,
    })
  })

  it('compensates the requested storage key when upload partially succeeds and then throws', async () => {
    let requestedStorageKey = ''
    uploadObjectStreamMock.mockImplementationOnce(async (_streamFactory, key: string) => {
      requestedStorageKey = key
      throw new Error('connection reset after object write')
    })
    const { uploadViralReplicationVideo } = await import('@/lib/viral-replication/service')
    await expect(uploadViralReplicationVideo({
      id: replicationId, userId, request: videoRequest(mp4Bytes()), mimeType: 'video/mp4', locale: 'zh', tempRoot,
    })).rejects.toThrow('connection reset after object write')
    expect(requestedStorageKey).toMatch(new RegExp(`^viral-replications/${replicationId}/.+\\.mp4$`))
    expect(deleteObjectMock).toHaveBeenCalledWith(requestedStorageKey)
    expect(submitTaskMock).not.toHaveBeenCalled()
    expect(await artifactCounts()).toEqual({ projects: 0, episodes: 0, media: 0 })
    expect(await prisma.viralReplication.findUnique({ where: { id: replicationId } })).toMatchObject({
      status: 'uploading', uploadLockToken: null, uploadLockExpiresAt: null,
      projectId: null, episodeId: null, sourceVideoMediaId: null,
    })
  })

  it('rolls back and compensates when the transaction-local analysis model disappears', async () => {
    uploadObjectStreamMock.mockImplementationOnce(async () => {
      await prisma.userPreference.update({ where: { userId }, data: { analysisModel: null } })
      return storageState.key
    })
    const { uploadViralReplicationVideo } = await import('@/lib/viral-replication/service')
    await expect(uploadViralReplicationVideo({
      id: replicationId, userId, request: videoRequest(mp4Bytes()), mimeType: 'video/mp4', locale: 'zh', tempRoot,
    })).rejects.toMatchObject({ code: 'INVALID_PARAMS', details: { code: 'ANALYSIS_MODEL_REQUIRED' } })
    expect(deleteObjectMock).toHaveBeenCalledWith(storageState.key)
    expect(submitTaskMock).not.toHaveBeenCalled()
    expect(await artifactCounts()).toEqual({ projects: 0, episodes: 0, media: 0 })
  })

  it('uses the transaction-local model snapshot consistently when the preference changes', async () => {
    uploadObjectStreamMock.mockImplementationOnce(async () => {
      await prisma.userPreference.update({ where: { userId }, data: { analysisModel: 'openai::analysis-v2' } })
      return storageState.key
    })
    const { uploadViralReplicationVideo } = await import('@/lib/viral-replication/service')
    const result = await uploadViralReplicationVideo({
      id: replicationId, userId, request: videoRequest(mp4Bytes()), mimeType: 'video/mp4', locale: 'zh', tempRoot,
    })
    const persisted = await prisma.viralReplication.findUnique({
      where: { id: replicationId }, include: { project: { include: { novelPromotionData: true } } },
    })
    expect(persisted).toMatchObject({
      analysisModelSnapshot: 'openai::analysis-v2',
      project: { novelPromotionData: { analysisModel: 'openai::analysis-v2' } },
    })
    expect(submitTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: { sourceVideoMediaId: result.sourceVideoMediaId, analysisModelSnapshot: 'openai::analysis-v2' },
    }))
  })

  it('keeps the persisted project and source but marks failed when submission fails', async () => {
    submitTaskMock.mockRejectedValueOnce(new Error('queue unavailable'))
    const { uploadViralReplicationVideo } = await import('@/lib/viral-replication/service')
    const result = await uploadViralReplicationVideo({
      id: replicationId, userId, request: videoRequest(mp4Bytes()), mimeType: 'video/mp4', locale: 'zh', tempRoot,
    })
    expect(result).toMatchObject({ status: 'failed', projectId: expect.any(String), sourceVideoMediaId: expect.any(String) })
    expect(await artifactCounts()).toEqual({ projects: 1, episodes: 1, media: 1 })
    expect(await prisma.viralReplication.findUnique({ where: { id: replicationId } })).toMatchObject({
      status: 'failed', projectId: result.projectId, episodeId: result.episodeId,
      sourceVideoMediaId: result.sourceVideoMediaId, errorMessage: expect.any(String),
    })
    expect(deleteObjectMock).not.toHaveBeenCalled()
  })

  it('retries only the failed analysis while reusing the source and clearing stale report frames', async () => {
    const { uploadViralReplicationVideo, retryViralReplication } = await import('@/lib/viral-replication/service')
    const uploaded = await uploadViralReplicationVideo({
      id: replicationId, userId, request: videoRequest(mp4Bytes()), mimeType: 'video/mp4', locale: 'zh', tempRoot,
    })
    await prisma.viralReplicationFrame.create({
      data: {
        replicationId,
        mediaId: uploaded.sourceVideoMediaId,
        shotIndex: 0,
        timestampMs: 1_000,
        startMs: 0,
        endMs: 2_000,
      },
    })
    await prisma.viralReplication.update({
      where: { id: replicationId },
      data: {
        status: 'failed',
        reportJson: { stale: true },
        transcriptText: 'stale transcript',
        errorMessage: 'stale failure',
      },
    })
    await prisma.userPreference.update({
      where: { userId },
      data: { analysisModel: 'openai::analysis-v2' },
    })
    submitTaskMock.mockClear()

    const retried = await retryViralReplication({ id: replicationId, userId, locale: 'zh' })

    expect(retried).toMatchObject({ id: replicationId, status: 'analyzing', taskId: expect.any(String) })
    expect(await prisma.viralReplicationFrame.count({ where: { replicationId } })).toBe(0)
    expect(await prisma.viralReplication.findUniqueOrThrow({ where: { id: replicationId } })).toMatchObject({
      projectId: uploaded.projectId,
      episodeId: uploaded.episodeId,
      sourceVideoMediaId: uploaded.sourceVideoMediaId,
      status: 'analyzing',
      analysisModelSnapshot: 'openai::analysis-v2',
      reportJson: null,
      transcriptText: null,
      errorMessage: null,
    })
    expect(submitTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'viral_video_analysis',
      maxAttempts: 1,
      dedupeKey: `viral_video_analysis:${replicationId}`,
      payload: {
        sourceVideoMediaId: uploaded.sourceVideoMediaId,
        analysisModelSnapshot: 'openai::analysis-v2',
      },
    }))
  })

  it('retries failed storyboard generation without clearing or repeating video analysis', async () => {
    const { uploadViralReplicationVideo, retryViralReplication } = await import('@/lib/viral-replication/service')
    const uploaded = await uploadViralReplicationVideo({
      id: replicationId, userId, request: videoRequest(mp4Bytes()), mimeType: 'video/mp4', locale: 'zh', tempRoot,
    })
    const reportJson = { schemaVersion: 1, overview: { hook: 'kept' } }
    await prisma.viralReplicationFrame.create({
      data: {
        replicationId,
        mediaId: uploaded.sourceVideoMediaId,
        shotIndex: 0,
        timestampMs: 1_000,
        startMs: 0,
        endMs: 2_000,
      },
    })
    await prisma.viralReplication.update({
      where: { id: replicationId },
      data: {
        status: 'failed',
        reportJson,
        transcriptText: 'keep transcript',
        errorMessage: 'VIRAL_STORYBOARD_GENERATION_FAILED',
      },
    })
    await prisma.userPreference.update({
      where: { userId },
      data: { analysisModel: 'openai::generation-v2' },
    })
    submitTaskMock.mockClear()

    const retried = await retryViralReplication({ id: replicationId, userId, locale: 'zh' })

    expect(retried).toMatchObject({ id: replicationId, status: 'generating', taskId: expect.any(String) })
    expect(await prisma.viralReplicationFrame.count({ where: { replicationId } })).toBe(1)
    expect(await prisma.viralReplication.findUniqueOrThrow({ where: { id: replicationId } })).toMatchObject({
      status: 'generating',
      analysisModelSnapshot: 'openai::generation-v2',
      reportJson,
      transcriptText: 'keep transcript',
      errorMessage: null,
    })
    expect(submitTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'viral_storyboard_generation',
      maxAttempts: 1,
      dedupeKey: `viral_storyboard_generation:${replicationId}`,
      payload: { analysisModelSnapshot: 'openai::generation-v2' },
    }))
    expect(submitTaskMock).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'viral_video_analysis',
    }))
  })

  it('atomically confirms the latest brief and queues one pinned generation task', async () => {
    const { uploadViralReplicationVideo, generateViralReplication } = await import('@/lib/viral-replication/service')
    const uploaded = await uploadViralReplicationVideo({
      id: replicationId, userId, request: videoRequest(mp4Bytes()), mimeType: 'video/mp4', locale: 'zh', tempRoot,
    })
    await prisma.viralReplication.update({
      where: { id: replicationId },
      data: { status: 'review_ready', reportJson: { schemaVersion: 1 } },
    })
    await prisma.userPreference.update({
      where: { userId },
      data: { analysisModel: 'openai::generation-v2' },
    })
    submitTaskMock.mockClear()

    const generated = await generateViralReplication({
      id: replicationId,
      userId,
      locale: 'zh',
      brief: '最新原创方向',
    })

    expect(generated).toMatchObject({ id: replicationId, status: 'generating', taskId: expect.any(String) })
    expect(await prisma.viralReplication.findUniqueOrThrow({ where: { id: replicationId } })).toMatchObject({
      projectId: uploaded.projectId,
      episodeId: uploaded.episodeId,
      status: 'generating',
      brief: '最新原创方向',
      analysisModelSnapshot: 'openai::generation-v2',
      confirmedAt: expect.any(Date),
      errorMessage: null,
    })
    expect(submitTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'viral_storyboard_generation',
      maxAttempts: 1,
      dedupeKey: `viral_storyboard_generation:${replicationId}`,
      payload: { analysisModelSnapshot: 'openai::generation-v2' },
    }))
  })

  it('reports a normalized conflict while another upload lock is active', async () => {
    const now = new Date('2026-07-15T09:00:00.000Z')
    await prisma.viralReplication.update({
      where: { id: replicationId },
      data: { uploadLockToken: 'existing', uploadLockExpiresAt: new Date(now.getTime() + 60_000) },
    })
    const { uploadViralReplicationVideo } = await import('@/lib/viral-replication/service')
    await expect(uploadViralReplicationVideo({
      id: replicationId, userId, request: videoRequest(mp4Bytes()), mimeType: 'video/mp4', locale: 'zh', tempRoot, now,
    })).rejects.toMatchObject({ code: 'INVALID_PARAMS', details: { code: 'VIRAL_UPLOAD_CONFLICT' } })
    expect(probeVideoMock).not.toHaveBeenCalled()
    expect(uploadObjectStreamMock).not.toHaveBeenCalled()
  })

  it('atomically lets only one request take over an expired upload lock', async () => {
    const now = new Date('2026-07-15T09:00:00.000Z')
    await prisma.viralReplication.update({
      where: { id: replicationId },
      data: { uploadLockToken: 'expired-owner', uploadLockExpiresAt: new Date(now.getTime() - 1) },
    })
    let releaseUpload!: () => void
    let markUploadStarted!: () => void
    const uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve })
    const uploadStarted = new Promise<void>((resolve) => { markUploadStarted = resolve })
    uploadObjectStreamMock.mockImplementationOnce(async () => {
      markUploadStarted()
      await uploadGate
      return storageState.key
    })
    const { uploadViralReplicationVideo } = await import('@/lib/viral-replication/service')
    const first = uploadViralReplicationVideo({
      id: replicationId, userId, request: videoRequest(mp4Bytes()), mimeType: 'video/mp4', locale: 'zh', tempRoot,
      now, lockTtlMs: 30_000,
    })
    await uploadStarted
    const held = await prisma.viralReplication.findUniqueOrThrow({ where: { id: replicationId } })
    const second = uploadViralReplicationVideo({
      id: replicationId, userId, request: videoRequest(mp4Bytes()), mimeType: 'video/mp4', locale: 'zh', tempRoot,
      now, lockTtlMs: 30_000,
    })
    await expect(second).rejects.toMatchObject({ code: 'INVALID_PARAMS', details: { code: 'VIRAL_UPLOAD_CONFLICT' } })
    releaseUpload()
    await expect(first).resolves.toMatchObject({ status: 'analyzing' })
    expect(uploadObjectStreamMock).toHaveBeenCalledOnce()
    expect(held.uploadLockToken).toEqual(expect.any(String))
    expect(held.uploadLockToken).not.toBe('expired-owner')
    expect(held.uploadLockExpiresAt).toEqual(new Date(now.getTime() + 30_000))
  })

  it('does not let an old token release a newer upload lock owner', async () => {
    const now = new Date('2026-07-15T09:00:00.000Z')
    const newerExpiry = new Date(now.getTime() + 120_000)
    probeVideoMock.mockImplementationOnce(async () => {
      const held = await prisma.viralReplication.findUniqueOrThrow({ where: { id: replicationId } })
      expect(held.uploadLockToken).toEqual(expect.any(String))
      await prisma.viralReplication.update({
        where: { id: replicationId },
        data: { uploadLockToken: 'new-owner', uploadLockExpiresAt: newerExpiry },
      })
      throw new Error('probe failed after lock takeover')
    })
    const { uploadViralReplicationVideo } = await import('@/lib/viral-replication/service')
    await expect(uploadViralReplicationVideo({
      id: replicationId, userId, request: videoRequest(mp4Bytes()), mimeType: 'video/mp4', locale: 'zh', tempRoot,
      now, lockTtlMs: 30_000,
    })).rejects.toThrow()
    expect(await prisma.viralReplication.findUnique({ where: { id: replicationId } })).toMatchObject({
      status: 'uploading', uploadLockToken: 'new-owner', uploadLockExpiresAt: newerExpiry,
    })
  })
})
