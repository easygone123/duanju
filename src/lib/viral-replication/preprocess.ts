import fs from 'node:fs/promises'
import path from 'node:path'

import {
  VIRAL_ANALYSIS_BATCH_SIZE,
  VIRAL_MAX_ANALYSIS_FRAMES,
} from './constants'
import {
  FfmpegBoundaryError,
  defaultCommandRunner,
  detectSceneTimestamps,
  extractEmbeddedSubtitles,
  extractAnalysisAudioSegment,
  extractFrame,
  probeVideo,
  type CommandRunner,
  type VideoMetadata,
} from './ffmpeg'
import {
  chunkViralAudioRanges,
  findViralTranscriptGaps,
  parseViralAudioCues,
  scoreViralTranscript,
  type ViralAudioRange,
} from './audio-timeline'
import { validateViralVideoMetadata } from './upload-validation'

export const VIRAL_FALLBACK_SHOT_INTERVAL_MS = 3_000

export interface ViralShotRange {
  startMs: number
  endMs: number
  representativeMs: number
}

export interface PreprocessedViralShot extends ViralShotRange {
  shotIndex: number
  framePath: string
}

export interface ViralReviewFrame {
  shotIndex: number
  position: 'opening' | 'closing'
  timestampMs: number
  framePath: string
}

export interface PreprocessViralVideoResult {
  metadata: VideoMetadata
  shots: PreprocessedViralShot[]
  transcriptText: string | null
  analysisAudioSegments: ViralAnalysisAudioSegment[]
  /** @deprecated Kept for older worker fixtures; production uses segments. */
  analysisAudioPath: string | null
}

export interface ViralAnalysisAudioSegment extends ViralAudioRange {
  audioPath: string
}

export interface PreprocessViralVideoOptions {
  sourcePath: string
  outputDirectory: string
  runner?: CommandRunner
}

export interface ExtractViralReviewFramesOptions {
  sourcePath: string
  outputDirectory: string
  videoStreamIndex: number
  shots: PreprocessedViralShot[]
  runner?: CommandRunner
}

function validateAbsolutePath(value: string, label: string): void {
  if (!value || value.includes('\0') || !path.isAbsolute(value)) {
    throw new TypeError(`${label} must be a non-empty absolute path without NUL bytes`)
  }
}

function normalizeSceneBoundaries(durationMs: number, timestampsMs: number[]): number[] {
  const unique = new Set<number>()
  for (const timestampMs of timestampsMs) {
    const rounded = Math.round(timestampMs)
    if (Number.isSafeInteger(rounded) && rounded > 0 && rounded < durationMs) unique.add(rounded)
  }
  return [...unique].sort((left, right) => left - right)
}

function fallbackBoundaries(durationMs: number): number[] {
  const boundaries: number[] = []
  for (
    let timestampMs = VIRAL_FALLBACK_SHOT_INTERVAL_MS;
    timestampMs < durationMs;
    timestampMs += VIRAL_FALLBACK_SHOT_INTERVAL_MS
  ) {
    boundaries.push(timestampMs)
  }
  return boundaries
}

function capBoundaries(boundaries: number[]): number[] {
  const rangeCount = boundaries.length - 1
  if (rangeCount <= VIRAL_MAX_ANALYSIS_FRAMES) return boundaries

  return Array.from({ length: VIRAL_MAX_ANALYSIS_FRAMES + 1 }, (_, sampleIndex) => {
    const sourceIndex = Math.round(
      (sampleIndex * rangeCount) / VIRAL_MAX_ANALYSIS_FRAMES,
    )
    return boundaries[sourceIndex]
  })
}

export function buildShotRanges(
  durationMs: number,
  sceneTimestampsMs: number[],
): ViralShotRange[] {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new TypeError('durationMs must be a positive safe integer')
  }

  let detectedBoundaries = normalizeSceneBoundaries(durationMs, sceneTimestampsMs)
  if (detectedBoundaries.length + 1 < 2) {
    detectedBoundaries = fallbackBoundaries(durationMs)
  }
  const boundaries = capBoundaries([0, ...detectedBoundaries, durationMs])

  return boundaries.slice(0, -1).map((startMs, index) => {
    const endMs = boundaries[index + 1]
    const representativeMs = index === 0
      ? startMs
      : startMs + Math.floor((endMs - startMs) / 2)
    return { startMs, endMs, representativeMs }
  })
}

export function buildAnalysisBatches<T>(items: readonly T[]): T[][] {
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += VIRAL_ANALYSIS_BATCH_SIZE) {
    batches.push(items.slice(index, index + VIRAL_ANALYSIS_BATCH_SIZE))
  }
  return batches
}

function frameFilename(shotIndex: number): string {
  return `shot-${shotIndex.toString().padStart(3, '0')}.jpg`
}

function audioSegmentFilename(segmentIndex: number): string {
  return `analysis-audio-${segmentIndex.toString().padStart(3, '0')}.mp3`
}

function compareTranscriptCandidates(
  left: { transcriptText: string; preferredOrder: number },
  right: { transcriptText: string; preferredOrder: number },
): number {
  const leftScore = scoreViralTranscript(left.transcriptText)
  const rightScore = scoreViralTranscript(right.transcriptText)
  return (
    rightScore.spanMs - leftScore.spanMs
    || rightScore.coveredMs - leftScore.coveredMs
    || rightScore.cueCount - leftScore.cueCount
    || rightScore.lastCueMs - leftScore.lastCueMs
    || rightScore.textChars - leftScore.textChars
    || left.preferredOrder - right.preferredOrder
  )
}

