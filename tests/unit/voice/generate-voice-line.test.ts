import { beforeEach, describe, expect, it, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  novelPromotionVoiceLine: {
    findUnique: vi.fn(),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
  novelPromotionProject: {
    findUnique: vi.fn(),
  },
  novelPromotionEpisode: {
    findUnique: vi.fn(),
  },
  mediaObject: {
    deleteMany: vi.fn(async () => ({ count: 1 })),
  },
}))

const resolveModelSelectionOrSingleMock = vi.hoisted(() => vi.fn())
const getProviderKeyMock = vi.hoisted(() => vi.fn((providerId: string) => providerId))
const getAudioApiKeyMock = vi.hoisted(() => vi.fn())

const normalizeToBase64ForGenerationMock = vi.hoisted(() => vi.fn())
const extractStorageKeyMock = vi.hoisted(() => vi.fn())
const getSignedUrlMock = vi.hoisted(() => vi.fn((storageKey: string) => `signed://${storageKey}`))
const toFetchableUrlMock = vi.hoisted(() => vi.fn((url: string) => url))
const uploadObjectMock = vi.hoisted(() => vi.fn(async () => 'voice/storage/line-1.wav'))
const deleteObjectMock = vi.hoisted(() => vi.fn(async () => undefined))
const resolveStorageKeyFromMediaValueMock = vi.hoisted(() => vi.fn())
const ensureMediaObjectFromStorageKeyMock = vi.hoisted(() => vi.fn(async (storageKey: string) => ({
  id: 'media-new',
  publicId: 'public-new',
  url: '/m/public-new',
  storageKey,
  mimeType: 'audio/wav',
  sizeBytes: null,
  width: null,
  height: null,
  durationMs: 1,
})))
const getMediaObjectByIdMock = vi.hoisted(() => vi.fn())
const scheduleMediaCleanupCandidateMock = vi.hoisted(() => vi.fn(async () => undefined))
const synthesizeWithBailianTTSMock = vi.hoisted(() => vi.fn())
const falSubscribeMock = vi.hoisted(() => vi.fn())
const getProviderConfigMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/prisma', () => ({
  prisma: prismaMock,
}))

vi.mock('@/lib/api-config', () => ({
  getAudioApiKey: getAudioApiKeyMock,
  getProviderConfig: getProviderConfigMock,
  getProviderKey: getProviderKeyMock,
  resolveModelSelectionOrSingle: resolveModelSelectionOrSingleMock,
}))

vi.mock('@/lib/media/outbound-image', () => ({
  normalizeToBase64ForGeneration: normalizeToBase64ForGenerationMock,
}))

vi.mock('@/lib/storage', () => ({
  deleteObject: deleteObjectMock,
  extractStorageKey: extractStorageKeyMock,
  getSignedUrl: getSignedUrlMock,
  toFetchableUrl: toFetchableUrlMock,
  uploadObject: uploadObjectMock,
}))

vi.mock('@/lib/media/service', () => ({
  ensureMediaObjectFromStorageKey: ensureMediaObjectFromStorageKeyMock,
  getMediaObjectById: getMediaObjectByIdMock,
  resolveStorageKeyFromMediaValue: resolveStorageKeyFromMediaValueMock,
}))

vi.mock('@/lib/media/deferred-cleanup', () => ({
  scheduleMediaCleanupCandidate: scheduleMediaCleanupCandidateMock,
}))

vi.mock('@/lib/providers/bailian', () => ({
  synthesizeWithBailianTTS: synthesizeWithBailianTTSMock,
}))

vi.mock('@fal-ai/client', () => ({
  fal: {
    config: vi.fn(),
    subscribe: falSubscribeMock,
  },
}))

import { generateVoiceLine } from '@/lib/voice/generate-voice-line'

