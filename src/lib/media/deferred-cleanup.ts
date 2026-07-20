import { prisma } from '@/lib/prisma'
import { parseSpeakerVoiceMediaUrls } from '@/lib/voice/provider-voice-binding'
import { MEDIA_MODEL_MAPPINGS } from './model-mappings'

export const MEDIA_CLEANUP_GRACE_MS = 7 * 24 * 60 * 60 * 1000

export type MediaCleanupCandidateRecord = {
  id: string
  storageKey: string
  mediaId: string | null
  mediaKind: string
  reason: string
  notBefore: Date
}

type CleanupCandidateModel = {
  upsert: (args: unknown) => Promise<unknown>
}

type ReferenceModel = {
  findFirst: (args: unknown) => Promise<unknown>
}

type EpisodeReferenceModel = ReferenceModel & {
  findMany: (args: unknown) => Promise<unknown>
}

type MediaIdentityRow = {
  id: string
  publicId: string
  storageKey: string
}

const cleanupCandidateModel = (
  prisma as unknown as { mediaCleanupCandidate: CleanupCandidateModel }
).mediaCleanupCandidate
const referenceModels = prisma as unknown as Record<string, ReferenceModel>
const mediaObjectModel = (
  prisma as unknown as { mediaObject: ReferenceModel }
).mediaObject
const episodeReferenceModel = (
  prisma as unknown as { novelPromotionEpisode: EpisodeReferenceModel }
).novelPromotionEpisode

function normalizeStorageKey(value: string) {
  return value.replace(/^\/+/, '')
}

