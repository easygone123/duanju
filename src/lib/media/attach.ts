import { decodeImageUrlsFromDb } from '@/lib/contracts/image-urls-contract'
import {
  createReadOnlyMediaResolver,
  resolveMediaRef,
  resolveMediaRefFromLegacyValue,
  type MediaResolveCandidate,
  type ReadOnlyMediaResolver,
} from './service'
import type { MediaRef } from './types'

function parseStringArray(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

async function resolveAppearanceImageArray(raw: unknown, fieldName: string): Promise<{ urls: string[]; medias: MediaRef[] }> {
  const values = decodeImageUrlsFromDb(raw as string | null | undefined, fieldName)
  const refs = await Promise.all(values.map((value) => resolveMediaRefFromLegacyValue(value)))
  return {
    urls: values.map((value, index) => refs[index]?.url || value),
    medias: refs.filter((ref): ref is MediaRef => !!ref),
  }
}

async function attachMediaFieldsToAppearance<T extends Record<string, unknown>>(appearance: T) {
  const imageMedia = await resolveMediaRef(appearance.imageMediaId, appearance.imageUrl)
  const previousImageMedia = await resolveMediaRef(appearance.previousImageMediaId, appearance.previousImageUrl)
  const imageResult = await resolveAppearanceImageArray(appearance.imageUrls, 'appearance.imageUrls')
  const previousImageResult = await resolveAppearanceImageArray(appearance.previousImageUrls, 'appearance.previousImageUrls')

  return {
    ...appearance,
    imageMedia,
    media: imageMedia,
    previousImageMedia,
    imageMedias: imageResult.medias,
    previousImageMedias: previousImageResult.medias,
    imageUrl: imageMedia?.url || appearance.imageUrl || null,
    previousImageUrl: previousImageMedia?.url || appearance.previousImageUrl || null,
    imageUrls: imageResult.urls,
    previousImageUrls: previousImageResult.urls,
  }
}

export async function attachMediaFieldsToGlobalCharacter<T extends Record<string, unknown>>(character: T) {
  const customVoiceMedia = await resolveMediaRef(character.customVoiceMediaId, character.customVoiceUrl)
  const appearances = await Promise.all(
    ((character.appearances as Array<Record<string, unknown>>) || []).map(attachMediaFieldsToAppearance),
  )

  return {
    ...character,
    media: customVoiceMedia,
    customVoiceMedia,
    customVoiceUrl: customVoiceMedia?.url || character.customVoiceUrl || null,
    appearances,
  }
}

export async function attachMediaFieldsToGlobalLocation<T extends Record<string, unknown>>(location: T) {
  const images = await Promise.all(
    ((location.images as Array<Record<string, unknown>>) || []).map(async (img) => {
    const imageMedia = await resolveMediaRef(img.imageMediaId, img.imageUrl)
    const previousImageMedia = await resolveMediaRef(img.previousImageMediaId, img.previousImageUrl)
    return {
      ...img,
      media: imageMedia,
      imageMedia,
      previousImageMedia,
      imageUrl: imageMedia?.url || img.imageUrl || null,
      previousImageUrl: previousImageMedia?.url || img.previousImageUrl || null,
    }
    }),
  )

  return {
    ...location,
    images,
  }
}

export async function attachMediaFieldsToGlobalVoice<T extends Record<string, unknown>>(voice: T) {
  const customVoiceMedia = await resolveMediaRef(voice.customVoiceMediaId, voice.customVoiceUrl)
  return {
    ...voice,
    media: customVoiceMedia,
    customVoiceMedia,
    customVoiceUrl: customVoiceMedia?.url || voice.customVoiceUrl || null,
  }
}

const defaultMediaResolver: ReadOnlyMediaResolver = {
  resolve: resolveMediaRef,
  resolveLegacy: resolveMediaRefFromLegacyValue,
}

async function attachMediaFieldsToPanel<T extends Record<string, unknown>>(
  panel: T,
  resolver: ReadOnlyMediaResolver = defaultMediaResolver,
) {
  const imageMedia = await resolver.resolve(panel.imageMediaId, panel.imageUrl)
  const videoMedia = await resolver.resolve(panel.videoMediaId, panel.videoUrl)
  const lipSyncVideoMedia = await resolver.resolve(panel.lipSyncVideoMediaId, panel.lipSyncVideoUrl)
  const sketchImageMedia = await resolver.resolve(panel.sketchImageMediaId, panel.sketchImageUrl)
  const previousImageMedia = await resolver.resolve(panel.previousImageMediaId, panel.previousImageUrl)
  const croppedImageMedia = await resolver.resolve(panel.croppedImageMediaId, panel.croppedImageUrl)
  const upscaledImageMedia = await resolver.resolve(panel.upscaledImageMediaId, panel.upscaledImageUrl)

  const candidateRaw = parseStringArray(panel.candidateImages)
  const candidateMediaUrls: string[] = []
  for (const candidate of candidateRaw) {
    if (candidate.startsWith('PENDING:')) {
      candidateMediaUrls.push(candidate)
      continue
    }
    const media = await resolver.resolveLegacy(candidate)
    candidateMediaUrls.push(media?.url || candidate)
  }

  return {
    ...panel,
    media: imageMedia,
    imageMedia,
    videoMedia,
    lipSyncVideoMedia,
    sketchImageMedia,
    previousImageMedia,
    croppedImageMedia,
    upscaledImageMedia,
    imageUrl: imageMedia?.url || panel.imageUrl || null,
    videoUrl: videoMedia?.url || panel.videoUrl || null,
    lipSyncVideoUrl: lipSyncVideoMedia?.url || panel.lipSyncVideoUrl || null,
    sketchImageUrl: sketchImageMedia?.url || panel.sketchImageUrl || null,
    previousImageUrl: previousImageMedia?.url || panel.previousImageUrl || null,
    croppedImageUrl: croppedImageMedia?.url || panel.croppedImageUrl || null,
    upscaledImageUrl: upscaledImageMedia?.url || panel.upscaledImageUrl || null,
    candidateImages: candidateRaw.length > 0 ? JSON.stringify(candidateMediaUrls) : panel.candidateImages,
  }
}

async function attachMediaFieldsToStoryboard<T extends Record<string, unknown>>(
  storyboard: T,
  resolver: ReadOnlyMediaResolver = defaultMediaResolver,
) {
  const storyboardImageMedia = await resolver.resolveLegacy(storyboard.storyboardImageUrl)
  const sheetImageMedia = await resolver.resolve(storyboard.sheetImageMediaId, storyboard.sheetImageUrl)
  const upscaledSheetImageMedia = await resolver.resolve(
    storyboard.upscaledSheetImageMediaId,
    storyboard.upscaledSheetImageUrl,
  )
  const directorVideoMedia = await resolver.resolve(
    storyboard.directorVideoMediaId,
    storyboard.directorVideoUrl,
  )
  const panels = await Promise.all(
    ((storyboard.panels as Array<Record<string, unknown>>) || []).map((panel) => (
      attachMediaFieldsToPanel(panel, resolver)
    )),
  )

  return {
    ...storyboard,
    media: storyboardImageMedia,
    storyboardImageMedia,
    sheetImageMedia,
    upscaledSheetImageMedia,
    directorVideoMedia,
    storyboardImageUrl: storyboardImageMedia?.url || storyboard.storyboardImageUrl || null,
    sheetImageUrl: sheetImageMedia?.url || storyboard.sheetImageUrl || null,
    upscaledSheetImageUrl: upscaledSheetImageMedia?.url || storyboard.upscaledSheetImageUrl || null,
    directorVideoUrl: directorVideoMedia?.url || storyboard.directorVideoUrl || null,
    panels,
  }
}

function collectStageMediaCandidates(projectLike: Record<string, unknown>): MediaResolveCandidate[] {
  const candidates: MediaResolveCandidate[] = []
  const storyboards = (projectLike.storyboards as Array<Record<string, unknown>>) || []
  for (const storyboard of storyboards) {
    candidates.push(
      { legacyValue: storyboard.storyboardImageUrl },
      { mediaId: storyboard.sheetImageMediaId, legacyValue: storyboard.sheetImageUrl },
      { mediaId: storyboard.upscaledSheetImageMediaId, legacyValue: storyboard.upscaledSheetImageUrl },
      { mediaId: storyboard.directorVideoMediaId, legacyValue: storyboard.directorVideoUrl },
    )
    for (const panel of (storyboard.panels as Array<Record<string, unknown>>) || []) {
      candidates.push(
        { mediaId: panel.imageMediaId, legacyValue: panel.imageUrl },
        { mediaId: panel.videoMediaId, legacyValue: panel.videoUrl },
        { mediaId: panel.lipSyncVideoMediaId, legacyValue: panel.lipSyncVideoUrl },
        { mediaId: panel.sketchImageMediaId, legacyValue: panel.sketchImageUrl },
        { mediaId: panel.previousImageMediaId, legacyValue: panel.previousImageUrl },
        { mediaId: panel.croppedImageMediaId, legacyValue: panel.croppedImageUrl },
        { mediaId: panel.upscaledImageMediaId, legacyValue: panel.upscaledImageUrl },
      )
      for (const candidate of parseStringArray(panel.candidateImages)) {
        if (!candidate.startsWith('PENDING:')) candidates.push({ legacyValue: candidate })
      }
    }
  }
  return candidates
}

export async function attachMediaFieldsToStagePayload<T extends Record<string, unknown>>(projectLike: T) {
  const resolver = await createReadOnlyMediaResolver(collectStageMediaCandidates(projectLike))
  const storyboards = await Promise.all(
    ((projectLike.storyboards as Array<Record<string, unknown>>) || []).map((storyboard) => (
      attachMediaFieldsToStoryboard(storyboard, resolver)
    )),
  )
  return { ...projectLike, storyboards }
}

async function attachMediaFieldsToProjectCharacter<T extends Record<string, unknown>>(character: T) {
  const customVoiceMedia = await resolveMediaRef(character.customVoiceMediaId, character.customVoiceUrl)
  const appearances = await Promise.all(
    ((character.appearances as Array<Record<string, unknown>>) || []).map(attachMediaFieldsToAppearance),
  )
  return {
    ...character,
    media: customVoiceMedia,
    customVoiceMedia,
    customVoiceUrl: customVoiceMedia?.url || character.customVoiceUrl || null,
    appearances,
  }
}

async function attachMediaFieldsToProjectLocation<T extends Record<string, unknown>>(location: T) {
  const images = await Promise.all(
    ((location.images as Array<Record<string, unknown>>) || []).map(async (img) => {
    const imageMedia = await resolveMediaRef(img.imageMediaId, img.imageUrl)
    const previousImageMedia = await resolveMediaRef(img.previousImageMediaId, img.previousImageUrl)
    return {
      ...img,
      media: imageMedia,
      imageMedia,
      previousImageMedia,
      imageUrl: imageMedia?.url || img.imageUrl || null,
      previousImageUrl: previousImageMedia?.url || img.previousImageUrl || null,
    }
    }),
  )

  return {
    ...location,
    images,
  }
}

async function attachMediaFieldsToProjectProp<T extends Record<string, unknown>>(prop: T) {
  return await attachMediaFieldsToProjectLocation(prop)
}

async function attachMediaFieldsToShot<T extends Record<string, unknown>>(shot: T) {
  const imageMedia = await resolveMediaRef(shot.imageMediaId, shot.imageUrl)
  const videoMedia = await resolveMediaRefFromLegacyValue(shot.videoUrl)
  return {
    ...shot,
    media: imageMedia,
    imageMedia,
    videoMedia,
    imageUrl: imageMedia?.url || shot.imageUrl || null,
    videoUrl: videoMedia?.url || shot.videoUrl || null,
  }
}

async function attachMediaFieldsToVoiceLine<T extends Record<string, unknown>>(line: T) {
  const audioMedia = await resolveMediaRef(line.audioMediaId, line.audioUrl)
  return {
    ...line,
    media: audioMedia,
    audioMedia,
    audioUrl: audioMedia?.url || line.audioUrl || null,
  }
}

export async function attachMediaFieldsToProject<T extends Record<string, unknown>>(projectLike: T) {
  const audioMedia = await resolveMediaRef(projectLike.audioMediaId, projectLike.audioUrl)
  const characters = await Promise.all(
    ((projectLike.characters as Array<Record<string, unknown>>) || []).map(attachMediaFieldsToProjectCharacter),
  )
  const locations = await Promise.all(
    ((projectLike.locations as Array<Record<string, unknown>>) || []).map(attachMediaFieldsToProjectLocation),
  )
  const props = await Promise.all(
    ((projectLike.props as Array<Record<string, unknown>>) || []).map(attachMediaFieldsToProjectProp),
  )
  const shots = await Promise.all(
    ((projectLike.shots as Array<Record<string, unknown>>) || []).map(attachMediaFieldsToShot),
  )
  const storyboards = await Promise.all(
    ((projectLike.storyboards as Array<Record<string, unknown>>) || []).map((storyboard) => (
      attachMediaFieldsToStoryboard(storyboard)
    )),
  )
  const voiceLines = await Promise.all(
    ((projectLike.voiceLines as Array<Record<string, unknown>>) || []).map(attachMediaFieldsToVoiceLine),
  )

  return {
    ...projectLike,
    media: audioMedia,
    audioMedia,
    audioUrl: audioMedia?.url || projectLike.audioUrl || null,
    characters,
    locations,
    props,
    shots,
    storyboards,
    voiceLines,
  }
}

export function firstMediaUrl(list: MediaRef[]): string[] {
  return list.map((m) => m.url)
}
