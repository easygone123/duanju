import type { ComfyUploadedFile } from './types'

export const LTX_DIRECTOR_TIMELINE_VERSION = 1 as const

export interface LtxDirectorTimelineSegmentSpec {
  panelId?: string
  prompt: string
  durationSeconds: number
  guideStrength?: number
  isEndFrame?: boolean
}

export interface LtxDirectorTimelineSpec {
  version: typeof LTX_DIRECTOR_TIMELINE_VERSION
  fps: number
  globalPrompt: string
  videoModel?: string
  segments: LtxDirectorTimelineSegmentSpec[]
}

export interface RenderedLtxDirectorTimeline {
  timelineData: string
  localPrompts: string
  segmentLengths: string
  guideStrength: string
  durationSeconds: number
  durationFrames: number
}

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function cleanPrompt(value: unknown) {
  return typeof value === 'string' ? value.trim().replaceAll('|', '｜') : ''
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
        ...(typeof candidate.panelId === 'string' && candidate.panelId.trim()
          ? { panelId: candidate.panelId.trim() }
          : {}),
        prompt: cleanPrompt(candidate.prompt),
        durationSeconds: candidate.durationSeconds,
        ...(guideStrength !== undefined ? { guideStrength } : {}),
        ...(candidate.isEndFrame === true ? { isEndFrame: true } : {}),
      }]
    })
    if (segments.length === 0) return null
    return {
      version: LTX_DIRECTOR_TIMELINE_VERSION,
      fps: parsed.fps,
      globalPrompt: cleanPrompt(parsed.globalPrompt),
      ...(typeof parsed.videoModel === 'string' && parsed.videoModel.trim()
        ? { videoModel: parsed.videoModel.trim() }
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
  const frameLengths = sourceSegments.map((segment) => (
    Math.max(1, Math.round(segment.durationSeconds * effectiveFps))
  ))
  const segments = input.files.map((file, index) => {
    const length = frameLengths[index] ?? 1
    const source = sourceSegments[index]!
    const segment = {
      id: `waoowaoo-${index + 1}`,
      start: cursor,
      length,
      prompt: source.prompt,
      type: 'image',
      imageFile: uploadedImagePath(file),
      ...(source.isEndFrame ? { isEndFrame: true } : {}),
    }
    cursor += length
    return segment
  })
  const durationFrames = Math.max(1, cursor)
  const durationSeconds = durationFrames / effectiveFps
  return {
    timelineData: JSON.stringify({
      mainTrackEnabled: true,
      audioTrackEnabled: true,
      motionTrackEnabled: true,
      global_prompt: parsed?.globalPrompt ?? cleanPrompt(input.promptValue),
      segments,
      motionSegments: [],
      audioSegments: [],
    }),
    localPrompts: sourceSegments.map((segment) => segment.prompt).join('|'),
    segmentLengths: frameLengths.join(','),
    guideStrength: sourceSegments.map((segment) => String(segment.guideStrength ?? 1)).join(','),
    durationSeconds,
    durationFrames,
  }
}
