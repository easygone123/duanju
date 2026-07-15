import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'

export type CommandBinary = 'ffmpeg' | 'ffprobe'

export type CommandRunner = (
  binary: CommandBinary,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>

export type FfmpegBoundaryErrorCode =
  | 'BINARY_NOT_FOUND'
  | 'COMMAND_ABORTED'
  | 'COMMAND_FAILED'
  | 'COMMAND_OUTPUT_LIMIT'
  | 'COMMAND_SPAWN_FAILED'
  | 'COMMAND_TIMEOUT'
  | 'INVALID_COMMAND_INPUT'
  | 'FFPROBE_MALFORMED_JSON'
  | 'FFPROBE_NO_VIDEO'
  | 'FFPROBE_INVALID_VIDEO'
  | 'FFPROBE_INVALID_DURATION'
  | 'FRAME_ARTIFACT_INVALID'
  | 'FRAME_ARTIFACT_TOO_LARGE'
  | 'UNSUPPORTED_CONTAINER'
  | 'UNSUPPORTED_CONTAINER_BRAND'

export class FfmpegBoundaryError extends Error {
  readonly code: FfmpegBoundaryErrorCode

  constructor(code: FfmpegBoundaryErrorCode, message: string) {
    super(message)
    this.name = 'FfmpegBoundaryError'
    this.code = code
  }
}

export interface VideoStreamMetadata {
  index: number
  codecName: string | null
  durationMs: number | null
  width: number
  height: number
  isDefault: boolean
  isAttachedPic: boolean
}

export interface AudioStreamMetadata {
  index: number
  codecName: string | null
  channels: number | null
  sampleRate: number | null
}

export interface SubtitleStreamMetadata {
  index: number
  codecName: string | null
  language: string | null
  isText: boolean
  isDefault: boolean
}

export interface VideoMetadata {
  formatName: string
  majorBrand: string
  videoStreamIndex: number
  durationMs: number
  width: number
  height: number
  hasVideo: boolean
  hasAudio: boolean
  hasSubtitles: boolean
  videoStreams: VideoStreamMetadata[]
  audioStreams: AudioStreamMetadata[]
  subtitleStreams: SubtitleStreamMetadata[]
}

const DEFAULT_CAPTURE_LIMIT_BYTES = 1024 * 1024
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
export const MAX_SCENE_TIMESTAMPS = 288
export const MAX_FRAME_LONGEST_EDGE = 2_048
export const MAX_FRAME_PIXELS = MAX_FRAME_LONGEST_EDGE * MAX_FRAME_LONGEST_EDGE
export const MAX_FRAME_JPEG_BYTES = 8 * 1024 * 1024
const MAX_SCENE_TIMESTAMP_MS = 180_000
const MAX_SCENE_LINE_BUFFER_CHARS = 16_384

interface CommandChildProcess {
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: 'error', listener: (error: NodeJS.ErrnoException) => void): this
  once(
    event: 'close',
    listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
  ): this
}

export type CommandSpawn = (
  binary: CommandBinary,
  args: string[],
  options: {
    shell: false
    stdio: ['ignore', 'pipe', 'pipe']
    windowsHide: true
  },
) => CommandChildProcess

export interface CommandRunnerOptions {
  captureLimitBytes?: number
  timeoutMs?: number
  signal?: AbortSignal
  spawnImpl?: CommandSpawn
  onStderrChunk?: (chunk: Buffer) => void
  captureStderr?: boolean
}
export const ALLOWED_VIRAL_VIDEO_MAJOR_BRANDS: ReadonlySet<string> = new Set([
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'avc1',
  'M4V ',
  'qt  ',
])
const TEXT_SUBTITLE_CODECS = new Set([
  'ass',
  'mov_text',
  'ssa',
  'srt',
  'subrip',
  'text',
  'ttml',
  'webvtt',
])

function stringifyChunk(chunk: Buffer): string {
  return chunk.toString('utf8')
}

