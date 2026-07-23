import type { ComfyUploadedFile } from './types'
import { unwrapDirectorConfig } from './director-config-envelope'

export const LTX_DIRECTOR_TIMELINE_VERSION = 1 as const

export type LtxDirectorResolutionPreset = '480p' | '720p' | '1080p'
export type LtxDirectorDisplayMode = 'seconds' | 'frames'
export type LtxDirectorMainSegmentType = 'image' | 'video' | 'text'
export type LtxDirectorMotionSourceType = 'image' | 'video'
export type LtxDirectorResizeMethod =
  | 'maintain aspect ratio'
  | 'stretch to fit'
  | 'pad'
  | 'pad green'
  | 'crop'

export interface LtxDirectorTimelineSegmentSpec {
  id?: string
  type?: LtxDirectorMainSegmentType
  panelId?: string
  sourcePanelId?: string
  sourceMediaId?: string
  sourceImageUrl?: string
  sourceUrl?: string
  filename?: string
  prompt: string
  startSeconds?: number
  durationSeconds: number
  trimStartSeconds?: number
  mediaDurationSeconds?: number
  linkedAudio?: boolean
  guideStrength?: number
  isEndFrame?: boolean
}

export interface LtxDirectorMotionSegmentSpec {
  id?: string
  sourceType?: LtxDirectorMotionSourceType
  sourceMediaId: string
  sourceUrl?: string
  filename?: string
  startSeconds: number
  durationSeconds: number
  trimStartSeconds?: number
  videoStrength?: number
  videoAttentionStrength?: number
  resampleMode?: string
}

export interface LtxDirectorAudioSegmentSpec {
  id?: string
  sourceMediaId: string
  sourceUrl?: string
  filename?: string
  startSeconds: number
  durationSeconds: number
  trimStartSeconds?: number
}

export interface LtxDirectorTimelineSpec {
  version: typeof LTX_DIRECTOR_TIMELINE_VERSION
  fps: number
  globalPrompt: string
  videoModel?: string
  aspectRatio?: string
  resolutionPreset?: LtxDirectorResolutionPreset
  rangeStartSeconds?: number
  rangeEndSeconds?: number
  displayMode?: LtxDirectorDisplayMode
  resizeMethod?: LtxDirectorResizeMethod
  divisibleBy?: 8 | 16 | 32 | 64
  imageCompression?: number
  epsilon?: number
  showFilenames?: boolean
  propHeight?: number
  globalPropHeight?: number
  mainTrackEnabled?: boolean
  audioTrackEnabled?: boolean
  motionTrackEnabled?: boolean
  useCustomAudio?: boolean
  inpaintAudio?: boolean
  useCustomMotion?: boolean
  overrideAudio?: boolean
  motionSegments?: LtxDirectorMotionSegmentSpec[]
  audioSegments?: LtxDirectorAudioSegmentSpec[]
  retakeEnabled?: boolean
  retakeVideoMediaId?: string
  retakeVideoUrl?: string
  retakeStartSeconds?: number
  retakeDurationSeconds?: number
  retakePrompt?: string
  retakeStrength?: number
  segments: LtxDirectorTimelineSegmentSpec[]
}

export interface RenderedLtxDirectorTimeline {
  timelineData: string
  localPrompts: string
  segmentLengths: string
  guideStrength: string
  durationSeconds: number
  durationFrames: number
  startSecond: number
  endSecond: number
  startFrame: number
  endFrame: number
  fullDurationSeconds: number
  fullDurationFrames: number
  width: number
  height: number
  displayMode: LtxDirectorDisplayMode
  resizeMethod: LtxDirectorResizeMethod
  divisibleBy: 8 | 16 | 32 | 64
  imageCompression: number
  epsilon?: number
  useCustomAudio: boolean
  inpaintAudio: boolean
  useCustomMotion: boolean
  overrideAudio: boolean
}

interface LtxDirectorPortableExport {
  version: 1
  settings: Record<string, unknown>
  global_prompt: string
  retake_global_prompt: string
  timeline: Record<string, unknown>
  waoowaoo: LtxDirectorTimelineSpec
}

function mainSegmentType(value: unknown): LtxDirectorMainSegmentType {
  return value === 'video' || value === 'text' ? value : 'image'
}

function motionSourceType(value: unknown): LtxDirectorMotionSourceType {
  return value === 'image' ? 'image' : 'video'
}

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function cleanPrompt(value: unknown) {
  return typeof value === 'string' ? value.trim().replaceAll('|', '｜') : ''
}

