import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  assertFfmpegAvailable,
  FfmpegBoundaryError,
  type CommandRunner,
} from '@/lib/viral-replication/ffmpeg'
import {
  VIRAL_FALLBACK_SHOT_INTERVAL_MS,
  buildAnalysisBatches,
  buildReviewFrameTimestamps,
  buildShotRanges,
  preprocessViralVideo,
} from '@/lib/viral-replication/preprocess'
import {
  ViralUploadValidationError,
  hasIsoBaseMediaFtypSignature,
  parseIsoBaseMediaMajorBrand,
  validateDeclaredVideoMime,
  validateVideoUpload,
  validateViralDuration,
  validateViralUploadPrefix,
} from '@/lib/viral-replication/upload-validation'

function ftypPrefix(boxSize = 24, majorBrand = 'isom'): Buffer {
  const prefix = Buffer.alloc(24)
  prefix.writeUInt32BE(boxSize, 0)
  prefix.write('ftyp', 4, 'ascii')
  prefix.write(majorBrand, 8, 'ascii')
  prefix.writeUInt32BE(0x200, 12)
  prefix.write('isom', 16, 'ascii')
  prefix.write('mp42', 20, 'ascii')
  return prefix
}

interface FakeSubtitleStream {
  index: number
  codecName: string
  language?: string
  isDefault?: boolean
}

interface FakeProbeOptions {
  containerDuration?: string
  videoDuration?: string
  subtitleStreams?: FakeSubtitleStream[]
}

function fakeProbePayload(input?: string | FakeProbeOptions): string {
  const options: FakeProbeOptions = typeof input === 'string'
    ? { subtitleStreams: [{ index: 2, codecName: input, language: 'eng', isDefault: true }] }
    : input ?? {}
  return JSON.stringify({
    format: {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      duration: options.containerDuration ?? '15',
      tags: { major_brand: 'isom' },
    },
    streams: [
      {
        index: 0,
        codec_type: 'video',
        codec_name: 'h264',
        duration: options.videoDuration ?? '15',
        width: 320,
        height: 180,
        disposition: { attached_pic: 0, default: 1 },
      },
      ...(options.subtitleStreams ?? []).map((subtitle) => ({
        index: subtitle.index,
        codec_type: 'subtitle',
        codec_name: subtitle.codecName,
        disposition: { attached_pic: 0, default: subtitle.isDefault ? 1 : 0 },
        ...(subtitle.language ? { tags: { language: subtitle.language } } : {}),
      })),
    ],
  })
}