export function createCommandRunner(
  options: number | CommandRunnerOptions = {},
): CommandRunner {
  const {
    captureLimitBytes = DEFAULT_CAPTURE_LIMIT_BYTES,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    signal,
    spawnImpl = spawn as CommandSpawn,
    onStderrChunk,
    captureStderr = true,
  } = typeof options === 'number' ? { captureLimitBytes: options } : options
  if (!Number.isSafeInteger(captureLimitBytes) || captureLimitBytes <= 0) {
    throw new TypeError('captureLimitBytes must be a positive safe integer')
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive safe integer')
  }

  return async (binary, args) => await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new FfmpegBoundaryError(
        'COMMAND_ABORTED',
        `${binary} command was aborted before it started`,
      ))
      return
    }

    const child = spawnImpl(binary, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let killRequested = false
    let terminalError: FfmpegBoundaryError | null = null

    const recordTerminalError = (error: FfmpegBoundaryError) => {
      if (!terminalError) terminalError = error
    }

    const killOnce = () => {
      if (killRequested) return
      killRequested = true
      try {
        child.kill('SIGKILL')
      } catch {
        // The child may already have exited; close remains the settlement boundary.
      }
    }

    const failAndKill = (error: FfmpegBoundaryError) => {
      recordTerminalError(error)
      killOnce()
    }

    const capture = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      if (terminalError) return
      if (target === 'stderr' && onStderrChunk) {
        try {
          onStderrChunk(chunk)
        } catch (error: unknown) {
          const detail = error instanceof Error ? error.message : String(error)
          failAndKill(new FfmpegBoundaryError(
            'COMMAND_FAILED',
            `Unable to process ${binary} stderr: ${detail}`,
          ))
          return
        }
      }
      if (target === 'stderr' && !captureStderr) return
      const nextBytes = (target === 'stdout' ? stdoutBytes : stderrBytes) + chunk.length
      if (nextBytes > captureLimitBytes) {
        failAndKill(new FfmpegBoundaryError(
          'COMMAND_OUTPUT_LIMIT',
          `${binary} ${target} exceeded the ${captureLimitBytes}-byte capture limit`,
        ))
        return
      }

      if (target === 'stdout') {
        stdoutBytes = nextBytes
        stdoutChunks.push(chunk)
      } else {
        stderrBytes = nextBytes
        stderrChunks.push(chunk)
      }
    }

    child.stdout.on('data', (chunk: Buffer) => capture('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => capture('stderr', chunk))
    const onAbort = () => failAndKill(new FfmpegBoundaryError(
      'COMMAND_ABORTED',
      `${binary} command was aborted`,
    ))
    signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => failAndKill(new FfmpegBoundaryError(
      'COMMAND_TIMEOUT',
      `${binary} command exceeded the ${timeoutMs}-ms timeout`,
    )), timeoutMs)

    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        recordTerminalError(new FfmpegBoundaryError(
          'BINARY_NOT_FOUND',
          `Required binary "${binary}" is not available on PATH`,
        ))
        return
      }
      recordTerminalError(new FfmpegBoundaryError(
        'COMMAND_SPAWN_FAILED',
        `Unable to start ${binary}: ${error.message}`,
      ))
    })
    child.once('close', (exitCode, exitSignal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)

      if (terminalError) {
        reject(terminalError)
        return
      }
      const stdout = stdoutChunks.map(stringifyChunk).join('')
      const stderr = stderrChunks.map(stringifyChunk).join('')
      if (exitCode !== 0) {
        const reason = exitCode === null
          ? `signal ${exitSignal ?? 'unknown'}`
          : `exit code ${exitCode}`
        const detail = stderr.trim() || 'no stderr output'
        reject(new FfmpegBoundaryError(
          'COMMAND_FAILED',
          `${binary} failed with ${reason}: ${detail}`,
        ))
        return
      }

      resolve({ stdout, stderr })
    })
  })
}

export const defaultCommandRunner = createCommandRunner()

