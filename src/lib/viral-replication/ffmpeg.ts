import path from 'node:path'
import { spawn } from 'node:child_process'

export type CommandBinary = 'ffmpeg' | 'ffprobe'

export type CommandRunner = (
  binary: CommandBinary,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>

export type FfmpegBoundaryErrorCode =
  | 'BINARY_NOT_FOUND'
  | 'COMMAND_FAILED'
  | 'COMMAND_OUTPUT_LIMIT'
  | 'INVALID_COMMAND_INPUT'
  | 'FFPROBE_MALFORMED_JSON'
  | 'FFPROBE_NO_VIDEO'
  | 'FFPROBE_INVALID_VIDEO'
  | 'FFPROBE_INVALID_DURATION'
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
  width: number
  height: number
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
}

export interface VideoMetadata {
  formatName: string
  majorBrand: string
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
  captureLimitBytes = DEFAULT_CAPTURE_LIMIT_BYTES,
): CommandRunner {
  if (!Number.isSafeInteger(captureLimitBytes) || captureLimitBytes <= 0) {
    throw new TypeError('captureLimitBytes must be a positive safe integer')
  }

  return async (binary, args) => await new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false

    const rejectOnce = (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    }

    const capture = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      const nextBytes = (target === 'stdout' ? stdoutBytes : stderrBytes) + chunk.length
      if (nextBytes > captureLimitBytes) {
        child.kill('SIGKILL')
        rejectOnce(new FfmpegBoundaryError(
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
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        rejectOnce(new FfmpegBoundaryError(
          'BINARY_NOT_FOUND',
          `Required binary "${binary}" is not available on PATH`,
        ))
        return
      }
      rejectOnce(new FfmpegBoundaryError(
        'COMMAND_FAILED',
        `Unable to start ${binary}: ${error.message}`,
      ))
    })
    child.once('close', (exitCode, signal) => {
      if (settled) return
      const stdout = stdoutChunks.map(stringifyChunk).join('')
      const stderr = stderrChunks.map(stringifyChunk).join('')
      if (exitCode !== 0) {
        const reason = exitCode === null ? `signal ${signal ?? 'unknown'}` : `exit code ${exitCode}`
        const detail = stderr.trim() || 'no stderr output'
        rejectOnce(new FfmpegBoundaryError(
          'COMMAND_FAILED',
          `${binary} failed with ${reason}: ${detail}`,
        ))
        return
      }

      settled = true
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
    'format=format_name,duration:format_tags=major_brand:stream=index,codec_type,codec_name,width,height,channels,sample_rate:stream_tags=language',
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
    if (index === null || width === null || height === null) {
      throw new FfmpegBoundaryError(
        'FFPROBE_INVALID_VIDEO',
        'FFprobe returned invalid video stream metadata',
      )
    }
    return { index, codecName: optionalString(stream.codec_name), width, height }
  })

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
      return [{
        index,
        codecName,
        language: optionalString(tags?.language),
        isText: codecName !== null && TEXT_SUBTITLE_CODECS.has(codecName.toLowerCase()),
      }]
    })

  return {
    formatName,
    majorBrand,
    durationMs,
    width: videoStreams[0].width,
    height: videoStreams[0].height,
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
  runner: CommandRunner = defaultCommandRunner,
): Promise<number[]> {
  assertAbsolutePath(sourcePath, 'sourcePath')
  const { stderr } = await runner('ffmpeg', [
    '-hide_banner', '-nostdin', '-loglevel', 'info',
    '-i', sourcePath,
    '-an', '-sn',
    '-vf', 'select=gt(scene\\,0.3),showinfo',
    '-f', 'null',
    '-',
  ])
  const timestamps = new Set<number>()
  const timestampPattern = /\bpts_time:\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/gi

  for (const match of stderr.matchAll(timestampPattern)) {
    const timestampMs = Math.round(Number(match[1]) * 1_000)
    if (Number.isSafeInteger(timestampMs) && timestampMs >= 0) timestamps.add(timestampMs)
  }

  return [...timestamps].sort((left, right) => left - right)
}

export async function extractFrame(
  sourcePath: string,
  outputPath: string,
  timestampMs: number,
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
  await runner('ffmpeg', [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-ss', (timestampMs / 1_000).toFixed(3),
    '-i', sourcePath,
    '-frames:v', '1',
    '-q:v', '2',
    outputPath,
  ])
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