describe('viral upload validation', () => {
  it('recognizes a valid ISO base media ftyp prefix without consulting an extension', () => {
    expect(hasIsoBaseMediaFtypSignature(ftypPrefix())).toBe(true)
    expect(parseIsoBaseMediaMajorBrand(ftypPrefix())).toBe('isom')
    expect(validateVideoUpload(ftypPrefix(), 'video/mp4')).toBeUndefined()
    expect(validateViralUploadPrefix(ftypPrefix(), 'video/mp4')).toBeUndefined()
    expect(validateViralUploadPrefix(ftypPrefix(), 'video/quicktime')).toBeUndefined()
    expect(validateViralUploadPrefix(ftypPrefix(), 'video/mp4; codecs="avc1"')).toBeUndefined()
  })

  it.each(['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ', 'qt  '])(
    'accepts allowed MP4/MOV ftyp major brand %s',
    (majorBrand) => {
      expect(parseIsoBaseMediaMajorBrand(ftypPrefix(24, majorBrand))).toBe(majorBrand)
      expect(validateVideoUpload(ftypPrefix(24, majorBrand), 'video/mp4')).toBeUndefined()
    },
  )

  it.each(['3gp4', '3gp5', '3g2a', 'mjp2', 'M4A '])(
    'rejects disallowed ISO-BMFF ftyp major brand %s even when declared video/mp4',
    (majorBrand) => {
      expect(hasIsoBaseMediaFtypSignature(ftypPrefix(24, majorBrand))).toBe(true)
      expect(() => validateVideoUpload(ftypPrefix(24, majorBrand), 'video/mp4')).toThrowError(
        expect.objectContaining({ code: 'UNSUPPORTED_CONTAINER_BRAND' }),
      )
    },
  )

  it.each([
    ['too short', Buffer.from('ftyp')],
    ['wrong box type', Buffer.from(ftypPrefix()).fill(0x61, 4, 8)],
    ['invalid box size', ftypPrefix(8)],
  ])('rejects a %s header safely', (_label, prefix) => {
    expect(hasIsoBaseMediaFtypSignature(prefix)).toBe(false)
    expect(parseIsoBaseMediaMajorBrand(prefix)).toBeNull()
    expect(() => validateViralUploadPrefix(prefix, 'video/mp4')).toThrowError(
      expect.objectContaining({ code: 'INVALID_MEDIA_HEADER' }),
    )
  })

  it.each(['video/mp4', 'application/mp4', 'video/quicktime', 'video/x-quicktime', 'video/mov'])(
    'allows declared MP4/MOV MIME %s',
    (mimeType) => expect(validateDeclaredVideoMime(mimeType)).toBeUndefined(),
  )

  it.each(['video/webm', 'application/octet-stream', '', 'image/mp4'])('rejects MIME %s', (mimeType) => {
    expect(() => validateDeclaredVideoMime(mimeType)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_MEDIA_TYPE' }),
    )
  })

  it.each([
    [4_999, false],
    [5_000, true],
    [180_000, true],
    [180_001, false],
  ])('validates exact duration boundary %i ms', (durationMs, accepted) => {
    if (accepted) {
      expect(validateViralDuration(durationMs)).toBeUndefined()
      return
    }

    expect(() => validateViralDuration(durationMs)).toThrowError(
      expect.objectContaining({ code: 'INVALID_VIDEO_DURATION' }),
    )
  })

  it('exposes validation failures as coded domain errors', () => {
    let caught: unknown
    try {
      validateDeclaredVideoMime('report.mp4')
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ViralUploadValidationError)
    expect((caught as ViralUploadValidationError).code).toBe('UNSUPPORTED_MEDIA_TYPE')
  })
})

describe('shot planning', () => {
  it('sorts, deduplicates, and removes out-of-range timestamps while preserving full coverage', () => {
    const ranges = buildShotRanges(15_000, [10_000, 5_000, 5_000, -1, 0, 15_000, 18_000])

    expect(ranges).toEqual([
      { startMs: 0, endMs: 5_000, representativeMs: 0 },
      { startMs: 5_000, endMs: 10_000, representativeMs: 7_500 },
      { startMs: 10_000, endMs: 15_000, representativeMs: 12_500 },
    ])
  })

  it('falls back to named fixed intervals when scene detection has fewer than two segments', () => {
    expect(VIRAL_FALLBACK_SHOT_INTERVAL_MS).toBe(3_000)
    expect(buildShotRanges(15_000, [])).toEqual([
      { startMs: 0, endMs: 3_000, representativeMs: 0 },
      { startMs: 3_000, endMs: 6_000, representativeMs: 4_500 },
      { startMs: 6_000, endMs: 9_000, representativeMs: 7_500 },
      { startMs: 9_000, endMs: 12_000, representativeMs: 10_500 },
      { startMs: 12_000, endMs: 15_000, representativeMs: 13_500 },
    ])
  })

  it('caps at 72 ranges with deterministic even sampling and first/last coverage', () => {
    const timestamps = Array.from({ length: 72 }, (_, index) => (index + 1) * 1_000)

    const first = buildShotRanges(73_000, timestamps)
    const second = buildShotRanges(73_000, [...timestamps].reverse())

    expect(first).toEqual(second)
    expect(first).toHaveLength(72)
    expect(first[0]).toMatchObject({ startMs: 0, representativeMs: 0 })
    expect(first.at(-1)?.endMs).toBe(73_000)
    first.forEach((range, index) => {
      expect(range.startMs).toBeLessThan(range.endMs)
      expect(range.representativeMs).toBeGreaterThanOrEqual(range.startMs)
      expect(range.representativeMs).toBeLessThan(range.endMs)
      if (index > 0) expect(range.startMs).toBe(first[index - 1].endMs)
    })
  })

  it('batches ordered work in groups of at most ten', () => {
    const values = Array.from({ length: 73 }, (_, index) => index)
    const batches = buildAnalysisBatches(values)

    expect(batches.map((batch) => batch.length)).toEqual([10, 10, 10, 10, 10, 10, 10, 3])
    expect(batches.flat()).toEqual(values)
  })

  it('samples opening and closing review frames only for shots long enough to add evidence', () => {
    expect(buildReviewFrameTimestamps({
      startMs: 1_000,
      endMs: 2_000,
      representativeMs: 1_500,
    })).toEqual([
      { position: 'opening', timestampMs: 1_200 },
      { position: 'closing', timestampMs: 1_800 },
    ])
    expect(buildReviewFrameTimestamps({
      startMs: 1_000,
      endMs: 1_150,
      representativeMs: 1_075,
    })).toEqual([])
  })
})

