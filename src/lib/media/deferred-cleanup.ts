import { prisma } from '@/lib/prisma'
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

const cleanupCandidateModel = (
  prisma as unknown as { mediaCleanupCandidate: CleanupCandidateModel }
).mediaCleanupCandidate
const referenceModels = prisma as unknown as Record<string, ReferenceModel>
const mediaObjectModel = (
  prisma as unknown as { mediaObject: ReferenceModel }
).mediaObject

function normalizeStorageKey(value: string) {
  return value.replace(/^\/+/, '')
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

  return await cleanupCandidateModel.upsert({
    where: { storageKey },
    update: {
      ...(input.mediaId ? { mediaId: input.mediaId } : {}),
      mediaKind: input.mediaKind,
      reason: input.reason,
      notBefore,
    },
    create: {
      storageKey,
      mediaId: input.mediaId || null,
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

export async function inspectDeferredAudioCleanupCandidate(
  candidate: MediaCleanupCandidateRecord,
  now = new Date(),
): Promise<
  | { state: 'grace_period'; referenced: null }
  | { state: 'referenced'; referenced: true }
  | { state: 'eligible_for_future_gc'; referenced: false }
> {
  if (candidate.notBefore.getTime() > now.getTime()) {
    return { state: 'grace_period', referenced: null }
  }

  // This inspector is deliberately read-only. Even after the grace period it
  // only proves eligibility; a future GC worker must re-run these legacy-aware
  // reference checks immediately before deleting the database row and object.
  const media = await mediaObjectModel.findFirst({
    where: candidate.mediaId
      ? { OR: [{ id: candidate.mediaId }, { storageKey: candidate.storageKey }] }
      : { storageKey: candidate.storageKey },
    select: { id: true, publicId: true },
  }) as { id?: string | null; publicId?: string | null } | null
  const effectiveMediaId = candidate.mediaId || media?.id || null
  const needles = new Set([
    candidate.storageKey,
    encodeURIComponent(candidate.storageKey),
    ...(media?.publicId ? [`/m/${encodeURIComponent(media.publicId)}`] : []),
  ])

  const references = await Promise.all(AUDIO_REFERENCE_PROBES.map(async (probe) => {
    const or = [
      ...(effectiveMediaId ? [{ [probe.mediaIdField]: effectiveMediaId }] : []),
      ...[...needles].map((needle) => ({ [probe.urlField]: { contains: needle } })),
    ]
    return await probe.model.findFirst({
      where: { OR: or },
      select: { id: true },
    })
  }))

  return references.some(Boolean)
    ? { state: 'referenced', referenced: true }
    : { state: 'eligible_for_future_gc', referenced: false }
}