export function normalizeLtxDirectorGlobalPrompt(value: unknown) {
  const prompt = cleanPrompt(value)
  if (!prompt.startsWith('{')) return prompt
  let depth = 0
  let quoted = false
  let escaped = false
  let objectEnd = -1
  for (let index = 0; index < prompt.length; index += 1) {
    const char = prompt[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quoted) {
      escaped = true
      continue
    }
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (quoted) continue
    if (char === '{') depth += 1
    if (char === '}') depth -= 1
    if (depth === 0) {
      objectEnd = index
      break
    }
  }
  if (objectEnd < 0) return prompt
  try {
    const metadata = JSON.parse(prompt.slice(0, objectEnd + 1)) as Record<string, unknown>
    const readable = [
      metadata.sceneKey,
      metadata.incomingContinuity,
      metadata.outgoingContinuity,
      metadata.summary,
      metadata.description,
      prompt.slice(objectEnd + 1),
    ].filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
    return [...new Set(readable)].join('\n')
  } catch {
    return prompt
  }
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function resolutionPreset(value: unknown): LtxDirectorResolutionPreset | undefined {
  return value === '480p' || value === '720p' || value === '1080p' ? value : undefined
}

function displayMode(value: unknown): LtxDirectorDisplayMode | undefined {
  return value === 'seconds' || value === 'frames' ? value : undefined
}

function resizeMethod(value: unknown): LtxDirectorResizeMethod | undefined {
  if (value === 'crop to fit') return 'crop'
  if (value === 'pad to fit') return 'pad'
  return value === 'maintain aspect ratio' || value === 'crop'
    || value === 'pad' || value === 'pad green' || value === 'stretch to fit'
    ? value : undefined
}

function divisibleBy(value: unknown): 8 | 16 | 32 | 64 | undefined {
  return value === 8 || value === 16 || value === 32 || value === 64 ? value : undefined
}

function boundedNumber(value: unknown, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : undefined
}

function convertUpstreamTimelineExport(raw: Record<string, unknown>) {
  if (!raw.timeline || typeof raw.timeline !== 'object' || Array.isArray(raw.timeline)) return raw
  const timeline = raw.timeline as Record<string, unknown>
  const settings = raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)
    ? raw.settings as Record<string, unknown>
    : {}
  const fps = positiveNumber(settings.frame_rate) ? settings.frame_rate : 24
  const fromFrame = (value: unknown) => nonNegativeNumber(value) ? value / fps : 0
  const sourceSegments = Array.isArray(timeline.segments) ? timeline.segments : []
  const sourceMotion = Array.isArray(timeline.motionSegments) ? timeline.motionSegments : []
  const sourceAudio = Array.isArray(timeline.audioSegments) ? timeline.audioSegments : []
  return {
    version: LTX_DIRECTOR_TIMELINE_VERSION,
    fps,
    globalPrompt: typeof raw.global_prompt === 'string'
      ? raw.global_prompt
      : typeof timeline.global_prompt === 'string' ? timeline.global_prompt : '',
    displayMode: settings.display_mode,
    resizeMethod: settings.resize_method,
    divisibleBy: settings.divisible_by,
    imageCompression: settings.img_compression,
    epsilon: settings.epsilon,
    showFilenames: timeline.showFilenames,
    propHeight: timeline.propHeight,
    globalPropHeight: timeline.globalPropHeight,
    mainTrackEnabled: timeline.mainTrackEnabled,
    audioTrackEnabled: timeline.audioTrackEnabled,
    motionTrackEnabled: timeline.motionTrackEnabled,
    useCustomAudio: settings.use_custom_audio,
    inpaintAudio: timeline.inpaint_audio ?? settings.inpaint_audio,
    useCustomMotion: settings.use_custom_motion,
    overrideAudio: timeline.overrideAudio ?? settings.override_audio,
    retakeEnabled: timeline.retakeMode,
    retakeVideoMediaId: timeline.retakeVideo && typeof timeline.retakeVideo === 'object'
      ? (timeline.retakeVideo as Record<string, unknown>).sourceMediaId : undefined,
    retakeVideoUrl: timeline.retakeVideo && typeof timeline.retakeVideo === 'object'
      ? (timeline.retakeVideo as Record<string, unknown>).imageFile : undefined,
    retakeStartSeconds: fromFrame(timeline.retakeStart),
    retakeDurationSeconds: fromFrame(timeline.retakeLength),
    retakePrompt: timeline.retakePrompt,
    retakeStrength: timeline.retakeStrength,
    rangeStartSeconds: fromFrame(timeline.normalStartFrame),
    rangeEndSeconds: nonNegativeNumber(timeline.normalDurationFrames)
      ? fromFrame(timeline.normalStartFrame) + fromFrame(timeline.normalDurationFrames)
      : undefined,
    segments: sourceSegments.flatMap((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const segment = item as Record<string, unknown>
      const type = mainSegmentType(segment.type)
      const sourceMediaId = typeof segment.sourceMediaId === 'string' ? segment.sourceMediaId : undefined
      const sourcePanelId = typeof segment.sourcePanelId === 'string' ? segment.sourcePanelId : undefined
      const hasOwnedSource = Boolean(sourceMediaId || sourcePanelId)
      return [{
        id: typeof segment.id === 'string' ? segment.id : `imported-${index + 1}`,
        type: hasOwnedSource ? type : 'text',
        ...(sourceMediaId ? { sourceMediaId } : {}),
        ...(sourcePanelId ? { sourcePanelId } : {}),
        ...(sourceMediaId && typeof segment.imageFile === 'string'
          ? type === 'video' ? { sourceUrl: segment.imageFile } : { sourceImageUrl: segment.imageFile }
          : {}),
        ...(typeof segment.fileName === 'string' ? { filename: segment.fileName } : {}),
        prompt: typeof segment.prompt === 'string' ? segment.prompt : '',
        startSeconds: fromFrame(segment.start),
        durationSeconds: Math.max(1 / fps, fromFrame(segment.length)),
        trimStartSeconds: fromFrame(segment.trimStart),
        mediaDurationSeconds: positiveNumber(segment.videoDurationFrames)
          ? segment.videoDurationFrames / fps : undefined,
        linkedAudio: typeof segment.linkedAudio === 'boolean' ? segment.linkedAudio : undefined,
        guideStrength: boundedNumber(segment.guideStrength, 0, 2),
        isEndFrame: segment.isEndFrame === true,
      }]
    }),
    motionSegments: sourceMotion.flatMap((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const segment = item as Record<string, unknown>
      if (typeof segment.sourceMediaId !== 'string') return []
      return [{
        id: typeof segment.id === 'string' ? segment.id : `imported-motion-${index + 1}`,
        sourceType: segment.isStaticImage === true ? 'image' : 'video',
        sourceMediaId: segment.sourceMediaId,
        sourceUrl: typeof segment.videoFile === 'string' ? segment.videoFile : undefined,
        filename: typeof segment.fileName === 'string' ? segment.fileName : undefined,
        startSeconds: fromFrame(segment.start),
        durationSeconds: Math.max(1 / fps, fromFrame(segment.length)),
        trimStartSeconds: fromFrame(segment.trimStart),
        videoStrength: boundedNumber(segment.videoStrength, 0, 2),
        videoAttentionStrength: boundedNumber(segment.videoAttentionStrength, 0, 2),
        resampleMode: typeof segment.resampleMode === 'string' ? segment.resampleMode : undefined,
      }]
    }),
    audioSegments: sourceAudio.flatMap((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const segment = item as Record<string, unknown>
      if (typeof segment.sourceMediaId !== 'string') return []
      return [{
        id: typeof segment.id === 'string' ? segment.id : `imported-audio-${index + 1}`,
        sourceMediaId: segment.sourceMediaId,
        sourceUrl: typeof segment.audioFile === 'string' ? segment.audioFile : undefined,
        filename: typeof segment.fileName === 'string' ? segment.fileName : undefined,
        startSeconds: fromFrame(segment.start),
        durationSeconds: Math.max(1 / fps, fromFrame(segment.length)),
        trimStartSeconds: fromFrame(segment.trimStart),
      }]
    }),
  }
}

