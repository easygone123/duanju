import { beforeEach, describe, expect, it, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  mediaCleanupCandidate: {
    upsert: vi.fn(),
  },
  mediaObject: {
    findFirst: vi.fn(),
  },
  novelPromotionCharacter: { findFirst: vi.fn() },
  novelPromotionEpisode: { findFirst: vi.fn(), findMany: vi.fn() },
  novelPromotionVoiceLine: { findFirst: vi.fn() },
  voicePreset: { findFirst: vi.fn() },
  globalCharacter: { findFirst: vi.fn() },
  globalVoice: { findFirst: vi.fn() },
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

import {
  inspectDeferredAudioCleanupCandidate,
  MEDIA_CLEANUP_GRACE_MS,
  scheduleMediaCleanupCandidate,
  type MediaCleanupCandidateRecord,
} from '@/lib/media/deferred-cleanup'

function candidate(overrides: Partial<MediaCleanupCandidateRecord> = {}): MediaCleanupCandidateRecord {
  return {
    id: 'candidate-1',
    storageKey: 'voice/shared-old.wav',
    mediaId: null,
    mediaKind: 'audio',
    reason: 'voice_line_replaced',
    notBefore: new Date('2026-07-27T00:00:00.000Z'),
    ...overrides,
  }
}

describe('deferred media cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.mediaObject.findFirst.mockResolvedValue(null)
    prismaMock.novelPromotionCharacter.findFirst.mockResolvedValue(null)
    prismaMock.novelPromotionEpisode.findFirst.mockResolvedValue(null)
    prismaMock.novelPromotionEpisode.findMany.mockResolvedValue([])
    prismaMock.novelPromotionVoiceLine.findFirst.mockResolvedValue(null)
    prismaMock.voicePreset.findFirst.mockResolvedValue(null)
    prismaMock.globalCharacter.findFirst.mockResolvedValue(null)
    prismaMock.globalVoice.findFirst.mockResolvedValue(null)
  })

  it('clears a stale media id when a URL-only candidate is registered again', async () => {
    const now = new Date('2026-07-20T00:00:00.000Z')
    prismaMock.mediaCleanupCandidate.upsert.mockImplementationOnce(async (args: {
      create: MediaCleanupCandidateRecord
    }) => ({ id: 'candidate-1', ...args.create }))

    await scheduleMediaCleanupCandidate({
      storageKey: '/voice/legacy-owned.wav',
      mediaId: null,
      mediaKind: 'audio',
      reason: 'voice_line_replaced',
      now,
    })

    expect(prismaMock.mediaCleanupCandidate.upsert).toHaveBeenCalledWith({
      where: { storageKey: 'voice/legacy-owned.wav' },
      update: {
        mediaId: null,
        mediaKind: 'audio',
        reason: 'voice_line_replaced',
        notBefore: new Date(now.getTime() + MEDIA_CLEANUP_GRACE_MS),
      },
      create: {
        storageKey: 'voice/legacy-owned.wav',
        mediaId: null,
        mediaKind: 'audio',
        reason: 'voice_line_replaced',
        notBefore: new Date(now.getTime() + MEDIA_CLEANUP_GRACE_MS),
      },
    })
  })

  it('canonicalizes a supplied media id to the media row owned by the storage key', async () => {
    const now = new Date('2026-07-20T00:00:00.000Z')
    prismaMock.mediaObject.findFirst.mockResolvedValueOnce({
      id: 'media-canonical',
      publicId: 'public-canonical',
      storageKey: 'voice/legacy-owned.wav',
    })

    await scheduleMediaCleanupCandidate({
      storageKey: 'voice/legacy-owned.wav',
      mediaId: 'media-stale',
      mediaKind: 'audio',
      reason: 'voice_line_replaced',
      now,
    })

    expect(prismaMock.mediaCleanupCandidate.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ mediaId: 'media-canonical' }),
      create: expect.objectContaining({ mediaId: 'media-canonical' }),
    }))
  })

  it('records the media kind and replacement reason for deferred video cleanup', async () => {
    const now = new Date('2026-07-20T00:00:00.000Z')

    await scheduleMediaCleanupCandidate({
      storageKey: 'video/lip-sync-old.mp4',
      mediaId: 'video-media-old',
      mediaKind: 'video',
      reason: 'panel_lip_sync_replaced',
      now,
    })

    expect(prismaMock.mediaCleanupCandidate.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        mediaKind: 'video',
        reason: 'panel_lip_sync_replaced',
      }),
      create: expect.objectContaining({
        mediaKind: 'video',
        reason: 'panel_lip_sync_replaced',
      }),
    }))
  })

  it('does not probe or delete a candidate before its grace period expires', async () => {
    await expect(inspectDeferredAudioCleanupCandidate(
      candidate(),
      new Date('2026-07-20T00:00:00.000Z'),
    )).resolves.toEqual({ state: 'grace_period', referenced: null })

    expect(prismaMock.mediaObject.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.novelPromotionVoiceLine.findFirst).not.toHaveBeenCalled()
  })

  it('marks video candidates unsupported instead of reporting them safe for audio GC', async () => {
    await expect(inspectDeferredAudioCleanupCandidate(
      candidate({ mediaKind: 'video', reason: 'panel_lip_sync_replaced' }),
      new Date('2026-08-20T00:00:00.000Z'),
    )).resolves.toEqual({ state: 'unsupported_media_kind', referenced: null })

    expect(prismaMock.mediaObject.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.novelPromotionVoiceLine.findFirst).not.toHaveBeenCalled()
  })

  it('retains a due candidate when another legacy URL-only voice line shares the object', async () => {
    prismaMock.mediaObject.findFirst.mockResolvedValueOnce({
      id: 'media-canonical',
      publicId: 'public-shared',
      storageKey: 'voice/shared-old.wav',
    })
    prismaMock.novelPromotionVoiceLine.findFirst.mockResolvedValueOnce({ id: 'shared-line' })

    await expect(inspectDeferredAudioCleanupCandidate(
      candidate({ notBefore: new Date('2026-07-19T00:00:00.000Z') }),
      new Date('2026-07-20T00:00:00.000Z'),
    )).resolves.toEqual({ state: 'referenced', referenced: true })

    expect(prismaMock.novelPromotionVoiceLine.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        OR: expect.arrayContaining([
          { audioUrl: { contains: 'voice/shared-old.wav' } },
          { audioUrl: { contains: '/m/public-shared' } },
        ]),
      },
    }))
  })

  it('uses the storage-key media row and ignores a stale candidate media id', async () => {
    prismaMock.mediaObject.findFirst
      .mockResolvedValueOnce({
        id: 'media-canonical',
        publicId: 'public-canonical',
        storageKey: 'voice/shared-old.wav',
      })
      .mockResolvedValueOnce({
        id: 'media-stale',
        publicId: 'public-stale',
        storageKey: 'voice/different.wav',
      })
    prismaMock.novelPromotionVoiceLine.findFirst.mockImplementationOnce(async (args: {
      where: { OR: Array<Record<string, unknown>> }
    }) => args.where.OR.some((clause) => clause.audioMediaId === 'media-canonical')
      ? { id: 'canonical-reference' }
      : null)

    await expect(inspectDeferredAudioCleanupCandidate(
      candidate({
        mediaId: 'media-stale',
        notBefore: new Date('2026-07-19T00:00:00.000Z'),
      }),
      new Date('2026-07-20T00:00:00.000Z'),
    )).resolves.toEqual({ state: 'referenced', referenced: true })

    const voiceLineProbe = prismaMock.novelPromotionVoiceLine.findFirst.mock.calls[0]?.[0]
    expect(voiceLineProbe?.where.OR).toContainEqual({ audioMediaId: 'media-canonical' })
    expect(voiceLineProbe?.where.OR).not.toContainEqual({ audioMediaId: 'media-stale' })
  })

  it.each([
    ['storage key', 'voice/shared-old.wav'],
    ['encoded key', 'voice%2Fshared-old.wav'],
    ['complete object URL', 'https://storage.example/bucket/voice/shared-old.wav?signature=abc'],
    ['canonical signed route', '/api/storage/sign?key=voice%2Fshared-old.wav&expires=7200'],
    ['canonical media route', '/m/public-shared'],
  ])('retains a due candidate referenced by speakerVoices %s', async (_label, audioUrl) => {
    prismaMock.mediaObject.findFirst.mockResolvedValueOnce({
      id: 'media-canonical',
      publicId: 'public-shared',
      storageKey: 'voice/shared-old.wav',
    })
    prismaMock.novelPromotionEpisode.findMany.mockResolvedValueOnce([{
      speakerVoices: JSON.stringify({
        Narrator: {
          provider: audioUrl.includes('/m/') ? 'bailian' : 'fal',
          voiceType: 'uploaded',
          ...(audioUrl.includes('/m/')
            ? { voiceId: 'voice-1', previewAudioUrl: audioUrl }
            : { audioUrl }),
        },
      }),
    }])

    await expect(inspectDeferredAudioCleanupCandidate(
      candidate({ notBefore: new Date('2026-07-19T00:00:00.000Z') }),
      new Date('2026-07-20T00:00:00.000Z'),
    )).resolves.toEqual({ state: 'referenced', referenced: true })
  })

  it('checks a retained audioUrl even when the same speaker has a different previewAudioUrl', async () => {
    prismaMock.mediaObject.findFirst.mockResolvedValueOnce({
      id: 'media-canonical',
      publicId: 'public-shared',
      storageKey: 'voice/shared-old.wav',
    })
    prismaMock.novelPromotionEpisode.findMany.mockResolvedValueOnce([{
      speakerVoices: JSON.stringify({
        Narrator: {
          provider: 'bailian',
          voiceType: 'qwen-designed',
          voiceId: 'voice-1',
          audioUrl: 'voice/shared-old.wav',
          previewAudioUrl: 'voice/new-preview.wav',
        },
      }),
    }])

    await expect(inspectDeferredAudioCleanupCandidate(
      candidate({ notBefore: new Date('2026-07-19T00:00:00.000Z') }),
      new Date('2026-07-20T00:00:00.000Z'),
    )).resolves.toEqual({ state: 'referenced', referenced: true })
  })

  it('treats malformed speakerVoices JSON as referenced instead of risking deletion', async () => {
    prismaMock.mediaObject.findFirst.mockResolvedValueOnce({
      id: 'media-canonical',
      publicId: 'public-shared',
      storageKey: 'voice/shared-old.wav',
    })
    prismaMock.novelPromotionEpisode.findMany.mockResolvedValueOnce([{
      speakerVoices: '{"Narrator":',
    }])

    await expect(inspectDeferredAudioCleanupCandidate(
      candidate({ notBefore: new Date('2026-07-19T00:00:00.000Z') }),
      new Date('2026-07-20T00:00:00.000Z'),
    )).resolves.toEqual({ state: 'referenced', referenced: true })
  })

  it('does not retain an unrelated speakerVoices key that only contains the candidate as a suffix', async () => {
    prismaMock.mediaObject.findFirst.mockResolvedValueOnce({
      id: 'media-canonical',
      publicId: 'public-shared',
      storageKey: 'voice/shared-old.wav',
    })
    prismaMock.novelPromotionEpisode.findMany.mockResolvedValueOnce([{
      speakerVoices: JSON.stringify({
        Narrator: {
          provider: 'bailian',
          voiceType: 'qwen-designed',
          voiceId: 'voice-1',
          previewAudioUrl: 'archive/voice/shared-old.wav',
        },
      }),
    }])

    await expect(inspectDeferredAudioCleanupCandidate(
      candidate({ notBefore: new Date('2026-07-19T00:00:00.000Z') }),
      new Date('2026-07-20T00:00:00.000Z'),
    )).resolves.toEqual({ state: 'eligible_for_future_gc', referenced: false })
  })

  it('marks an unreferenced due candidate for a future GC pass without deleting it inline', async () => {
    await expect(inspectDeferredAudioCleanupCandidate(
      candidate({ notBefore: new Date('2026-07-19T00:00:00.000Z') }),
      new Date('2026-07-20T00:00:00.000Z'),
    )).resolves.toEqual({ state: 'eligible_for_future_gc', referenced: false })
  })
})
