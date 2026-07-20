import { randomUUID } from 'node:crypto'
import { logError as _ulogError, logInfo as _ulogInfo } from '@/lib/logging/core'
import { fal } from '@fal-ai/client'
import { prisma } from '@/lib/prisma'
import { getAudioApiKey, getProviderConfig, getProviderKey, resolveModelSelectionOrSingle } from '@/lib/api-config'
import { normalizeToBase64ForGeneration } from '@/lib/media/outbound-image'
import { deleteObject, extractStorageKey, getSignedUrl, toFetchableUrl, uploadObject } from '@/lib/storage'
import {
  ensureMediaObjectFromStorageKey,
  getMediaObjectById,
  resolveStorageKeyFromMediaValue,
} from '@/lib/media/service'
import { scheduleMediaCleanupCandidate } from '@/lib/media/deferred-cleanup'
import type { MediaRef } from '@/lib/media/types'
import { synthesizeWithBailianTTS } from '@/lib/providers/bailian'
import {
  parseSpeakerVoiceMap,
  resolveVoiceBindingForProvider,
  type CharacterVoiceFields,
  type SpeakerVoiceMap,
} from '@/lib/voice/provider-voice-binding'

type CheckCancelled = () => Promise<void>
type CharacterVoiceProfile = CharacterVoiceFields & { name: string }

type VoiceLineGenerationSnapshot = {
  id: string
  episodeId: string
  speaker: string
  content: string
  emotionPrompt: string | null
  emotionStrength: number | null
  audioUrl: string | null
  audioMediaId: string | null
  updatedAt: Date
}

function isSameVoiceLineSnapshot(
  current: VoiceLineGenerationSnapshot & { enabled: boolean } | null,
  snapshot: VoiceLineGenerationSnapshot,
) {
  return current?.id === snapshot.id
    && current.episodeId === snapshot.episodeId
    && current.enabled
    && current.speaker === snapshot.speaker
    && current.content === snapshot.content
    && current.emotionPrompt === snapshot.emotionPrompt
    && current.emotionStrength === snapshot.emotionStrength
    && current.audioUrl === snapshot.audioUrl
    && current.audioMediaId === snapshot.audioMediaId
    && current.updatedAt.getTime() === snapshot.updatedAt.getTime()
}

async function cleanupUnpublishedVoiceMedia(input: {
  storageKey: string
  media: MediaRef | null
}) {
  try {
    if (input.media) {
      // This is deliberately private compensation for a UUID-keyed object that
      // failed before its URL/media id was published. Published media must use
      // the deferred, legacy-aware cleanup path below.
      const deleted = await prisma.mediaObject.deleteMany({
        where: {
          id: input.media.id,
          storageKey: input.storageKey,
        },
      })
      if (deleted.count > 0) {
        await deleteObject(input.storageKey)
      }
    } else {
      await deleteObject(input.storageKey)
    }
  } catch (error) {
    _ulogError('[Voice] failed to clean unpublished generated audio', {
      storageKey: input.storageKey,
      mediaId: input.media?.id,
      error,
    })
  }
}

async function deferReplacedVoiceMediaCleanup(input: {
  audioMediaId: string | null
  audioUrl: string | null
  replacementStorageKey: string
}) {
  try {
    const media = input.audioMediaId
      ? await getMediaObjectById(input.audioMediaId)
      : null
    const storageKey = media?.storageKey
      || await resolveStorageKeyFromMediaValue(input.audioUrl)
    if (!storageKey || storageKey === input.replacementStorageKey) return

    await scheduleMediaCleanupCandidate({
      storageKey,
      mediaId: input.audioMediaId,
      mediaKind: 'audio',
      reason: 'voice_line_replaced',
    })
  } catch (error) {
    _ulogError('[Voice] failed to defer replaced audio media cleanup', {
      audioMediaId: input.audioMediaId,
      audioUrl: input.audioUrl,
      error,
    })
  }
}