function parseMotionSegments(value: unknown): LtxDirectorMotionSegmentSpec[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const candidate = item as Record<string, unknown>
    if (typeof candidate.sourceMediaId !== 'string' || !candidate.sourceMediaId.trim()
      || !nonNegativeNumber(candidate.startSeconds) || !positiveNumber(candidate.durationSeconds)) return []
    return [{
      ...(typeof candidate.id === 'string' && candidate.id.trim() ? { id: candidate.id.trim() } : {}),
      sourceType: motionSourceType(candidate.sourceType),
      sourceMediaId: candidate.sourceMediaId.trim(),
      ...(typeof candidate.sourceUrl === 'string' && candidate.sourceUrl.trim()
        ? { sourceUrl: candidate.sourceUrl.trim() } : {}),
      ...(typeof candidate.filename === 'string' && candidate.filename.trim()
        ? { filename: candidate.filename.trim() } : {}),
      startSeconds: candidate.startSeconds,
      durationSeconds: candidate.durationSeconds,
      ...(nonNegativeNumber(candidate.trimStartSeconds)
        ? { trimStartSeconds: candidate.trimStartSeconds } : {}),
      ...(boundedNumber(candidate.videoStrength, 0, 2) !== undefined
        ? { videoStrength: boundedNumber(candidate.videoStrength, 0, 2) } : {}),
      ...(boundedNumber(candidate.videoAttentionStrength, 0, 2) !== undefined
        ? { videoAttentionStrength: boundedNumber(candidate.videoAttentionStrength, 0, 2) } : {}),
      ...(typeof candidate.resampleMode === 'string' && candidate.resampleMode.trim()
        ? { resampleMode: candidate.resampleMode.trim() } : {}),
    }]
  })
}

function parseAudioSegments(value: unknown): LtxDirectorAudioSegmentSpec[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const candidate = item as Record<string, unknown>
    if (typeof candidate.sourceMediaId !== 'string' || !candidate.sourceMediaId.trim()
      || !nonNegativeNumber(candidate.startSeconds) || !positiveNumber(candidate.durationSeconds)) return []
    return [{
      ...(typeof candidate.id === 'string' && candidate.id.trim() ? { id: candidate.id.trim() } : {}),
      sourceMediaId: candidate.sourceMediaId.trim(),
      ...(typeof candidate.sourceUrl === 'string' && candidate.sourceUrl.trim()
        ? { sourceUrl: candidate.sourceUrl.trim() } : {}),
      ...(typeof candidate.filename === 'string' && candidate.filename.trim()
        ? { filename: candidate.filename.trim() } : {}),
      startSeconds: candidate.startSeconds,
      durationSeconds: candidate.durationSeconds,
      ...(nonNegativeNumber(candidate.trimStartSeconds)
        ? { trimStartSeconds: candidate.trimStartSeconds } : {}),
    }]
  })
}

export function resolveLtxDirectorDimensions(
  preset: LtxDirectorResolutionPreset = '720p',
  aspectRatio = '16:9',
) {
  const match = aspectRatio.trim().match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/)
  const ratioWidth = match ? Number(match[1]) : 16
  const ratioHeight = match ? Number(match[2]) : 9
  const ratio = ratioWidth > 0 && ratioHeight > 0 ? ratioWidth / ratioHeight : 16 / 9
  const shortEdge = preset === '480p' ? 480 : preset === '1080p' ? 1080 : 720
  if (ratio >= 1) {
    return {
      width: Math.max(2, Math.round((shortEdge * ratio) / 2) * 2),
      height: shortEdge,
    }
  }
  return {
    width: shortEdge,
    height: Math.max(2, Math.round((shortEdge / ratio) / 2) * 2),
  }
}