describe('preprocessViralVideo', () => {
  let tempRoot: string
  let sourcePath: string
  let outputDirectory: string

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'viral-preprocess-test-'))
    sourcePath = path.join(tempRoot, 'source;$(safe).mp4')
    outputDirectory = path.join(tempRoot, 'frames with spaces')
    await fs.writeFile(sourcePath, 'fake video')
  })

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('orchestrates probe, detection, stable frame extraction, and text subtitles using local paths', async () => {
    const calls: Array<{ binary: string; args: string[] }> = []
    const runner: CommandRunner = async (binary, args) => {
      calls.push({ binary, args })
      if (binary === 'ffprobe') return { stdout: fakeProbePayload('mov_text'), stderr: '' }
      if (args.some((arg) => arg.includes('showinfo'))) {
        return {
          stdout: '',
          stderr: 'pts_time:5.000\npts_time:10.000',
        }
      }
      if (args.includes('-frames:v')) {
        await fs.writeFile(args.at(-1)!, 'valid jpeg placeholder')
        return { stdout: '', stderr: '' }
      }
      if (args.includes('srt')) {
        return { stdout: '1\n00:00:00,000 --> 00:00:01,000\nOpening line\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    }

    const result = await preprocessViralVideo({ sourcePath, outputDirectory, runner })

    expect(result.metadata.durationMs).toBe(15_000)
    expect(result.shots).toEqual([
      {
        shotIndex: 0,
        startMs: 0,
        endMs: 5_000,
        representativeMs: 0,
        framePath: path.join(outputDirectory, 'shot-000.jpg'),
      },
      {
        shotIndex: 1,
        startMs: 5_000,
        endMs: 10_000,
        representativeMs: 7_500,
        framePath: path.join(outputDirectory, 'shot-001.jpg'),
      },
      {
        shotIndex: 2,
        startMs: 10_000,
        endMs: 15_000,
        representativeMs: 12_500,
        framePath: path.join(outputDirectory, 'shot-002.jpg'),
      },
    ])
    expect(result.transcriptText).toContain('Opening line')
    expect(await fs.stat(outputDirectory)).toMatchObject({})
    expect(calls.map((call) => call.binary)).toEqual([
      'ffprobe', 'ffmpeg', 'ffmpeg', 'ffmpeg', 'ffmpeg', 'ffmpeg',
    ])
    for (const shot of result.shots) {
      await expect(fs.stat(shot.framePath)).resolves.toMatchObject({ size: expect.any(Number) })
      expect((await fs.stat(shot.framePath)).size).toBeGreaterThan(0)
    }
    const mappedCalls = calls.filter((call) => call.args.includes('-map'))
    expect(mappedCalls.slice(0, -1).map((call) => call.args[call.args.indexOf('-map') + 1]))
      .toEqual(['0:0', '0:0', '0:0', '0:0'])
    expect(mappedCalls.at(-1)?.args).toEqual(expect.arrayContaining(['-map', '0:2', '-f', 'srt']))
    await expect(fs.readdir(outputDirectory)).resolves.toEqual([
      'shot-000.jpg',
      'shot-001.jpg',
      'shot-002.jpg',
    ])
  })

  it.each([
    ['no subtitle stream', undefined],
    ['unsupported image subtitle stream', 'hdmv_pgs_subtitle'],
  ])('returns null for %s without attempting subtitle extraction', async (_label, subtitleCodec) => {
    const calls: Array<{ binary: string; args: string[] }> = []
    const runner: CommandRunner = async (binary, args) => {
      calls.push({ binary, args })
      if (binary === 'ffprobe') return { stdout: fakeProbePayload(subtitleCodec), stderr: '' }
      if (args.some((arg) => arg.includes('showinfo'))) {
        return { stdout: '', stderr: 'pts_time:5\npts_time:10' }
      }
      if (args.includes('-frames:v')) await fs.writeFile(args.at(-1)!, 'frame')
      return { stdout: '', stderr: '' }
    }

    const result = await preprocessViralVideo({ sourcePath, outputDirectory, runner })

    expect(result.transcriptText).toBeNull()
    expect(calls.some((call) => call.args.includes('srt'))).toBe(false)
  })

  it.each(['failure', 'empty'])(
    'continues after a %s first text subtitle and returns the next usable track',
    async (firstBehavior) => {
      const subtitleMaps: string[] = []
      const runner: CommandRunner = async (binary, args) => {
        if (binary === 'ffprobe') {
          return {
            stdout: fakeProbePayload({
              subtitleStreams: [
                { index: 2, codecName: 'mov_text', isDefault: true },
                { index: 3, codecName: 'subrip', language: 'eng' },
              ],
            }),
            stderr: '',
          }
        }
        if (args.some((arg) => arg.includes('showinfo'))) {
          return { stdout: '', stderr: 'pts_time:5\npts_time:10' }
        }
        if (args.includes('-frames:v')) {
          await fs.writeFile(args.at(-1)!, 'frame')
          return { stdout: '', stderr: '' }
        }
        const map = args[args.indexOf('-map') + 1]
        subtitleMaps.push(map)
        if (map === '0:2') {
          if (firstBehavior === 'failure') {
            throw new FfmpegBoundaryError('COMMAND_FAILED', 'corrupt subtitle')
          }
          return { stdout: '   \n', stderr: '' }
        }
        return { stdout: '  second track transcript  \n', stderr: '' }
      }

      const result = await preprocessViralVideo({ sourcePath, outputDirectory, runner })

      expect(result.transcriptText).toBe('second track transcript')
      expect(subtitleMaps).toEqual(['0:2', '0:3'])
    },
  )

  it('returns null when all text subtitles fail while preserving verified frames', async () => {
    const subtitleMaps: string[] = []
    const runner: CommandRunner = async (binary, args) => {
      if (binary === 'ffprobe') {
        return {
          stdout: fakeProbePayload({
            subtitleStreams: [
              { index: 2, codecName: 'mov_text', isDefault: true },
              { index: 3, codecName: 'subrip', language: 'eng' },
            ],
          }),
          stderr: '',
        }
      }
      if (args.some((arg) => arg.includes('showinfo'))) {
        return { stdout: '', stderr: 'pts_time:5\npts_time:10' }
      }
      if (args.includes('-frames:v')) {
        await fs.writeFile(args.at(-1)!, 'frame')
        return { stdout: '', stderr: '' }
      }
      subtitleMaps.push(args[args.indexOf('-map') + 1])
      throw new FfmpegBoundaryError('COMMAND_FAILED', 'corrupt subtitle')
    }

    const result = await preprocessViralVideo({ sourcePath, outputDirectory, runner })

    expect(result.transcriptText).toBeNull()
    expect(subtitleMaps).toEqual(['0:2', '0:3'])
    expect(result.shots).toHaveLength(3)
    for (const shot of result.shots) {
      expect((await fs.stat(shot.framePath)).size).toBeGreaterThan(0)
    }
  })

  it.each([
    [
      'command cancellation',
      new FfmpegBoundaryError('COMMAND_ABORTED', 'subtitle extraction aborted'),
    ],
    [
      'command timeout',
      new FfmpegBoundaryError('COMMAND_TIMEOUT', 'subtitle extraction timed out'),
    ],
    [
      'missing FFmpeg binary',
      new FfmpegBoundaryError('BINARY_NOT_FOUND', 'ffmpeg missing'),
    ],
    [
      'command output overflow',
      new FfmpegBoundaryError('COMMAND_OUTPUT_LIMIT', 'subtitle output overflow'),
    ],
    [
      'command spawn failure',
      new FfmpegBoundaryError('COMMAND_SPAWN_FAILED', 'ffmpeg spawn failed'),
    ],
    ['unknown runner error', new TypeError('subtitle runner contract bug')],
  ])('rethrows %s from subtitle extraction', async (_label, subtitleFailure) => {
    const runner: CommandRunner = async (binary, args) => {
      if (binary === 'ffprobe') return { stdout: fakeProbePayload('mov_text'), stderr: '' }
      if (args.some((arg) => arg.includes('showinfo'))) {
        return { stdout: '', stderr: 'pts_time:5\npts_time:10' }
      }
      if (args.includes('-frames:v')) {
        await fs.writeFile(args.at(-1)!, 'frame')
        return { stdout: '', stderr: '' }
      }
      throw subtitleFailure
    }

    await expect(preprocessViralVideo({ sourcePath, outputDirectory, runner })).rejects.toBe(
      subtitleFailure,
    )
  })

  it('removes frames created by this invocation when a later frame fails', async () => {
    await fs.mkdir(outputDirectory, { recursive: true })
    const unrelatedPath = path.join(outputDirectory, 'caller-owned.keep')
    await fs.writeFile(unrelatedPath, 'do not remove')
    let frameAttempt = 0
    const frameFailure = new FfmpegBoundaryError('COMMAND_FAILED', 'later frame failed')
    const runner: CommandRunner = async (binary, args) => {
      if (binary === 'ffprobe') return { stdout: fakeProbePayload(), stderr: '' }
      if (args.some((arg) => arg.includes('showinfo'))) {
        return { stdout: '', stderr: 'pts_time:5\npts_time:10' }
      }
      if (args.includes('-frames:v')) {
        frameAttempt += 1
        await fs.writeFile(args.at(-1)!, frameAttempt === 1 ? 'valid frame' : 'partial frame')
        if (frameAttempt === 2) throw frameFailure
      }
      return { stdout: '', stderr: '' }
    }

    await expect(preprocessViralVideo({ sourcePath, outputDirectory, runner })).rejects.toBe(
      frameFailure,
    )
    await expect(fs.readdir(outputDirectory)).resolves.toEqual(['caller-owned.keep'])
    await expect(fs.readFile(unrelatedPath, 'utf8')).resolves.toBe('do not remove')
  })

  it('rejects a short selected video even when the container tail is long', async () => {
    const calls: Array<{ binary: string; args: string[] }> = []
    const runner: CommandRunner = async (binary, args) => {
      calls.push({ binary, args })
      return {
        stdout: fakeProbePayload({ containerDuration: '30', videoDuration: '4.9' }),
        stderr: '',
      }
    }

    await expect(preprocessViralVideo({ sourcePath, outputDirectory, runner })).rejects.toMatchObject({
      code: 'INVALID_VIDEO_DURATION',
    })
    expect(calls).toHaveLength(1)
  })

  it('rejects an invalid output boundary before creating directories or running commands', async () => {
    let called = false
    const runner: CommandRunner = async () => {
      called = true
      return { stdout: '', stderr: '' }
    }

    await expect(preprocessViralVideo({
      sourcePath,
      outputDirectory: 'relative-output',
      runner,
    })).rejects.toThrow(/outputDirectory.*absolute/i)
    expect(called).toBe(false)
  })

  it('runs the committed three-scene fixture through real FFmpeg and FFprobe', async () => {
    try {
      await assertFfmpegAvailable()
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`FFmpeg integration fixture requires ffmpeg and ffprobe on PATH: ${detail}`)
    }

    const fixturePath = path.resolve('tests/fixtures/viral-replication/three-scenes.mp4')
    const realOutputDirectory = path.join(tempRoot, 'real-frames')
    const result = await preprocessViralVideo({
      sourcePath: fixturePath,
      outputDirectory: realOutputDirectory,
    })

    expect(result.metadata.formatName.split(',')).toEqual(expect.arrayContaining(['mov', 'mp4']))
    expect(result.metadata.durationMs).toBeGreaterThanOrEqual(14_900)
    expect(result.metadata.durationMs).toBeLessThanOrEqual(15_100)
    expect(result.shots).toHaveLength(3)
    expect(result.shots[0].representativeMs).toBe(0)
    for (const shot of result.shots) {
      expect((await fs.stat(shot.framePath)).size).toBeGreaterThan(0)
    }
  })
})
