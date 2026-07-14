import fs from 'node:fs/promises'
import path from 'node:path'

import {
  VIRAL_ANALYSIS_BATCH_SIZE,
  VIRAL_MAX_ANALYSIS_FRAMES,
} from './constants'
import {
  defaultCommandRunner,
  detectSceneTimestamps,
  extractEmbeddedSubtitles,
  extractFrame,
  probeVideo,
  type CommandRunner,
  type VideoMetadata,
} from './ffmpeg'
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

export interface PreprocessViralVideoResult {
  metadata: VideoMetadata
  shots: PreprocessedViralShot[]
  transcriptText: string | null
}

export interface PreprocessViralVideoOptions {
  sourcePath: string
  outputDirectory: string
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

export async function preprocessViralVideo({
  sourcePath,
  outputDirectory,
  runner = defaultCommandRunner,
}: PreprocessViralVideoOptions): Promise<PreprocessViralVideoResult> {
  validateAbsolutePath(sourcePath, 'sourcePath')
  validateAbsolutePath(outputDirectory, 'outputDirectory')

  const metadata = await probeVideo(sourcePath, runner)
  validateViralVideoMetadata(metadata)
  const sceneTimestamps = await detectSceneTimestamps(sourcePath, runner)
  const shotRanges = buildShotRanges(metadata.durationMs, sceneTimestamps)

  await fs.mkdir(outputDirectory, { recursive: true })
  const shots: PreprocessedViralShot[] = []
  for (const [shotIndex, range] of shotRanges.entries()) {
    const framePath = path.join(outputDirectory, frameFilename(shotIndex))
    await extractFrame(sourcePath, framePath, range.representativeMs, runner)
    shots.push({ shotIndex, ...range, framePath })
  }

  const textSubtitle = metadata.subtitleStreams.find((stream) => stream.isText)
  const transcriptText = textSubtitle
    ? await extractEmbeddedSubtitles(sourcePath, textSubtitle.index, runner)
    : null

  return { metadata, shots, transcriptText }
}