export function resolveLtxDirectorAspectRatioFromDimensions(
  width: unknown,
  height: unknown,
  fallback = '16:9',
) {
  if (!positiveNumber(width) || !positiveNumber(height) || width === height) return fallback
  return width > height ? '16:9' : '9:16'
}

export function parseLtxDirectorTimelineSpec(value: unknown): LtxDirectorTimelineSpec | null {
  try {
    const unwrapped = unwrapDirectorConfig(value, 'ltx')
    const raw = typeof unwrapped === 'string'
      ? JSON.parse(unwrapped) as Record<string, unknown>
      : unwrapped as Record<string, unknown>
    const parsed = raw?.waoowaoo && typeof raw.waoowaoo === 'object' && !Array.isArray(raw.waoowaoo)
      ? raw.waoowaoo as Record<string, unknown>
      : convertUpstreamTimelineExport(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (parsed.version !== LTX_DIRECTOR_TIMELINE_VERSION || !positiveNumber(parsed.fps)
      || typeof parsed.globalPrompt !== 'string' || !Array.isArray(parsed.segments)) return null
    const segments = parsed.segments.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const candidate = item as Record<string, unknown>
      if (!positiveNumber(candidate.durationSeconds)) return []
      const guideStrength = typeof candidate.guideStrength === 'number'
        && Number.isFinite(candidate.guideStrength)
        && candidate.guideStrength >= 0
        && candidate.guideStrength <= 2
        ? candidate.guideStrength
        : undefined
      return [{
        ...(typeof candidate.id === 'string' && candidate.id.trim()
          ? { id: candidate.id.trim() }
          : {}),
        type: mainSegmentType(candidate.type),
        ...(typeof candidate.panelId === 'string' && candidate.panelId.trim()
          ? { panelId: candidate.panelId.trim() }
          : {}),
        ...(typeof candidate.sourcePanelId === 'string' && candidate.sourcePanelId.trim()
          ? { sourcePanelId: candidate.sourcePanelId.trim() }
          : {}),
        ...(typeof candidate.sourceMediaId === 'string' && candidate.sourceMediaId.trim()
          ? { sourceMediaId: candidate.sourceMediaId.trim() }
          : {}),
        ...(typeof candidate.sourceImageUrl === 'string' && candidate.sourceImageUrl.trim()
          ? { sourceImageUrl: candidate.sourceImageUrl.trim() }
          : {}),
        ...(typeof candidate.sourceUrl === 'string' && candidate.sourceUrl.trim()
          ? { sourceUrl: candidate.sourceUrl.trim() }
          : {}),
        ...(typeof candidate.filename === 'string' && candidate.filename.trim()
          ? { filename: candidate.filename.trim() }
          : {}),
        prompt: cleanPrompt(candidate.prompt),
        ...(nonNegativeNumber(candidate.startSeconds) ? { startSeconds: candidate.startSeconds } : {}),
        durationSeconds: candidate.durationSeconds,
        ...(nonNegativeNumber(candidate.trimStartSeconds)
          ? { trimStartSeconds: candidate.trimStartSeconds } : {}),
        ...(positiveNumber(candidate.mediaDurationSeconds)
          ? { mediaDurationSeconds: candidate.mediaDurationSeconds } : {}),
        ...(typeof candidate.linkedAudio === 'boolean' ? { linkedAudio: candidate.linkedAudio } : {}),
        ...(guideStrength !== undefined ? { guideStrength } : {}),
        ...(candidate.isEndFrame === true ? { isEndFrame: true } : {}),
      }]
    })
    if (segments.length === 0 && parsed.retakeEnabled !== true) return null
    const parsedResolutionPreset = resolutionPreset(parsed.resolutionPreset)
    const parsedDisplayMode = displayMode(parsed.displayMode)
    const parsedResizeMethod = resizeMethod(parsed.resizeMethod)
    const parsedDivisibleBy = divisibleBy(parsed.divisibleBy)
    const parsedImageCompression = nonNegativeNumber(parsed.imageCompression)
      ? Math.min(100, parsed.imageCompression)
      : undefined
    const parsedEpsilon = boundedNumber(parsed.epsilon, 0.000001, 1)
    return {
      version: LTX_DIRECTOR_TIMELINE_VERSION,
      fps: parsed.fps,
      globalPrompt: normalizeLtxDirectorGlobalPrompt(parsed.globalPrompt),
      ...(typeof parsed.videoModel === 'string' && parsed.videoModel.trim()
        ? { videoModel: parsed.videoModel.trim() }
        : {}),
      ...(typeof parsed.aspectRatio === 'string' && parsed.aspectRatio.trim()
        ? { aspectRatio: parsed.aspectRatio.trim() }
        : {}),
      ...(parsedResolutionPreset
        ? { resolutionPreset: parsedResolutionPreset }
        : {}),
      ...(nonNegativeNumber(parsed.rangeStartSeconds)
        ? { rangeStartSeconds: parsed.rangeStartSeconds }
        : {}),
      ...(positiveNumber(parsed.rangeEndSeconds)
        ? { rangeEndSeconds: parsed.rangeEndSeconds }
        : {}),
      ...(parsedDisplayMode ? { displayMode: parsedDisplayMode } : {}),
      ...(parsedResizeMethod ? { resizeMethod: parsedResizeMethod } : {}),
      ...(parsedDivisibleBy ? { divisibleBy: parsedDivisibleBy } : {}),
      ...(parsedImageCompression !== undefined ? { imageCompression: parsedImageCompression } : {}),
      ...(parsedEpsilon !== undefined ? { epsilon: parsedEpsilon } : {}),
      ...(typeof parsed.showFilenames === 'boolean' ? { showFilenames: parsed.showFilenames } : {}),
      ...(positiveNumber(parsed.propHeight) ? { propHeight: parsed.propHeight } : {}),
      ...(positiveNumber(parsed.globalPropHeight) ? { globalPropHeight: parsed.globalPropHeight } : {}),
      ...(typeof parsed.mainTrackEnabled === 'boolean' ? { mainTrackEnabled: parsed.mainTrackEnabled } : {}),
      ...(typeof parsed.audioTrackEnabled === 'boolean' ? { audioTrackEnabled: parsed.audioTrackEnabled } : {}),
      ...(typeof parsed.motionTrackEnabled === 'boolean' ? { motionTrackEnabled: parsed.motionTrackEnabled } : {}),
      ...(typeof parsed.useCustomAudio === 'boolean' ? { useCustomAudio: parsed.useCustomAudio } : {}),
      ...(typeof parsed.inpaintAudio === 'boolean' ? { inpaintAudio: parsed.inpaintAudio } : {}),
      ...(typeof parsed.useCustomMotion === 'boolean' ? { useCustomMotion: parsed.useCustomMotion } : {}),
      ...(typeof parsed.overrideAudio === 'boolean' ? { overrideAudio: parsed.overrideAudio } : {}),
      motionSegments: parseMotionSegments(parsed.motionSegments),
      audioSegments: parseAudioSegments(parsed.audioSegments),
      ...(parsed.retakeEnabled === true ? { retakeEnabled: true } : {}),
      ...(typeof parsed.retakeVideoMediaId === 'string' && parsed.retakeVideoMediaId.trim()
        ? { retakeVideoMediaId: parsed.retakeVideoMediaId.trim() } : {}),
      ...(typeof parsed.retakeVideoUrl === 'string' && parsed.retakeVideoUrl.trim()
        ? { retakeVideoUrl: parsed.retakeVideoUrl.trim() } : {}),
      ...(nonNegativeNumber(parsed.retakeStartSeconds)
        ? { retakeStartSeconds: parsed.retakeStartSeconds } : {}),
      ...(positiveNumber(parsed.retakeDurationSeconds)
        ? { retakeDurationSeconds: parsed.retakeDurationSeconds } : {}),
      ...(typeof parsed.retakePrompt === 'string' ? { retakePrompt: cleanPrompt(parsed.retakePrompt) } : {}),
      ...(boundedNumber(parsed.retakeStrength, 0, 2) !== undefined
        ? { retakeStrength: boundedNumber(parsed.retakeStrength, 0, 2) } : {}),
      segments,
    }
  } catch {
    return null
  }
}