function decodeURIComponentSafely(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

async function findMediaIdentityByStorageKey(storageKey: string): Promise<MediaIdentityRow | null> {
  return await mediaObjectModel.findFirst({
    where: { storageKey },
    select: { id: true, publicId: true, storageKey: true },
  }) as MediaIdentityRow | null
}

async function resolveCanonicalCandidateMediaId(
  storageKey: string,
  candidateMediaId: string | null | undefined,
): Promise<string | null> {
  const canonical = await findMediaIdentityByStorageKey(storageKey)
  if (canonical) return canonical.id
  if (!candidateMediaId) return null

  const byId = await mediaObjectModel.findFirst({
    where: { id: candidateMediaId },
    select: { id: true, publicId: true, storageKey: true },
  }) as MediaIdentityRow | null
  return byId && normalizeStorageKey(byId.storageKey) === storageKey
    ? byId.id
    : null
}

export async function scheduleMediaCleanupCandidate(input: {
  storageKey: string
  mediaId?: string | null
  mediaKind: 'audio' | 'image' | 'video' | 'unknown'
  reason: string
  now?: Date
  graceMs?: number
}): Promise<MediaCleanupCandidateRecord> {
  const storageKey = normalizeStorageKey(input.storageKey)
  const now = input.now || new Date()
  const graceMs = Math.max(0, input.graceMs ?? MEDIA_CLEANUP_GRACE_MS)
  const notBefore = new Date(now.getTime() + graceMs)
  const mediaId = await resolveCanonicalCandidateMediaId(storageKey, input.mediaId)

  return await cleanupCandidateModel.upsert({
    where: { storageKey },
    update: {
      mediaId,
      mediaKind: input.mediaKind,
      reason: input.reason,
      notBefore,
    },
    create: {
      storageKey,
      mediaId,
      mediaKind: input.mediaKind,
      reason: input.reason,
      notBefore,
    },
  }) as MediaCleanupCandidateRecord
}

const AUDIO_REFERENCE_PROBES = MEDIA_MODEL_MAPPINGS.flatMap((mapping) => (
  mapping.fields
    .filter((field) => field.mediaIdField.toLowerCase().includes('audio')
      || field.mediaIdField.toLowerCase().includes('voice'))
    .map((field) => ({
      model: referenceModels[mapping.model],
      urlField: field.legacyField,
      mediaIdField: field.mediaIdField,
    }))
))

function speakerVoiceUrlMatchesIdentity(input: {
  value: string
  storageKey: string
  publicIds: Set<string>
}) {
  const value = input.value.trim()
  if (!value) return false

  let parsed: URL
  try {
    parsed = new URL(value, 'http://media-cleanup.local')
  } catch {
    // A stored audio reference that cannot be normalized is not safe to GC.
    return true
  }

  const keyParam = parsed.searchParams.get('key')
  if (
    keyParam
    && normalizeStorageKey(decodeURIComponentSafely(keyParam)) === input.storageKey
  ) {
    return true
  }

  const decodedPath = decodeURIComponentSafely(parsed.pathname)
  const normalizedPath = normalizeStorageKey(decodedPath)
  const isAbsoluteObjectUrl = /^https?:\/\//i.test(value)
  if (
    normalizedPath === input.storageKey
    || (isAbsoluteObjectUrl && normalizedPath.endsWith(`/${input.storageKey}`))
  ) {
    return true
  }

  if (decodedPath.startsWith('/api/files/')) {
    const fileKey = normalizeStorageKey(decodedPath.slice('/api/files/'.length))
    if (fileKey === input.storageKey) return true
  }

  if (decodedPath.startsWith('/m/')) {
    const publicId = decodeURIComponentSafely(decodedPath.slice('/m/'.length))
    if (input.publicIds.has(publicId)) return true
  }

  return false
}

async function collectMatchingMediaIdentity(candidate: MediaCleanupCandidateRecord) {
  const storageKey = normalizeStorageKey(candidate.storageKey)
  const canonical = await findMediaIdentityByStorageKey(storageKey)
  const rows: MediaIdentityRow[] = canonical ? [canonical] : []

  if (candidate.mediaId && candidate.mediaId !== canonical?.id) {
    const byId = await mediaObjectModel.findFirst({
      where: { id: candidate.mediaId },
      select: { id: true, publicId: true, storageKey: true },
    }) as MediaIdentityRow | null
    if (byId && normalizeStorageKey(byId.storageKey) === storageKey) {
      rows.push(byId)
    }
  }

  return {
    storageKey,
    mediaIds: new Set(rows.map((row) => row.id)),
    publicIds: new Set(rows.map((row) => row.publicId)),
  }
}

async function hasSpeakerVoiceReference(identity: {
  storageKey: string
  publicIds: Set<string>
}) {
  const episodes = await episodeReferenceModel.findMany({
    where: { speakerVoices: { not: null } },
    select: { speakerVoices: true },
  }) as Array<{ speakerVoices: string | null }>

  for (const episode of episodes) {
    let urls: string[]
    try {
      urls = parseSpeakerVoiceMediaUrls(episode.speakerVoices)
    } catch {
      // An invalid legacy payload cannot be proven safe, so retain candidates.
      return true
    }
    if (urls.some((value) => speakerVoiceUrlMatchesIdentity({ value, ...identity }))) {
      return true
    }
  }
  return false
}

export async function inspectDeferredAudioCleanupCandidate(
  candidate: MediaCleanupCandidateRecord,
  now = new Date(),
): Promise<
  | { state: 'grace_period'; referenced: null }
  | { state: 'referenced'; referenced: true }
  | { state: 'eligible_for_future_gc'; referenced: false }
  | { state: 'unsupported_media_kind'; referenced: null }
> {
  if (candidate.mediaKind !== 'audio') {
    return { state: 'unsupported_media_kind', referenced: null }
  }
  if (candidate.notBefore.getTime() > now.getTime()) {
    return { state: 'grace_period', referenced: null }
  }

  // This inspector is deliberately read-only. Even after the grace period it
  // only proves eligibility; a future GC worker must re-run these legacy-aware
  // reference checks immediately before deleting the database row and object.
  const identity = await collectMatchingMediaIdentity(candidate)
  const needles = new Set([
    identity.storageKey,
    encodeURIComponent(identity.storageKey),
    ...[...identity.publicIds].map((publicId) => `/m/${encodeURIComponent(publicId)}`),
  ])

  const references = await Promise.all(AUDIO_REFERENCE_PROBES.map(async (probe) => {
    const or = [
      ...[...identity.mediaIds].map((mediaId) => ({ [probe.mediaIdField]: mediaId })),
      ...[...needles].map((needle) => ({ [probe.urlField]: { contains: needle } })),
    ]
    return await probe.model.findFirst({
      where: { OR: or },
      select: { id: true },
    })
  }))

  if (references.some(Boolean) || await hasSpeakerVoiceReference(identity)) {
    return { state: 'referenced', referenced: true }
  }
  return { state: 'eligible_for_future_gc', referenced: false }
}