function normalizeBailianVoiceGenerationError(errorMessage: string | null | undefined) {
  const message = typeof errorMessage === 'string' ? errorMessage.trim() : ''
  if (!message) return 'BAILIAN_AUDIO_GENERATION_FAILED'

  const normalized = message.toLowerCase()
  if (
    normalized.includes('bailian_tts_failed(400): invalidparameter') ||
    normalized.includes('invalidparameter')
  ) {
    return '无效音色ID，QwenTTS 必须使用 AI 设计音色'
  }

  return message
}

function getWavDurationFromBuffer(buffer: Buffer): number {
  try {
    const riff = buffer.slice(0, 4).toString('ascii')
    if (riff !== 'RIFF') {
      return Math.round((buffer.length * 8) / 128)
    }

    const byteRate = buffer.readUInt32LE(28)
    let offset = 12
    let dataSize = 0

    while (offset < buffer.length - 8) {
      const chunkId = buffer.slice(offset, offset + 4).toString('ascii')
      const chunkSize = buffer.readUInt32LE(offset + 4)

      if (chunkId === 'data') {
        dataSize = chunkSize
        break
      }

      offset += 8 + chunkSize
    }

    if (dataSize > 0 && byteRate > 0) {
      return Math.round((dataSize / byteRate) * 1000)
    }

    return Math.round((buffer.length * 8) / 128)
  } catch {
    return Math.round((buffer.length * 8) / 128)
  }
}

async function generateVoiceWithIndexTTS2(params: {
  endpoint: string
  referenceAudioUrl: string
  text: string
  emotionPrompt?: string | null
  strength?: number
  falApiKey?: string
}) {
  const strength = typeof params.strength === 'number' ? params.strength : 0.4

  _ulogInfo(`IndexTTS2: Generating with reference audio, strength: ${strength}`)
  if (params.emotionPrompt) {
    _ulogInfo(`IndexTTS2: Using emotion prompt: ${params.emotionPrompt}`)
  }

  if (params.falApiKey) {
    fal.config({ credentials: params.falApiKey })
  }

  const audioDataUrl = params.referenceAudioUrl.startsWith('data:')
    ? params.referenceAudioUrl
    : await normalizeToBase64ForGeneration(params.referenceAudioUrl)

  const input: {
    audio_url: string
    prompt: string
    should_use_prompt_for_emotion: boolean
    strength: number
    emotion_prompt?: string
  } = {
    audio_url: audioDataUrl,
    prompt: params.text,
    should_use_prompt_for_emotion: true,
    strength,
  }

  if (params.emotionPrompt?.trim()) {
    input.emotion_prompt = params.emotionPrompt.trim()
  }

  const result = await fal.subscribe(params.endpoint, {
    input,
    logs: false,
  })

  const audioUrl = (result as { data?: { audio?: { url?: string } } })?.data?.audio?.url
  if (!audioUrl) {
    throw new Error('No audio URL in response')
  }

  const audioData = await downloadAudioData(audioUrl)

  return {
    audioData,
    audioDuration: getWavDurationFromBuffer(audioData),
  }
}

function matchCharacterBySpeaker(
  speaker: string,
  characters: CharacterVoiceProfile[],
) {
  const exactMatch = characters.find((character) => character.name === speaker)
  if (exactMatch) return exactMatch
  return characters.find((character) => character.name.includes(speaker) || speaker.includes(character.name))
}

async function resolveReferenceAudioUrl(referenceAudioUrl: string): Promise<string> {
  if (referenceAudioUrl.startsWith('http') || referenceAudioUrl.startsWith('data:')) {
    return referenceAudioUrl
  }
  if (referenceAudioUrl.startsWith('/m/')) {
    const storageKey = await resolveStorageKeyFromMediaValue(referenceAudioUrl)
    if (!storageKey) {
      throw new Error(`无法解析参考音频路径: ${referenceAudioUrl}`)
    }
    return getSignedUrl(storageKey, 3600)
  }
  if (referenceAudioUrl.startsWith('/api/files/')) {
    const storageKey = extractStorageKey(referenceAudioUrl)
    return storageKey ? getSignedUrl(storageKey, 3600) : referenceAudioUrl
  }
  return getSignedUrl(referenceAudioUrl, 3600)
}

