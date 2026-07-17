import type { Prisma } from '@prisma/client'

import { prisma } from '@/lib/prisma'
import {
  ensureMediaObjectFromStorageKey,
  guessMimeTypeFromStorageKey,
  resolveStorageKeyFromMediaValue,
} from '@/lib/media/service'

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
  repairLegacyOwnedAsset?(input: OwnedComfyMediaInput): Promise<unknown>
}

const defaultRefDependencies: ResolveOwnedComfyMediaRefDependencies = {
  resolveStorageKey: resolveComfyStorageKeyFromMediaValue,
  findFirst: defaultStore.findFirst,
  repairLegacyOwnedAsset: repairLegacyOwnedProjectAsset,
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
  let record = await dependencies.findFirst({
    where: ownedMediaWhere({ ...input, storageKey }),
    select: { storageKey: true, mimeType: true },
  })
  const repairLegacyOwnedAsset = overrides.repairLegacyOwnedAsset
    ?? (overrides.findFirst ? undefined : defaultRefDependencies.repairLegacyOwnedAsset)
  if (!isOwnedMediaRecord(record, storageKey, input.mediaType) && repairLegacyOwnedAsset) {
    record = await repairLegacyOwnedAsset({
      userId: input.userId,
      projectId: input.projectId,
      storageKey,
      mediaType: input.mediaType,
    })
  }
  if (!isOwnedMediaRecord(record, storageKey, input.mediaType)) return null
  return {
    storageKey: record.storageKey,
    ...(record.mimeType ? { mimeType: record.mimeType } : {}),
  }
}

async function repairLegacyOwnedProjectAsset(input: OwnedComfyMediaInput) {
  if (input.mediaType !== 'image') return null
  const mimeType = guessMimeTypeFromStorageKey(input.storageKey)
  if (!mimeType?.startsWith('image/')) return null

  const ownedAsset = await findExactOwnedLegacyAsset(input)
  if (!ownedAsset) return null

  const media = await ensureMediaObjectFromStorageKey(input.storageKey, { mimeType })
  if (!isOwnedMediaRecord(media, input.storageKey, input.mediaType)) return null

  const result = await ownedAsset.attach(media.id)
  return result.count > 0 ? media : null
}

interface ExactOwnedLegacyAsset {
  attach(mediaId: string): Promise<{ count: number }>
}

async function findExactOwnedLegacyAsset(
  input: OwnedComfyMediaInput,
): Promise<ExactOwnedLegacyAsset | null> {
  const projectCharacterWhere = {
    imageUrl: input.storageKey,
    character: {
      novelPromotionProject: {
        projectId: input.projectId,
        project: { userId: input.userId },
      },
    },
  }
  const projectCharacter = await prisma.characterAppearance.findFirst({
    where: projectCharacterWhere,
    select: { id: true },
  })
  if (projectCharacter) {
    return {
      attach: async (mediaId) => await prisma.characterAppearance.updateMany({
        where: { id: projectCharacter.id, ...projectCharacterWhere },
        data: { imageMediaId: mediaId },
      }),
    }
  }

  const projectLocationWhere = {
    imageUrl: input.storageKey,
    location: {
      novelPromotionProject: {
        projectId: input.projectId,
        project: { userId: input.userId },
      },
    },
  }
  const projectLocation = await prisma.locationImage.findFirst({
    where: projectLocationWhere,
    select: { id: true },
  })
  if (projectLocation) {
    return {
      attach: async (mediaId) => await prisma.locationImage.updateMany({
        where: { id: projectLocation.id, ...projectLocationWhere },
        data: { imageMediaId: mediaId },
      }),
    }
  }

  const globalCharacterWhere = {
    imageUrl: input.storageKey,
    character: { userId: input.userId },
  }
  const globalCharacter = await prisma.globalCharacterAppearance.findFirst({
    where: globalCharacterWhere,
    select: { id: true },
  })
  if (globalCharacter) {
    return {
      attach: async (mediaId) => await prisma.globalCharacterAppearance.updateMany({
        where: { id: globalCharacter.id, ...globalCharacterWhere },
        data: { imageMediaId: mediaId },
      }),
    }
  }

  const globalLocationWhere = {
    imageUrl: input.storageKey,
    location: { userId: input.userId },
  }
  const globalLocation = await prisma.globalLocationImage.findFirst({
    where: globalLocationWhere,
    select: { id: true },
  })
  if (globalLocation) {
    return {
      attach: async (mediaId) => await prisma.globalLocationImage.updateMany({
        where: { id: globalLocation.id, ...globalLocationWhere },
        data: { imageMediaId: mediaId },
      }),
    }
  }

  return null
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
      { novelPromotionPanelCroppedImages: { some: storyboard } },
      { novelPromotionPanelUpscaledImages: { some: storyboard } },
      { novelPromotionStoryboardSheetImages: { some: episode } },
      { novelPromotionStoryboardUpscaledSheetImages: { some: episode } },
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