function assertAbsolutePath(value: string, label: string): void {
  if (!value || value.includes('\0') || !path.isAbsolute(value)) {
    throw new FfmpegBoundaryError(
      'INVALID_COMMAND_INPUT',
      `${label} must be a non-empty absolute path without NUL bytes`,
    )
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function streamIndex(stream: Record<string, unknown>): number | null {
  return Number.isSafeInteger(stream.index) && Number(stream.index) >= 0
    ? Number(stream.index)
    : null
}

function optionalPositiveInteger(value: unknown): number | null {
  const numeric = typeof value === 'string' ? Number(value) : value
  return Number.isSafeInteger(numeric) && Number(numeric) > 0 ? Number(numeric) : null
}

function optionalPositiveDurationMs(value: unknown): number | null {
  const durationSeconds = typeof value === 'string' || typeof value === 'number'
    ? Number(value)
    : Number.NaN
  const durationMs = Math.round(durationSeconds * 1_000)
  return Number.isFinite(durationSeconds)
    && durationSeconds > 0
    && Number.isSafeInteger(durationMs)
    && durationMs > 0
    ? durationMs
    : null
}

function dispositionFlag(disposition: Record<string, unknown> | null, key: string): boolean {
  return Number(disposition?.[key]) === 1
}

function assertStreamIndexValue(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new FfmpegBoundaryError(
      'INVALID_COMMAND_INPUT',
      `${label} must be a non-negative safe integer`,
    )
  }
}

function sampleSceneTimestamps(timestamps: Set<number>): number[] {
  const sorted = [...timestamps].sort((left, right) => left - right)
  if (sorted.length <= MAX_SCENE_TIMESTAMPS) return sorted

  return Array.from({ length: MAX_SCENE_TIMESTAMPS }, (_, sampleIndex) => {
    const sourceIndex = Math.round(
      (sampleIndex * (sorted.length - 1)) / (MAX_SCENE_TIMESTAMPS - 1),
    )
    return sorted[sourceIndex]
  })
}

const SCENE_TIMESTAMP_PATTERN = /\bpts_time:\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/gi

function addSceneTimestamps(text: string, timestamps: Set<number>): void {
  for (const match of text.matchAll(SCENE_TIMESTAMP_PATTERN)) {
    const timestampMs = Math.round(Number(match[1]) * 1_000)
    if (
      Number.isSafeInteger(timestampMs)
      && timestampMs >= 0
      && timestampMs <= MAX_SCENE_TIMESTAMP_MS
    ) {
      timestamps.add(timestampMs)
    }
  }
}

function sceneDetectionArgs(sourcePath: string, videoStreamIndex: number): string[] {
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'info',
    '-i', sourcePath,
    '-map', `0:${videoStreamIndex}`,
    '-an', '-sn',
    '-vf', 'select=gt(scene\\,0.3),showinfo',
    '-f', 'null',
    '-',
  ]
}

function createSceneTimestampCollector(): {
  push: (chunk: Buffer) => void
  finish: () => number[]
} {
  const decoder = new StringDecoder('utf8')
  const timestamps = new Set<number>()
  let pending = ''

  const consumeCompleteLines = () => {
    let lineEnd = pending.indexOf('\n')
    while (lineEnd >= 0) {
      const line = pending.slice(0, lineEnd)
      pending = pending.slice(lineEnd + 1)
      if (/Parsed_showinfo/i.test(line)) addSceneTimestamps(line, timestamps)
      lineEnd = pending.indexOf('\n')
    }
    if (pending.length > MAX_SCENE_LINE_BUFFER_CHARS) {
      pending = pending.slice(-MAX_SCENE_LINE_BUFFER_CHARS)
    }
  }

  return {
    push(chunk) {
      pending += decoder.write(chunk)
      consumeCompleteLines()
    },
    finish() {
      pending += decoder.end()
      if (/Parsed_showinfo/i.test(pending)) addSceneTimestamps(pending, timestamps)
      pending = ''
      return sampleSceneTimestamps(timestamps)
    },
  }
}

export function isSupportedMp4FormatName(formatName: string): boolean {
  const formatTokens = formatName
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
  return formatTokens.includes('mov') || formatTokens.includes('mp4')
}

export function isAllowedViralVideoMajorBrand(majorBrand: string): boolean {
  return ALLOWED_VIRAL_VIDEO_MAJOR_BRANDS.has(majorBrand)
}

export async function assertFfmpegAvailable(
  runner: CommandRunner = defaultCommandRunner,
): Promise<void> {
  await runner('ffmpeg', ['-version'])
  await runner('ffprobe', ['-version'])
}