export function createLtxDirectorTimelineExport(spec: LtxDirectorTimelineSpec): LtxDirectorPortableExport {
  const fps = spec.fps
  const toFrame = (seconds: number | undefined) => Math.max(0, Math.round((seconds ?? 0) * fps))
  const timeline = {
    mainTrackEnabled: spec.mainTrackEnabled !== false,
    audioTrackEnabled: spec.audioTrackEnabled === true,
    motionTrackEnabled: spec.motionTrackEnabled !== false,
    propHeight: spec.propHeight ?? 90,
    globalPropHeight: spec.globalPropHeight ?? 60,
    showFilenames: spec.showFilenames !== false,
    overrideAudio: spec.overrideAudio === true,
    inpaint_audio: spec.inpaintAudio !== false,
    global_prompt: spec.globalPrompt,
    retake_global_prompt: spec.retakePrompt || spec.globalPrompt,
    retakeMode: spec.retakeEnabled === true,
    retakeStart: toFrame(spec.retakeStartSeconds),
    retakeLength: toFrame(spec.retakeDurationSeconds),
    retakePrompt: spec.retakePrompt ?? '',
    retakeStrength: spec.retakeStrength ?? 1,
    retakeVideo: spec.retakeVideoMediaId ? {
      fileName: spec.retakeVideoMediaId,
      imageFile: spec.retakeVideoUrl ?? '',
      videoDurationFrames: toFrame(spec.retakeDurationSeconds),
    } : null,
    normalStartFrame: toFrame(spec.rangeStartSeconds),
    normalDurationFrames: spec.rangeEndSeconds === undefined
      ? toFrame(Math.max(0, ...spec.segments.map((segment) => (
          (segment.startSeconds ?? 0) + segment.durationSeconds
        ))))
      : toFrame(spec.rangeEndSeconds - (spec.rangeStartSeconds ?? 0)),
    segments: spec.segments.map((segment, index) => ({
      id: segment.id || `waoowaoo-${index + 1}`,
      type: segment.type ?? 'image',
      start: toFrame(segment.startSeconds),
      length: Math.max(1, toFrame(segment.durationSeconds)),
      trimStart: toFrame(segment.trimStartSeconds),
      videoDurationFrames: toFrame(segment.mediaDurationSeconds),
      prompt: segment.prompt,
      guideStrength: segment.guideStrength ?? 1,
      isEndFrame: segment.isEndFrame === true,
      fileName: segment.filename ?? '',
      imageFile: segment.sourceUrl || segment.sourceImageUrl || '',
      sourceMediaId: segment.sourceMediaId,
      sourcePanelId: segment.sourcePanelId || segment.panelId,
      linkedAudio: segment.linkedAudio,
    })),
    motionSegments: (spec.motionSegments ?? []).map((segment, index) => ({
      id: segment.id || `waoowaoo-motion-${index + 1}`,
      type: 'motion_video',
      isStaticImage: segment.sourceType === 'image',
      start: toFrame(segment.startSeconds),
      length: Math.max(1, toFrame(segment.durationSeconds)),
      trimStart: toFrame(segment.trimStartSeconds),
      videoDurationFrames: Math.max(1, toFrame(segment.durationSeconds)),
      videoFile: segment.sourceUrl ?? '',
      fileName: segment.filename ?? '',
      sourceMediaId: segment.sourceMediaId,
      videoStrength: segment.videoStrength ?? 1,
      videoAttentionStrength: segment.videoAttentionStrength ?? 0.65,
      resampleMode: segment.resampleMode ?? 'nearest',
    })),
    audioSegments: (spec.audioSegments ?? []).map((segment, index) => ({
      id: segment.id || `waoowaoo-audio-${index + 1}`,
      type: 'audio',
      start: toFrame(segment.startSeconds),
      length: Math.max(1, toFrame(segment.durationSeconds)),
      trimStart: toFrame(segment.trimStartSeconds),
      audioDurationFrames: Math.max(1, toFrame(segment.durationSeconds)),
      audioFile: segment.sourceUrl ?? '',
      fileName: segment.filename ?? '',
      sourceMediaId: segment.sourceMediaId,
    })),
  }
  return {
    version: 1,
    settings: {
      frame_rate: fps,
      display_mode: spec.displayMode ?? 'seconds',
      epsilon: spec.epsilon ?? 0.001,
      custom_width: resolveLtxDirectorDimensions(spec.resolutionPreset, spec.aspectRatio).width,
      custom_height: resolveLtxDirectorDimensions(spec.resolutionPreset, spec.aspectRatio).height,
      resize_method: spec.resizeMethod ?? 'maintain aspect ratio',
      divisible_by: spec.divisibleBy ?? 32,
      img_compression: spec.imageCompression ?? 18,
      use_custom_audio: spec.useCustomAudio === true,
      use_custom_motion: spec.useCustomMotion !== false,
      inpaint_audio: spec.inpaintAudio !== false,
      override_audio: spec.overrideAudio === true,
    },
    global_prompt: spec.globalPrompt,
    retake_global_prompt: spec.retakePrompt || spec.globalPrompt,
    timeline,
    waoowaoo: spec,
  }
}

