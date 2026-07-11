import type { Prisma } from '@prisma/client'

import { prisma } from '@/lib/prisma'
import { resolveStorageKeyFromMediaValue } from '@/lib/media/service'

import { isOpaqueStorageKey } from './media'
import type { ComfyMediaType } from './types'

export interface OwnedComfyMediaInput {
  userId: string
  projectId: string
  storageKey: string
  mediaType: ComfyMediaType
}

export interface ComfyMediaOwnershipStore {
  findFirst(input: Record<string, unknown>): Promise<unknown>
}

const defaultStore: ComfyMediaOwnershipStore = {
  findFirst: (input) => prisma.mediaObject.findFirst(
    input as Prisma.MediaObjectFindFirstArgs,
  ),
}

export async function resolveOwnedComfyMedia(
  input: OwnedComfyMediaInput,
  store: ComfyMediaOwnershipStore = defaultStore,
) {
  if (!isOpaqueStorageKey(input.storageKey)) return false
  const record = await store.findFirst({
    where: ownedMediaWhere(input),
    select: { id: true },
  })
  return record !== null
}

export interface ResolveOwnedComfyMediaRefDependencies {
  resolveStorageKey(value: unknown): Promise<string | null>
  findFirst(input: Record<string, unknown>): Promise<unknown>
}

const defaultRefDependencies: ResolveOwnedComfyMediaRefDependencies = {
  resolveStorageKey: resolveComfyStorageKeyFromMediaValue,
  findFirst: defaultStore.findFirst,
}

export async function resolveComfyStorageKeyFromMediaValue(value: unknown): Promise<string | null> {
  if (typeof value !== 'string' || !value.trim()) return null
  const raw = value.trim()
  if (raw.startsWith('//')) return null
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) {
    try {
      if (new URL(raw).pathname === '/api/storage/sign') return null
    } catch {
      return null
    }
    return resolveStorageKeyFromMediaValue(raw)
  }
  if (raw.startsWith('/api/storage/sign')) return parseInternalSignedStorageRoute(raw)
  return resolveStorageKeyFromMediaValue(raw)
}

export async function resolveOwnedComfyMediaRefFromValue(
  input: Omit<OwnedComfyMediaInput, 'storageKey'> & { value: unknown },
  overrides: Partial<ResolveOwnedComfyMediaRefDependencies> = {},
) {
  const dependencies = { ...defaultRefDependencies, ...overrides }
  const storageKey = await dependencies.resolveStorageKey(input.value)
  if (!storageKey || !isOpaqueStorageKey(storageKey)) return null
  const record = await dependencies.findFirst({
    where: ownedMediaWhere({ ...input, storageKey }),
    select: { storageKey: true, mimeType: true },
  })
  if (!isOwnedMediaRecord(record, storageKey, input.mediaType)) return null
  return {
    storageKey: record.storageKey,
    ...(record.mimeType ? { mimeType: record.mimeType } : {}),
  }
}

function parseInternalSignedStorageRoute(value: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(value, 'http://waoowaoo.internal')
  } catch {
    return null
  }
  if (parsed.origin !== 'http://waoowaoo.internal'
    || parsed.pathname !== '/api/storage/sign'
    || parsed.hash) return null
  const keys = parsed.searchParams.getAll('key')
  const expires = parsed.searchParams.getAll('expires')
  const parameterNames = [...new Set(parsed.searchParams.keys())]
  if (keys.length !== 1 || !keys[0]
    || expires.length > 1
    || (expires.length === 1 && !/^\d+$/.test(expires[0]))
    || parameterNames.some((name) => name !== 'key' && name !== 'expires')) return null
  const storageKey = keys[0]
  if (!isOpaqueStorageKey(storageKey)
    || storageKey.split('/').some((segment) => segment === '.' || segment === '..')) return null
  return storageKey
}

function ownedMediaWhere(input: OwnedComfyMediaInput): Prisma.MediaObjectWhereInput {
  const project = { project: { is: { id: input.projectId, userId: input.userId } } }
  const promotion = { novelPromotionProject: { is: project } }
  const episode = { episode: { is: { novelPromotionProject: { is: project } } } }
  const storyboard = { storyboard: { is: episode } }
  return {
    storageKey: input.storageKey,
    mimeType: { startsWith: `${input.mediaType}/` },
    OR: [
      { characterAppearanceImages: { some: { character: { is: promotion } } } },
      { locationImages: { some: { location: { is: promotion } } } },
      { novelPromotionPanelImages: { some: storyboard } },
      { novelPromotionPanelVideos: { some: storyboard } },
      { novelPromotionPanelLipSyncVideos: { some: storyboard } },
      { novelPromotionPanelSketchImages: { some: storyboard } },
      { novelPromotionPanelPreviousImages: { some: storyboard } },
      { novelPromotionShotImages: { some: episode } },
      { supplementaryPanelImages: { some: storyboard } },
      { globalCharacterAppearanceImages: { some: { character: { is: { userId: input.userId } } } } },
      { globalCharacterAppearancePreviousImgs: { some: { character: { is: { userId: input.userId } } } } },
      { globalLocationImageImages: { some: { location: { is: { userId: input.userId } } } } },
      { globalLocationImagePreviousImages: { some: { location: { is: { userId: input.userId } } } } },
    ],
  }
}

function isOwnedMediaRecord(
  value: unknown,
  storageKey: string,
  mediaType: ComfyMediaType,
): value is { storageKey: string; mimeType: string | null } {
  if (!value || typeof value !== 'object') return false
  const record = value as { storageKey?: unknown; mimeType?: unknown }
  return record.storageKey === storageKey
    && typeof record.mimeType === 'string'
    && record.mimeType.startsWith(`${mediaType}/`)
}
