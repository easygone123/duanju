import type { Prisma } from '@prisma/client'

import { prisma } from '@/lib/prisma'

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
  const project = { project: { is: { id: input.projectId, userId: input.userId } } }
  const promotion = { novelPromotionProject: { is: project } }
  const episode = { episode: { is: { novelPromotionProject: { is: project } } } }
  const storyboard = { storyboard: { is: episode } }
  const where: Prisma.MediaObjectWhereInput = {
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
  const record = await store.findFirst({
    where,
    select: { id: true },
  })
  return record !== null
}