export async function probeVideo(
  sourcePath: string,
  runner: CommandRunner = defaultCommandRunner,
): Promise<VideoMetadata> {
  assertAbsolutePath(sourcePath, 'sourcePath')
  const { stdout } = await runner('ffprobe', [
    '-v', 'error',
    '-show_entries',
    'format=format_name,duration:format_tags=major_brand:stream=index,codec_type,codec_name,duration,width,height,channels,sample_rate:stream_disposition=attached_pic,default:stream_tags=language',
    '-of', 'json',
    sourcePath,
  ])

  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new FfmpegBoundaryError('FFPROBE_MALFORMED_JSON', 'FFprobe returned malformed JSON')
  }

  const root = asRecord(parsed)
  const format = asRecord(root?.format)
  const formatTags = asRecord(format?.tags)
  const streams = Array.isArray(root?.streams) ? root.streams : []
  const formatName = optionalString(format?.format_name)
  const majorBrand = optionalString(formatTags?.major_brand)
  const durationSeconds = typeof format?.duration === 'string' || typeof format?.duration === 'number'
    ? Number(format.duration)
    : Number.NaN
  const durationMs = Math.round(durationSeconds * 1_000)

  if (!formatName || !isSupportedMp4FormatName(formatName)) {
    throw new FfmpegBoundaryError(
      'UNSUPPORTED_CONTAINER',
      `Unsupported video container: ${formatName ?? 'unknown'}`,
    )
  }
  if (!majorBrand || !isAllowedViralVideoMajorBrand(majorBrand)) {
    throw new FfmpegBoundaryError(
      'UNSUPPORTED_CONTAINER_BRAND',
      `Unsupported video container major brand: ${JSON.stringify(majorBrand)}`,
    )
  }
  if (
    !Number.isFinite(durationSeconds)
    || durationSeconds <= 0
    || !Number.isSafeInteger(durationMs)
    || durationMs <= 0
  ) {
    throw new FfmpegBoundaryError(
      'FFPROBE_INVALID_DURATION',
      'FFprobe returned an invalid or non-finite video duration',
    )
  }

  const streamRecords = streams.map(asRecord).filter((stream) => stream !== null)
  const videoRecords = streamRecords.filter((stream) => stream.codec_type === 'video')
  if (videoRecords.length === 0) {
    throw new FfmpegBoundaryError('FFPROBE_NO_VIDEO', 'Media does not contain a video stream')
  }

  const videoStreams = videoRecords.map((stream) => {
    const index = streamIndex(stream)
    const width = optionalPositiveInteger(stream.width)
    const height = optionalPositiveInteger(stream.height)
    const disposition = asRecord(stream.disposition)
    if (index === null || width === null || height === null) {
      throw new FfmpegBoundaryError(
        'FFPROBE_INVALID_VIDEO',
        'FFprobe returned invalid video stream metadata',
      )
    }
    return {
      index,
      codecName: optionalString(stream.codec_name),
      durationMs: optionalPositiveDurationMs(stream.duration),
      width,
      height,
      isDefault: dispositionFlag(disposition, 'default'),
      isAttachedPic: dispositionFlag(disposition, 'attached_pic'),
    }
  })

  const analyzableVideoStreams = videoStreams
    .filter((stream) => !stream.isAttachedPic)
    .sort((left, right) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1
      return left.index - right.index
    })
  if (analyzableVideoStreams.length === 0) {
    throw new FfmpegBoundaryError(
      'FFPROBE_NO_VIDEO',
      'Media does not contain an analyzable non-attached video stream',
    )
  }
  const primaryVideo = analyzableVideoStreams[0]
  if (primaryVideo.durationMs === null) {
    throw new FfmpegBoundaryError(
      'FFPROBE_INVALID_DURATION',
      'FFprobe returned an invalid duration for the selected video stream',
    )
  }

  const audioStreams = streamRecords
    .filter((stream) => stream.codec_type === 'audio')
    .flatMap((stream): AudioStreamMetadata[] => {
      const index = streamIndex(stream)
      if (index === null) return []
      return [{
        index,
        codecName: optionalString(stream.codec_name),
        channels: optionalPositiveInteger(stream.channels),
        sampleRate: optionalPositiveInteger(stream.sample_rate),
      }]
    })

  const subtitleStreams = streamRecords
    .filter((stream) => stream.codec_type === 'subtitle')
    .flatMap((stream): SubtitleStreamMetadata[] => {
      const index = streamIndex(stream)
      if (index === null) return []
      const codecName = optionalString(stream.codec_name)
      const tags = asRecord(stream.tags)
      const disposition = asRecord(stream.disposition)
      return [{
        index,
        codecName,
        language: optionalString(tags?.language),
        isText: codecName !== null && TEXT_SUBTITLE_CODECS.has(codecName.toLowerCase()),
        isDefault: dispositionFlag(disposition, 'default'),
      }]
    })

  return {
    formatName,
    majorBrand,
    videoStreamIndex: primaryVideo.index,
    durationMs: primaryVideo.durationMs,
    width: primaryVideo.width,
    height: primaryVideo.height,
    hasVideo: true,
    hasAudio: audioStreams.length > 0,
    hasSubtitles: subtitleStreams.length > 0,
    videoStreams,
    audioStreams,
    subtitleStreams,
  }
}