function reviewFrameFilename(shotIndex: number, position: ViralReviewFrame['position']): string {
  return `review-${shotIndex.toString().padStart(3, '0')}-${position}.jpg`
}

export function buildReviewFrameTimestamps(
  shot: Pick<PreprocessedViralShot, 'startMs' | 'endMs' | 'representativeMs'>,
): Array<{ position: ViralReviewFrame['position']; timestampMs: number }> {
  const durationMs = shot.endMs - shot.startMs
  if (durationMs < 200) return []
  const insetMs = Math.max(1, Math.floor(durationMs * 0.2))
  const openingMs = shot.startMs + insetMs
  const closingMs = shot.endMs - insetMs
  const candidates: Array<{
    position: ViralReviewFrame['position']
    timestampMs: number
  }> = [
    { position: 'opening', timestampMs: openingMs },
    { position: 'closing', timestampMs: closingMs },
  ]
  return candidates.filter(({ timestampMs }) => timestampMs !== shot.representativeMs)
}

export async function extractViralReviewFrames({
  sourcePath,
  outputDirectory,
  videoStreamIndex,
  shots,
  runner = defaultCommandRunner,
}: ExtractViralReviewFramesOptions): Promise<ViralReviewFrame[]> {
  validateAbsolutePath(sourcePath, 'sourcePath')
  validateAbsolutePath(outputDirectory, 'outputDirectory')
  if (!Number.isSafeInteger(videoStreamIndex) || videoStreamIndex < 0) {
    throw new TypeError('videoStreamIndex must be a non-negative safe integer')
  }

  const frames: ViralReviewFrame[] = []
  for (const shot of shots) {
    for (const candidate of buildReviewFrameTimestamps(shot)) {
      const framePath = path.join(
        outputDirectory,
        reviewFrameFilename(shot.shotIndex, candidate.position),
      )
      await extractFrame(
        sourcePath,
        framePath,
        candidate.timestampMs,
        videoStreamIndex,
        runner,
      )
      frames.push({
        shotIndex: shot.shotIndex,
        ...candidate,
        framePath,
      })
    }
  }
  return frames
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function preprocessViralVideo({
  sourcePath,
  outputDirectory,
  runner = defaultCommandRunner,
}: PreprocessViralVideoOptions): Promise<PreprocessViralVideoResult> {
  validateAbsolutePath(sourcePath, 'sourcePath')
  validateAbsolutePath(outputDirectory, 'outputDirectory')

  const metadata = await probeVideo(sourcePath, runner)
  validateViralVideoMetadata(metadata)
  const sceneTimestamps = await detectSceneTimestamps(
    sourcePath,
    metadata.videoStreamIndex,
    runner,
  )
  const shotRanges = buildShotRanges(metadata.durationMs, sceneTimestamps)

  await fs.mkdir(outputDirectory, { recursive: true })
  const shots: PreprocessedViralShot[] = []
  const invocationCreatedFramePaths: string[] = []
  try {
    for (const [shotIndex, range] of shotRanges.entries()) {
      const framePath = path.join(outputDirectory, frameFilename(shotIndex))
      const existedBeforeInvocation = await pathExists(framePath)
      await extractFrame(
        sourcePath,
        framePath,
        range.representativeMs,
        metadata.videoStreamIndex,
        runner,
      )
      if (!existedBeforeInvocation) invocationCreatedFramePaths.push(framePath)
      shots.push({ shotIndex, ...range, framePath })
    }
  } catch (error: unknown) {
    await Promise.allSettled(
      invocationCreatedFramePaths.map(async (framePath) => fs.rm(framePath, { force: true })),
    )
    throw error
  }

  const textSubtitles = metadata.subtitleStreams
    .filter((stream) => stream.isText)
    .sort((left, right) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1
      const leftHasLanguage = left.language !== null
      const rightHasLanguage = right.language !== null
      if (leftHasLanguage !== rightHasLanguage) return leftHasLanguage ? -1 : 1
      return left.index - right.index
    })
  const transcriptCandidates: Array<{
    transcriptText: string
    preferredOrder: number
  }> = []
  for (const [preferredOrder, subtitle] of textSubtitles.entries()) {
    try {
      const transcriptText = await extractEmbeddedSubtitles(sourcePath, subtitle.index, runner)
      if (transcriptText && parseViralAudioCues(transcriptText).length > 0) {
        transcriptCandidates.push({ transcriptText, preferredOrder })
      }
    } catch (error: unknown) {
      if (error instanceof FfmpegBoundaryError && error.code === 'COMMAND_FAILED') continue
      throw error
    }
  }
  transcriptCandidates.sort(compareTranscriptCandidates)
  const transcriptText = transcriptCandidates[0]?.transcriptText ?? null

  const analysisAudioSegments: ViralAnalysisAudioSegment[] = []
  const audioStream = metadata.audioStreams[0]
  if (audioStream) {
    const uncoveredRanges = findViralTranscriptGaps(transcriptText, metadata.durationMs)
    const audioRanges = chunkViralAudioRanges(uncoveredRanges)
    for (const [segmentIndex, range] of audioRanges.entries()) {
      const audioPath = path.join(outputDirectory, audioSegmentFilename(segmentIndex))
      await extractAnalysisAudioSegment(
        sourcePath,
        audioPath,
        audioStream.index,
        range.startMs,
        range.endMs,
        runner,
      )
      analysisAudioSegments.push({ ...range, audioPath })
    }
  }

  return {
    metadata,
    shots,
    transcriptText,
    analysisAudioSegments,
    analysisAudioPath: null,
  }
}
