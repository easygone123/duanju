import type { ComfyUploadedFile } from './types'

export const LTX_DIRECTOR_TIMELINE_VERSION = 1 as const

export type LtxDirectorResolutionPreset = '480p' | '720p' | '1080p'

export interface LtxDirectorTimelineSegmentSpec {
  id?: string
  panelId?: string
  sourcePanelId?: string
  sourceMediaId?: string
  sourceImageUrl?: string
  prompt: string
  startSeconds?: number
  durationSeconds: number
  guideStrength?: number
  isEndFrame?: boolean
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

export function parseLtxDirectorTimelineSpec(value: unknown): LtxDirectorTimelineSpec | null {
  try {
    const parsed = typeof value === 'string'
      ? JSON.parse(value) as Record<string, unknown>
      : value as Record<string, unknown>
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
        prompt: cleanPrompt(candidate.prompt),
        ...(nonNegativeNumber(candidate.startSeconds) ? { startSeconds: candidate.startSeconds } : {}),
        durationSeconds: candidate.durationSeconds,
        ...(guideStrength !== undefined ? { guideStrength } : {}),
        ...(candidate.isEndFrame === true ? { isEndFrame: true } : {}),
      }]
    })
    if (segments.length === 0) return null
    const parsedResolutionPreset = resolutionPreset(parsed.resolutionPreset)
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
      segments,
    }
  } catch {
    return null
  }
}

function uploadedImagePath(file: ComfyUploadedFile) {
  const subfolder = file.subfolder.replace(/^\/+|\/+$/g, '')
  if (!subfolder || file.name.startsWith(`${subfolder}/`)) return file.name
  return `${subfolder}/${file.name}`
}

export function renderLtxDirectorTimeline(input: {
  files: ComfyUploadedFile[]
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
  const sourceSegments: LtxDirectorTimelineSegmentSpec[] = parsed?.segments.length === input.files.length
    ? parsed.segments
    : input.files.map(() => ({
      prompt: cleanPrompt(input.promptValue),
      durationSeconds: fallbackDuration / Math.max(1, input.files.length),
    }))
  const effectiveFps = parsed?.fps ?? fps
  let cursor = 0
  const positioned = input.files.map((file, index) => {
    const source = sourceSegments[index]!
    const length = Math.max(1, Math.round(source.durationSeconds * effectiveFps))
    const requestedStart = source.startSeconds === undefined
      ? cursor
      : Math.max(0, Math.round(source.startSeconds * effectiveFps))
    const start = Math.max(cursor, requestedStart)
    cursor = start + length
    return { file, source, length, start }
  })
  const segments = positioned.map(({ file, source, length, start }, index) => {
    const segment = {
      id: `waoowaoo-${index + 1}`,
      start,
      length,
      prompt: source.prompt,
      type: 'image',
      imageFile: uploadedImagePath(file),
      ...(source.isEndFrame ? { isEndFrame: true } : {}),
    }
    return segment
  })
  const fullDurationFrames = Math.max(1, cursor)
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
  return {
    timelineData: JSON.stringify({
      ...baseTimeline,
      mainTrackEnabled: baseTimeline.mainTrackEnabled !== false,
      audioTrackEnabled: baseTimeline.audioTrackEnabled === true,
      motionTrackEnabled: baseTimeline.motionTrackEnabled !== false,
      global_prompt: parsed?.globalPrompt ?? cleanPrompt(input.promptValue),
      retakeMode: false,
      retakeVideo: null,
      normalStartFrame: startFrame,
      normalDurationFrames: durationFrames,
      segments,
      motionSegments: [],
      audioSegments: [],
    }),
    localPrompts: activeSegments.map(({ source }) => source.prompt).join('|'),
    segmentLengths: activeLengths.join(','),
    guideStrength: activeSegments.map(({ source }) => String(source.guideStrength ?? 1)).join(','),
    durationSeconds,
    durationFrames,
    startSecond: startFrame / effectiveFps,
    endSecond: endFrame / effectiveFps,
    startFrame,
    endFrame,
    fullDurationSeconds: fullDurationFrames / effectiveFps,
    fullDurationFrames,
    ...dimensions,
  }
}