export async function detectSceneTimestamps(
  sourcePath: string,
  videoStreamIndex: number,
  runner: CommandRunner = defaultCommandRunner,
): Promise<number[]> {
  assertAbsolutePath(sourcePath, 'sourcePath')
  assertStreamIndexValue(videoStreamIndex, 'video stream index')
  if (runner === defaultCommandRunner) {
    return await detectSceneTimestampsFromProcess(sourcePath, videoStreamIndex)
  }
  const { stderr } = await runner('ffmpeg', sceneDetectionArgs(sourcePath, videoStreamIndex))
  const timestamps = new Set<number>()
  addSceneTimestamps(stderr, timestamps)

  return sampleSceneTimestamps(timestamps)
}

export async function detectSceneTimestampsFromProcess(
  sourcePath: string,
  videoStreamIndex: number,
  options: CommandRunnerOptions = {},
): Promise<number[]> {
  assertAbsolutePath(sourcePath, 'sourcePath')
  assertStreamIndexValue(videoStreamIndex, 'video stream index')
  const collector = createSceneTimestampCollector()
  const runner = createCommandRunner({
    ...options,
    captureStderr: false,
    onStderrChunk: collector.push,
  })
  await runner('ffmpeg', sceneDetectionArgs(sourcePath, videoStreamIndex))
  return collector.finish()
}

export async function extractFrame(
  sourcePath: string,
  outputPath: string,
  timestampMs: number,
  videoStreamIndex: number,
  runner: CommandRunner = defaultCommandRunner,
): Promise<void> {
  assertAbsolutePath(sourcePath, 'sourcePath')
  assertAbsolutePath(outputPath, 'outputPath')
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    throw new FfmpegBoundaryError(
      'INVALID_COMMAND_INPUT',
      'timestampMs must be a non-negative safe integer',
    )
  }
  assertStreamIndexValue(videoStreamIndex, 'video stream index')

  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${randomUUID()}.tmp.jpg`,
  )
  let published = false
  try {
    await runner('ffmpeg', [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
      '-ss', (timestampMs / 1_000).toFixed(3),
      '-i', sourcePath,
      '-map', `0:${videoStreamIndex}`,
      '-frames:v', '1',
      '-vf', `scale='min(iw,${MAX_FRAME_LONGEST_EDGE})':'min(ih,${MAX_FRAME_LONGEST_EDGE})':force_original_aspect_ratio=decrease:force_divisible_by=2`,
      '-q:v', '2',
      temporaryPath,
    ])

    let artifact: Awaited<ReturnType<typeof fs.lstat>>
    try {
      artifact = await fs.lstat(temporaryPath)
    } catch {
      throw new FfmpegBoundaryError(
        'FRAME_ARTIFACT_INVALID',
        'FFmpeg did not produce a frame artifact',
      )
    }
    if (!artifact.isFile() || artifact.size <= 0) {
      throw new FfmpegBoundaryError(
        'FRAME_ARTIFACT_INVALID',
        'FFmpeg produced an empty or non-regular frame artifact',
      )
    }
    if (artifact.size > MAX_FRAME_JPEG_BYTES) {
      throw new FfmpegBoundaryError(
        'FRAME_ARTIFACT_TOO_LARGE',
        `FFmpeg frame artifact exceeds ${MAX_FRAME_JPEG_BYTES} bytes`,
      )
    }

    await fs.rename(temporaryPath, outputPath)
    published = true
  } finally {
    if (!published) await fs.rm(temporaryPath, { force: true })
  }
}

export async function extractEmbeddedSubtitles(
  sourcePath: string,
  streamIndexValue: number,
  runner: CommandRunner = defaultCommandRunner,
): Promise<string | null> {
  assertAbsolutePath(sourcePath, 'sourcePath')
  if (!Number.isSafeInteger(streamIndexValue) || streamIndexValue < 0) {
    throw new FfmpegBoundaryError(
      'INVALID_COMMAND_INPUT',
      'subtitle stream index must be a non-negative safe integer',
    )
  }
  const { stdout } = await runner('ffmpeg', [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-i', sourcePath,
    '-map', `0:${streamIndexValue}`,
    '-f', 'srt',
    '-',
  ])
  const text = stdout.trim()
  return text.length > 0 ? text : null
}