describe('generate voice line with bailian provider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const audioBytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])

    prismaMock.novelPromotionVoiceLine.findUnique.mockResolvedValue({
      id: 'line-1',
      episodeId: 'episode-1',
      speaker: 'Narrator',
      content: '你好，世界',
      emotionPrompt: null,
      emotionStrength: null,
      audioUrl: 'voice/storage/previous.wav',
      audioMediaId: null,
      updatedAt: new Date('2026-07-20T00:00:00.000Z'),
    })
    prismaMock.novelPromotionProject.findUnique.mockResolvedValue({
      characters: [],
    })
    prismaMock.novelPromotionEpisode.findUnique.mockResolvedValue({
      speakerVoices: JSON.stringify({
        Narrator: {
          audioUrl: 'voice/reference.wav',
          voiceId: 'voice_abc123',
        },
      }),
    })

    resolveModelSelectionOrSingleMock.mockResolvedValue({
      provider: 'bailian',
      modelId: 'qwen3-tts-vd-2026-01-26',
      modelKey: 'bailian::qwen3-tts-vd-2026-01-26',
      mediaType: 'audio',
    })

    getProviderConfigMock.mockResolvedValue({
      id: 'bailian',
      name: 'Alibaba Bailian',
      apiKey: 'bl-key',
    })
    synthesizeWithBailianTTSMock.mockResolvedValue({
      success: true,
      audioData: Buffer.from(audioBytes),
      audioDuration: 1,
    })
    resolveStorageKeyFromMediaValueMock.mockImplementation(async (value: unknown) => (
      typeof value === 'string' && value.startsWith('voice/') ? value : null
    ))
  })

  it('uses speaker voiceId to generate and persists uploaded audio', async () => {
    const result = await generateVoiceLine({
      projectId: 'project-1',
      episodeId: 'episode-1',
      lineId: 'line-1',
      userId: 'user-1',
      audioModel: 'bailian::qwen3-tts-vd-2026-01-26',
    })

    expect(getProviderConfigMock).toHaveBeenCalledWith('user-1', 'bailian')
    expect(synthesizeWithBailianTTSMock).toHaveBeenCalledWith({
      text: '你好，世界',
      voiceId: 'voice_abc123',
      modelId: 'qwen3-tts-vd-2026-01-26',
      languageType: 'Chinese',
    }, 'bl-key')
    expect(uploadObjectMock).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.stringMatching(/^voice\/project-1\/episode-1\/line-1\/.+\.wav$/),
    )
    expect(prismaMock.novelPromotionVoiceLine.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'line-1',
        episodeId: 'episode-1',
        speaker: 'Narrator',
        content: '你好，世界',
        emotionPrompt: null,
        emotionStrength: null,
        audioUrl: 'voice/storage/previous.wav',
        audioMediaId: null,
        updatedAt: new Date('2026-07-20T00:00:00.000Z'),
      },
      data: {
        audioUrl: 'voice/storage/line-1.wav',
        audioMediaId: 'media-new',
        audioDuration: 1,
      },
    })
    expect(result).toEqual({
      lineId: 'line-1',
      audioUrl: 'signed://voice/storage/line-1.wav',
      storageKey: 'voice/storage/line-1.wav',
      audioDuration: 1,
    })
    expect(ensureMediaObjectFromStorageKeyMock).toHaveBeenCalledWith(
      'voice/storage/line-1.wav',
      { mimeType: 'audio/wav', durationMs: 1 },
    )
    expect(scheduleMediaCleanupCandidateMock).toHaveBeenCalledWith({
      storageKey: 'voice/storage/previous.wav',
      mediaId: null,
      mediaKind: 'audio',
      reason: 'voice_line_replaced',
    })
  })

  it('deletes a newly uploaded object when snapshot CAS loses a race', async () => {
    prismaMock.novelPromotionVoiceLine.findUnique.mockResolvedValue({
      id: 'line-1',
      episodeId: 'episode-1',
      speaker: 'Narrator',
      content: '你好，世界',
      emotionPrompt: null,
      emotionStrength: null,
      audioUrl: 'voice/storage/previous.wav',
      audioMediaId: 'media-old',
      updatedAt: new Date('2026-07-20T00:00:00.000Z'),
    })
    prismaMock.novelPromotionVoiceLine.updateMany.mockResolvedValueOnce({ count: 0 })

    await expect(generateVoiceLine({
      projectId: 'project-1',
      episodeId: 'episode-1',
      lineId: 'line-1',
      userId: 'user-1',
      audioModel: 'bailian::qwen3-tts-vd-2026-01-26',
    })).rejects.toThrow('VOICE_LINE_STALE')

    expect(prismaMock.mediaObject.deleteMany).toHaveBeenCalledWith({
      where: {
        id: 'media-new',
        storageKey: 'voice/storage/line-1.wav',
      },
    })
    expect(deleteObjectMock).toHaveBeenCalledWith('voice/storage/line-1.wav')
    expect(scheduleMediaCleanupCandidateMock).not.toHaveBeenCalled()
    expect(prismaMock.novelPromotionVoiceLine.updateMany).toHaveBeenCalledTimes(1)
  })

  it('replaces a non-null old audioMediaId and defers shared old media instead of deleting it', async () => {
    prismaMock.novelPromotionVoiceLine.findUnique.mockResolvedValue({
      id: 'line-1',
      episodeId: 'episode-1',
      speaker: 'Narrator',
      content: '你好，世界',
      emotionPrompt: null,
      emotionStrength: null,
      audioUrl: 'voice/storage/previous.wav',
      audioMediaId: 'media-shared-old',
      updatedAt: new Date('2026-07-20T00:00:00.000Z'),
    })
    getMediaObjectByIdMock.mockResolvedValueOnce({
      id: 'media-shared-old',
      storageKey: 'voice/storage/previous.wav',
    })

    await generateVoiceLine({
      projectId: 'project-1',
      episodeId: 'episode-1',
      lineId: 'line-1',
      userId: 'user-1',
      audioModel: 'bailian::qwen3-tts-vd-2026-01-26',
    })

    expect(prismaMock.novelPromotionVoiceLine.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ audioMediaId: 'media-shared-old' }),
      data: expect.objectContaining({
        audioUrl: 'voice/storage/line-1.wav',
        audioMediaId: 'media-new',
      }),
    }))
    expect(scheduleMediaCleanupCandidateMock).toHaveBeenCalledWith({
      storageKey: 'voice/storage/previous.wav',
      mediaId: 'media-shared-old',
      mediaKind: 'audio',
      reason: 'voice_line_replaced',
    })
    expect(prismaMock.mediaObject.deleteMany).not.toHaveBeenCalled()
    expect(deleteObjectMock).not.toHaveBeenCalled()
  })

  it('fails explicitly when bailian speaker binding only has uploaded audio', async () => {
    prismaMock.novelPromotionEpisode.findUnique.mockResolvedValueOnce({
      speakerVoices: JSON.stringify({
        Narrator: {
          audioUrl: 'voice/reference.wav',
        },
      }),
    })

    await expect(
      generateVoiceLine({
        projectId: 'project-1',
        episodeId: 'episode-1',
        lineId: 'line-1',
        userId: 'user-1',
        audioModel: 'bailian::qwen3-tts-vd-2026-01-26',
      }),
    ).rejects.toThrow('无音色ID，QwenTTS 必须使用 AI 设计音色')

    expect(synthesizeWithBailianTTSMock).not.toHaveBeenCalled()
    expect(uploadObjectMock).not.toHaveBeenCalled()
  })

  it('maps bailian invalid parameter to a qwen voice guidance error', async () => {
    synthesizeWithBailianTTSMock.mockResolvedValueOnce({
      success: false,
      error: 'BAILIAN_TTS_FAILED(400): InvalidParameter',
    })

    await expect(
      generateVoiceLine({
        projectId: 'project-1',
        episodeId: 'episode-1',
        lineId: 'line-1',
        userId: 'user-1',
        audioModel: 'bailian::qwen3-tts-vd-2026-01-26',
      }),
    ).rejects.toThrow('无效音色ID，QwenTTS 必须使用 AI 设计音色')

    expect(uploadObjectMock).not.toHaveBeenCalled()
  })
})
