import { beforeEach, describe, expect, it, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  mediaCleanupCandidate: {
    upsert: vi.fn(),
  },
  mediaObject: {
    findFirst: vi.fn(),
  },
  novelPromotionCharacter: { findFirst: vi.fn() },
  novelPromotionEpisode: { findFirst: vi.fn() },
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
    prismaMock.novelPromotionVoiceLine.findFirst.mockResolvedValue(null)
    prismaMock.voicePreset.findFirst.mockResolvedValue(null)
    prismaMock.globalCharacter.findFirst.mockResolvedValue(null)
    prismaMock.globalVoice.findFirst.mockResolvedValue(null)
  })

  it('registers a legacy URL-only object with a grace period instead of deleting or forgetting it', async () => {
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

  it('does not probe or delete a candidate before its grace period expires', async () => {
    await expect(inspectDeferredAudioCleanupCandidate(
      candidate(),
      new Date('2026-07-20T00:00:00.000Z'),
    )).resolves.toEqual({ state: 'grace_period', referenced: null })

    expect(prismaMock.mediaObject.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.novelPromotionVoiceLine.findFirst).not.toHaveBeenCalled()
  })

  it('retains a due candidate when another legacy URL-only voice line shares the object', async () => {
    prismaMock.mediaObject.findFirst.mockResolvedValueOnce({ publicId: 'public-shared' })
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

  it('marks an unreferenced due candidate for a future GC pass without deleting it inline', async () => {
    await expect(inspectDeferredAudioCleanupCandidate(
      candidate({ notBefore: new Date('2026-07-19T00:00:00.000Z') }),
      new Date('2026-07-20T00:00:00.000Z'),
    )).resolves.toEqual({ state: 'eligible_for_future_gc', referenced: false })
  })
})