function uploadedImagePath(file: ComfyUploadedFile) {
  const subfolder = file.subfolder.replace(/^\/+|\/+$/g, '')
  if (!subfolder || file.name.startsWith(`${subfolder}/`)) return file.name
  return `${subfolder}/${file.name}`
}

export function renderLtxDirectorTimeline(input: {
  files: ComfyUploadedFile[]
  mainVideoFiles?: ComfyUploadedFile[]
  motionFiles?: ComfyUploadedFile[]
  motionImageFiles?: ComfyUploadedFile[]
  audioFiles?: ComfyUploadedFile[]
  retakeFile?: ComfyUploadedFile
  promptValue: unknown
  baseTimelineData?: unknown
  fallbackDurationSeconds?: number
  fallbackFps?: number
}): RenderedLtxDirectorTimeline {
  const fps = positiveNumber(input.fallbackFps) ? input.fallbackFps : 24
  const fallbackDuration = positiveNumber(input.fallbackDurationSeconds)
    ? input.fallbackDurationSeconds
    : 5
  const parsed = parseLtxDirectorTimelineSpec(input.promptValue)
  const expectedImageCount = parsed?.segments.filter((segment) => (segment.type ?? 'image') === 'image').length
  const expectedVideoCount = parsed?.segments.filter((segment) => segment.type === 'video').length
  const mediaCountsMatch = parsed
    ? expectedImageCount === input.files.length && expectedVideoCount === (input.mainVideoFiles?.length ?? 0)
    : false
  const sourceSegments: LtxDirectorTimelineSegmentSpec[] = mediaCountsMatch
    ? parsed!.segments
    : input.files.map(() => ({
      type: 'image',
      prompt: cleanPrompt(input.promptValue),
      durationSeconds: fallbackDuration / Math.max(1, input.files.length),
    }))
  const effectiveFps = parsed?.fps ?? fps
  let cursor = 0
  let imageIndex = 0
  let videoIndex = 0
  const positioned = sourceSegments.map((source) => {
    const type = source.type ?? 'image'
    const file = type === 'image'
      ? input.files[imageIndex++]
      : type === 'video'
        ? input.mainVideoFiles?.[videoIndex++]
        : undefined
    const length = Math.max(1, Math.round(source.durationSeconds * effectiveFps))
    const requestedStart = source.startSeconds === undefined
      ? cursor
      : Math.max(0, Math.round(source.startSeconds * effectiveFps))
    const start = Math.max(cursor, requestedStart)
    cursor = start + length
    return { file, source, length, start, type }
  })
  const segments = positioned.map(({ file, source, length, start, type }, index) => {
    const segment = {
      id: source.id || `waoowaoo-${index + 1}`,
      start,
      length,
      prompt: source.prompt,
      type,
      ...(file ? { imageFile: uploadedImagePath(file) } : {}),
      ...(source.filename ? { fileName: source.filename } : {}),
      ...(type === 'video' ? {
        trimStart: Math.round((source.trimStartSeconds ?? 0) * effectiveFps),
        videoDurationFrames: Math.max(1, Math.round((source.mediaDurationSeconds ?? source.durationSeconds) * effectiveFps)),
      } : {}),
      ...(source.isEndFrame && type === 'image' ? { isEndFrame: true } : {}),
    }
    return segment
  })
  const motionSegments = parsed?.motionSegments ?? []
  const audioSegments = parsed?.audioSegments ?? []
  const auxiliaryEndFrame = [...motionSegments, ...audioSegments].reduce((latest, segment) => Math.max(
    latest,
    Math.round((segment.startSeconds + segment.durationSeconds) * effectiveFps),
  ), 0)
  const requestedRetakeEndFrame = parsed?.retakeEnabled
    ? Math.round(((parsed.retakeStartSeconds ?? 0) + (parsed.retakeDurationSeconds ?? fallbackDuration)) * effectiveFps)
    : 0
  const fullDurationFrames = Math.max(1, cursor, auxiliaryEndFrame, requestedRetakeEndFrame)
  const requestedStartFrame = parsed?.rangeStartSeconds === undefined
    ? 0
    : Math.round(parsed.rangeStartSeconds * effectiveFps)
  const startFrame = Math.min(fullDurationFrames - 1, Math.max(0, requestedStartFrame))
  const requestedEndFrame = parsed?.rangeEndSeconds === undefined
    ? fullDurationFrames
    : Math.round(parsed.rangeEndSeconds * effectiveFps)
  const endFrame = Math.min(fullDurationFrames, Math.max(startFrame + 1, requestedEndFrame))
  const durationFrames = endFrame - startFrame
  const durationSeconds = durationFrames / effectiveFps
  const activeSegments = positioned.filter(({ start, length }) => (
    start < endFrame && start + length > startFrame
  ))
  const activeLengths: number[] = []
  let activeCursor = startFrame
  let pendingGap = 0
  for (const { start, length } of activeSegments) {
    const effectiveStart = Math.max(start, startFrame)
    if (effectiveStart > activeCursor) {
      const gap = effectiveStart - activeCursor
      if (activeLengths.length > 0) activeLengths[activeLengths.length - 1]! += gap
      else pendingGap += gap
    }
    const clippedEnd = Math.min(start + length, endFrame)
    activeLengths.push(Math.max(1, clippedEnd - effectiveStart + pendingGap))
    pendingGap = 0
    activeCursor = Math.max(activeCursor, clippedEnd)
  }
  if (activeLengths.length > 0 && activeCursor < endFrame) {
    activeLengths[activeLengths.length - 1]! += endFrame - activeCursor
  }
  const preset = parsed?.resolutionPreset ?? '720p'
  const dimensions = resolveLtxDirectorDimensions(preset, parsed?.aspectRatio ?? '16:9')
  const effectiveDisplayMode = parsed?.displayMode ?? 'seconds'
  const effectiveResizeMethod = parsed?.resizeMethod ?? 'maintain aspect ratio'
  const effectiveDivisibleBy = parsed?.divisibleBy ?? 32
  const effectiveImageCompression = parsed?.imageCompression ?? 18
  const hasLinkedMainAudio = positioned.some(({ source }) => source.type === 'video' && source.linkedAudio !== false)
  const useCustomAudio = parsed?.useCustomAudio ?? (audioSegments.length > 0 || hasLinkedMainAudio)
  const inpaintAudio = parsed?.inpaintAudio ?? true
  const useCustomMotion = parsed?.useCustomMotion ?? true
  const overrideAudio = parsed?.overrideAudio ?? false
  let baseTimeline: Record<string, unknown> = {}
  try {
    const candidate = typeof input.baseTimelineData === 'string'
      ? JSON.parse(input.baseTimelineData) as unknown
      : input.baseTimelineData
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      baseTimeline = candidate as Record<string, unknown>
    }
  } catch {
    baseTimeline = {}
  }
  let motionVideoIndex = 0
  let motionImageIndex = 0
  const renderedMotionSegments = motionSegments.map((segment, index) => {
    const isStaticImage = segment.sourceType === 'image'
    const file = isStaticImage
      ? input.motionImageFiles?.[motionImageIndex++]
      : input.motionFiles?.[motionVideoIndex++]
    return {
      id: segment.id || `waoowaoo-motion-${index + 1}`,
      type: 'motion_video',
      isStaticImage,
      start: Math.round(segment.startSeconds * effectiveFps),
      length: Math.max(1, Math.round(segment.durationSeconds * effectiveFps)),
      trimStart: Math.round((segment.trimStartSeconds ?? 0) * effectiveFps),
      videoDurationFrames: Math.max(1, Math.round(segment.durationSeconds * effectiveFps)),
      videoFile: file ? uploadedImagePath(file) : '',
      fileName: segment.filename ?? file?.name ?? '',
      videoStrength: segment.videoStrength ?? 1,
      videoAttentionStrength: segment.videoAttentionStrength ?? 0.65,
      resampleMode: segment.resampleMode ?? 'nearest',
    }
  })
  const retakeMode = parsed?.retakeEnabled === true && Boolean(input.retakeFile)
  const retakeStart = Math.round((parsed?.retakeStartSeconds ?? 0) * effectiveFps)
  const retakeLength = Math.round((parsed?.retakeDurationSeconds ?? durationSeconds) * effectiveFps)
  const retakeEnd = retakeStart + retakeLength
  const retakeParts = retakeMode
    ? [
        { start: startFrame, end: Math.min(endFrame, retakeStart), prompt: parsed?.globalPrompt ?? '', strength: 0 },
        { start: Math.max(startFrame, retakeStart), end: Math.min(endFrame, retakeEnd), prompt: parsed?.retakePrompt || 'video', strength: parsed?.retakeStrength ?? 1 },
        { start: Math.max(startFrame, retakeEnd), end: endFrame, prompt: parsed?.globalPrompt ?? '', strength: 0 },
      ].filter((part) => part.end > part.start)
    : []
  return {
    timelineData: JSON.stringify({
      ...baseTimeline,
      mainTrackEnabled: parsed?.mainTrackEnabled ?? baseTimeline.mainTrackEnabled !== false,
      audioTrackEnabled: parsed?.audioTrackEnabled ?? baseTimeline.audioTrackEnabled === true,
      motionTrackEnabled: parsed?.motionTrackEnabled ?? baseTimeline.motionTrackEnabled !== false,
      propHeight: parsed?.propHeight ?? baseTimeline.propHeight ?? 90,
      globalPropHeight: parsed?.globalPropHeight ?? baseTimeline.globalPropHeight ?? 60,
      showFilenames: parsed?.showFilenames ?? baseTimeline.showFilenames !== false,
      overrideAudio,
      inpaint_audio: inpaintAudio,
      global_prompt: parsed?.globalPrompt ?? cleanPrompt(input.promptValue),
      retake_global_prompt: parsed?.retakePrompt || parsed?.globalPrompt || cleanPrompt(input.promptValue),
      retakeMode,
      retakeStart,
      retakeLength,
      retakePrompt: parsed?.retakePrompt ?? '',
      retakeStrength: parsed?.retakeStrength ?? 1,
      retakeVideo: input.retakeFile ? {
        fileName: parsed?.retakeVideoMediaId ?? input.retakeFile.name,
        imageFile: uploadedImagePath(input.retakeFile),
      } : null,
      normalStartFrame: startFrame,
      normalDurationFrames: durationFrames,
      segments,
      motionSegments: renderedMotionSegments,
      audioSegments: [
        ...positioned.flatMap(({ source, start, length, file }, index) => (
          source.type === 'video' && source.linkedAudio !== false && file
            ? [{
                id: `${source.id || `waoowaoo-${index + 1}`}_audio`,
                type: 'audio',
                start,
                length,
                trimStart: Math.round((source.trimStartSeconds ?? 0) * effectiveFps),
                audioDurationFrames: Math.max(1, Math.round((source.mediaDurationSeconds ?? source.durationSeconds) * effectiveFps)),
                audioFile: uploadedImagePath(file),
                fileName: source.filename ?? file.name,
              }]
            : []
        )),
        ...audioSegments.map((segment, index) => ({
        id: segment.id || `waoowaoo-audio-${index + 1}`,
        type: 'audio',
        start: Math.round(segment.startSeconds * effectiveFps),
        length: Math.max(1, Math.round(segment.durationSeconds * effectiveFps)),
        trimStart: Math.round((segment.trimStartSeconds ?? 0) * effectiveFps),
        audioDurationFrames: Math.max(1, Math.round(segment.durationSeconds * effectiveFps)),
        audioFile: input.audioFiles?.[index] ? uploadedImagePath(input.audioFiles[index]!) : '',
        fileName: segment.filename ?? input.audioFiles?.[index]?.name ?? '',
        })),
      ],
    }),
    localPrompts: retakeMode
      ? retakeParts.map((part) => part.prompt).join('|')
      : activeSegments.map(({ source }) => source.prompt).join('|'),
    segmentLengths: retakeMode
      ? retakeParts.map((part) => part.end - part.start).join(',')
      : activeLengths.join(','),
    guideStrength: retakeMode
      ? retakeParts.map((part) => String(part.strength)).join(',')
      : activeSegments.filter(({ type }) => type !== 'text')
        .map(({ source }) => String(source.guideStrength ?? 1)).join(','),
    durationSeconds,
    durationFrames,
    startSecond: startFrame / effectiveFps,
    endSecond: endFrame / effectiveFps,
    startFrame,
    endFrame,
    fullDurationSeconds: fullDurationFrames / effectiveFps,
    fullDurationFrames,
    ...dimensions,
    displayMode: effectiveDisplayMode,
    resizeMethod: effectiveResizeMethod,
    divisibleBy: effectiveDivisibleBy,
    imageCompression: effectiveImageCompression,
    ...(parsed?.epsilon !== undefined ? { epsilon: parsed.epsilon } : {}),
    useCustomAudio,
    inpaintAudio,
    useCustomMotion,
    overrideAudio,
  }
}