async function downloadAudioData(audioUrl: string): Promise<Buffer> {
  const response = await fetch(toFetchableUrl(audioUrl))
  if (!response.ok) {
    throw new Error(`Audio download failed: ${response.status}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

export async function generateVoiceLine(params: {
  projectId: string
  episodeId?: string | null
  lineId: string
  userId: string
  audioModel?: string
  checkCancelled?: CheckCancelled
}) {
  const checkCancelled = params.checkCancelled

  const line = await prisma.novelPromotionVoiceLine.findUnique({
    where: { id: params.lineId },
    select: {
      id: true,
      episodeId: true,
      speaker: true,
      content: true,
      emotionPrompt: true,
      emotionStrength: true,
      enabled: true,
      audioUrl: true,
      audioMediaId: true,
      updatedAt: true,
    },
  })
  if (!line) {
    throw new Error('Voice line not found')
  }
  if (!line.enabled) {
    throw new Error('VOICE_LINE_DISABLED')
  }

  const episodeId = params.episodeId || line.episodeId
  if (!episodeId) {
    throw new Error('episodeId is required')
  }
  if (episodeId !== line.episodeId) {
    throw new Error('VOICE_LINE_EPISODE_MISMATCH')
  }

  const generationSnapshot: VoiceLineGenerationSnapshot = {
    id: line.id,
    episodeId: line.episodeId,
    speaker: line.speaker,
    content: line.content,
    emotionPrompt: line.emotionPrompt,
    emotionStrength: line.emotionStrength,
    audioUrl: line.audioUrl,
    audioMediaId: line.audioMediaId,
    updatedAt: line.updatedAt,
  }

  const [projectData, episode] = await Promise.all([
    prisma.novelPromotionProject.findUnique({
      where: { projectId: params.projectId },
      include: { characters: true },
    }),
    prisma.novelPromotionEpisode.findUnique({
      where: { id: episodeId },
      select: { speakerVoices: true },
    }),
  ])

  if (!projectData) {
    throw new Error('Novel promotion project not found')
  }

  const speakerVoices: SpeakerVoiceMap = parseSpeakerVoiceMap(episode?.speakerVoices)

  const character = matchCharacterBySpeaker(line.speaker, projectData.characters || [])
  const speakerVoice = speakerVoices[line.speaker]

  const text = (line.content || '').trim()
  if (!text) {
    throw new Error('Voice line text is empty')
  }

  const audioSelection = await resolveModelSelectionOrSingle(params.userId, params.audioModel, 'audio')
  const providerKey = getProviderKey(audioSelection.provider).toLowerCase()
  const voiceBinding = resolveVoiceBindingForProvider({
    providerKey,
    character,
    speakerVoice,
  })
  let generated: { audioData: Buffer; audioDuration: number }
  if (providerKey === 'fal') {
    if (!voiceBinding || voiceBinding.provider !== 'fal') {
      throw new Error('请先为该发言人设置参考音频')
    }

    const fullAudioUrl = await resolveReferenceAudioUrl(voiceBinding.referenceAudioUrl)
    const falApiKey = await getAudioApiKey(params.userId, audioSelection.modelKey)
    generated = await generateVoiceWithIndexTTS2({
      endpoint: audioSelection.modelId,
      referenceAudioUrl: fullAudioUrl,
      text,
      emotionPrompt: line.emotionPrompt,
      strength: line.emotionStrength ?? 0.4,
      falApiKey,
    })
  } else if (providerKey === 'bailian') {
    if (!voiceBinding || voiceBinding.provider !== 'bailian') {
      const hasUploadedReference =
        !!character?.customVoiceUrl ||
        (speakerVoice?.provider === 'fal' && !!speakerVoice.audioUrl)
      if (hasUploadedReference) {
        throw new Error('无音色ID，QwenTTS 必须使用 AI 设计音色')
      }
      throw new Error('请先为该发言人绑定百炼音色')
    }
    const { apiKey } = await getProviderConfig(params.userId, audioSelection.provider)
    const result = await synthesizeWithBailianTTS({
      text,
      voiceId: voiceBinding.voiceId,
      modelId: audioSelection.modelId,
      languageType: 'Chinese',
    }, apiKey)
    if (!result.success || !result.audioData) {
      throw new Error(normalizeBailianVoiceGenerationError(result.error))
    }

    const audioData = result.audioData
    generated = {
      audioData,
      audioDuration: result.audioDuration ?? getWavDurationFromBuffer(audioData),
    }
  } else {
    throw new Error(`AUDIO_PROVIDER_UNSUPPORTED: ${audioSelection.provider}`)
  }

  await checkCancelled?.()

  const currentLine = await prisma.novelPromotionVoiceLine.findUnique({
    where: { id: line.id },
    select: {
      id: true,
      episodeId: true,
      enabled: true,
      speaker: true,
      content: true,
      emotionPrompt: true,
      emotionStrength: true,
      audioUrl: true,
      audioMediaId: true,
      updatedAt: true,
    },
  })
  if (!currentLine?.enabled) {
    throw new Error('VOICE_LINE_DISABLED')
  }
  if (!isSameVoiceLineSnapshot(currentLine, generationSnapshot)) {
    throw new Error('VOICE_LINE_STALE')
  }

  const audioKey = `voice/${params.projectId}/${episodeId}/${line.id}/${randomUUID()}.wav`
  const cosKey = await uploadObject(generated.audioData, audioKey)
  let audioMedia: MediaRef | null = null
  let published = false
  try {
    audioMedia = await ensureMediaObjectFromStorageKey(cosKey, {
      mimeType: 'audio/wav',
      durationMs: generated.audioDuration || null,
    })
    await checkCancelled?.()

    const persisted = await prisma.novelPromotionVoiceLine.updateMany({
      where: {
        id: generationSnapshot.id,
        episodeId: generationSnapshot.episodeId,
        enabled: true,
        speaker: generationSnapshot.speaker,
        content: generationSnapshot.content,
        emotionPrompt: generationSnapshot.emotionPrompt,
        emotionStrength: generationSnapshot.emotionStrength,
        audioUrl: generationSnapshot.audioUrl,
        audioMediaId: generationSnapshot.audioMediaId,
        updatedAt: generationSnapshot.updatedAt,
      },
      data: {
        audioUrl: cosKey,
        audioMediaId: audioMedia.id,
        audioDuration: generated.audioDuration || null,
      },
    })
    if (persisted.count === 0) {
      throw new Error('VOICE_LINE_STALE')
    }
    published = true
  } catch (error) {
    if (!published) {
      await cleanupUnpublishedVoiceMedia({ storageKey: cosKey, media: audioMedia })
    }
    throw error
  }

  if (!audioMedia) {
    throw new Error('VOICE_MEDIA_REGISTRATION_FAILED')
  }
  if (generationSnapshot.audioMediaId !== audioMedia.id) {
    await deferReplacedVoiceMediaCleanup({
      audioMediaId: generationSnapshot.audioMediaId,
      audioUrl: generationSnapshot.audioUrl,
      replacementStorageKey: cosKey,
    })
  }

  const signedUrl = getSignedUrl(cosKey, 7200)
  return {
    lineId: line.id,
    audioUrl: signedUrl,
    storageKey: cosKey,
    audioDuration: generated.audioDuration || null,
  }
}

export function estimateVoiceLineMaxSeconds(content: string | null | undefined) {
  const chars = typeof content === 'string' ? content.length : 0
  return Math.max(5, Math.ceil(chars / 2))
}
