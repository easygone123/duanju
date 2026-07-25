import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  FfmpegBoundaryError,
  MAX_FRAME_JPEG_BYTES,
  MAX_FRAME_LONGEST_EDGE,
  MAX_FRAME_PIXELS,
  MAX_SCENE_TIMESTAMPS,
  assertFfmpegAvailable,
  createCommandRunner,
  defaultCommandRunner,
  detectSceneTimestamps,
  detectSceneTimestampsFromProcess,
  extractAnalysisAudioSegment,
  extractEmbeddedSubtitles,
  extractFrame,
  extractSourceAudio,
  probeVideo,
  type CommandRunner,
} from '@/lib/viral-replication/ffmpeg'

const sourcePath = path.resolve('/tmp/viral source;$(touch nope).mp4')

function fakeChildProcess() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  })
}

function probePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      duration: '15.000000',
      tags: { major_brand: 'isom' },
    },
    streams: [
      {
        index: 0,
        codec_type: 'video',
        codec_name: 'h264',
        duration: '15.000000',
        width: 640,
        height: 360,
        disposition: { attached_pic: 0, default: 1 },
      },
      {
        index: 1,
        codec_type: 'audio',
        codec_name: 'aac',
        channels: 2,
        sample_rate: '48000',
      },
      {
        index: 2,
        codec_type: 'subtitle',
        codec_name: 'mov_text',
        disposition: { attached_pic: 0, default: 1 },
        tags: { language: 'eng' },
      },
      {
        index: 3,
        codec_type: 'subtitle',
        codec_name: 'hdmv_pgs_subtitle',
      },
    ],
    ...overrides,
  })
}

describe('FFmpeg command boundary', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('times out, kills once, and rejects only after the child closes', async () => {
    vi.useFakeTimers()
    const child = fakeChildProcess()
    const runner = createCommandRunner({
      timeoutMs: 50,
      spawnImpl: () => child,
    })
    let settled = false
    const observed = runner('ffmpeg', ['-version']).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    ).finally(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(50)

    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    child.emit('close', null, 'SIGKILL')
    await expect(observed).resolves.toMatchObject({
      error: expect.objectContaining({ code: 'COMMAND_TIMEOUT' }),
    })
  })

  it('bounds output, kills once, and waits for close before rejecting', async () => {
    const child = fakeChildProcess()
    const runner = createCommandRunner({
      captureLimitBytes: 8,
      timeoutMs: 1_000,
      spawnImpl: () => child,
    })
    let settled = false
    const observed = runner('ffmpeg', ['-version']).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    ).finally(() => {
      settled = true
    })

    child.stderr.write('123456789')
    child.stdout.write('also-overflowing')
    await Promise.resolve()

    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    child.emit('close', null, 'SIGKILL')
    await expect(observed).resolves.toMatchObject({
      error: expect.objectContaining({ code: 'COMMAND_OUTPUT_LIMIT' }),
    })
  })

  it('keeps abort as the stable cause across abort, error, close, and repeated kill races', async () => {
    const controller = new AbortController()
    const child = fakeChildProcess()
    const runner = createCommandRunner({
      signal: controller.signal,
      timeoutMs: 1_000,
      spawnImpl: () => child,
    })
    const promise = runner('ffmpeg', ['-version'])

    controller.abort()
    controller.abort()
    child.emit('error', Object.assign(new Error('late spawn error'), { code: 'ENOENT' }))
    expect(child.kill).toHaveBeenCalledTimes(1)
    child.emit('close', null, 'SIGKILL')

    await expect(promise).rejects.toMatchObject({ code: 'COMMAND_ABORTED' })
  })

  it('records a spawn error but rejects only after close without killing', async () => {
    const child = fakeChildProcess()
    const runner = createCommandRunner({
      timeoutMs: 1_000,
      spawnImpl: () => child,
    })
    let settled = false
    const observed = runner('ffprobe', ['-version']).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    ).finally(() => {
      settled = true
    })

    child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }))
    await Promise.resolve()

    expect(child.kill).not.toHaveBeenCalled()
    expect(settled).toBe(false)
    child.emit('close', -2, null)
    await expect(observed).resolves.toMatchObject({
      error: expect.objectContaining({ code: 'BINARY_NOT_FOUND' }),
    })
  })

  it('keeps non-ENOENT spawn failures distinct from command conversion failures', async () => {
    const child = fakeChildProcess()
    const runner = createCommandRunner({ timeoutMs: 1_000, spawnImpl: () => child })
    const promise = runner('ffmpeg', ['-version'])

    child.emit('error', Object.assign(new Error('spawn permission denied'), { code: 'EACCES' }))
    child.emit('close', -13, null)

    await expect(promise).rejects.toMatchObject({ code: 'COMMAND_SPAWN_FAILED' })
  })

  it('checks both binaries with argv-only version commands', async () => {
    const calls: Array<{ binary: string; args: string[] }> = []
    const runner: CommandRunner = async (binary, args) => {
      calls.push({ binary, args })
      return { stdout: '', stderr: '' }
    }

    await assertFfmpegAvailable(runner)

    expect(calls).toEqual([
      { binary: 'ffmpeg', args: ['-version'] },
      { binary: 'ffprobe', args: ['-version'] },
    ])
  })

  it('constructs exact FFprobe argv and returns typed stream metadata', async () => {
    const calls: Array<{ binary: string; args: string[] }> = []
    const runner: CommandRunner = async (binary, args) => {
      calls.push({ binary, args })
      return { stdout: probePayload(), stderr: '' }
    }

    const metadata = await probeVideo(sourcePath, runner)

    expect(calls).toEqual([{
      binary: 'ffprobe',
      args: [
        '-v', 'error',
        '-show_entries',
        'format=format_name,duration:format_tags=major_brand:stream=index,codec_type,codec_name,duration,width,height,channels,sample_rate:stream_disposition=attached_pic,default:stream_tags=language',
        '-of', 'json',
        sourcePath,
      ],
    }])
    expect(metadata).toEqual({
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      majorBrand: 'isom',
      videoStreamIndex: 0,
      durationMs: 15_000,
      width: 640,
      height: 360,
      hasVideo: true,
      hasAudio: true,
      hasSubtitles: true,
      videoStreams: [{
        index: 0,
        codecName: 'h264',
        durationMs: 15_000,
        width: 640,
        height: 360,
        isDefault: true,
        isAttachedPic: false,
      }],
      audioStreams: [{ index: 1, codecName: 'aac', channels: 2, sampleRate: 48_000 }],
      subtitleStreams: [
        {
          index: 2,
          codecName: 'mov_text',
          language: 'eng',
          isText: true,
          isDefault: true,
        },
        {
          index: 3,
          codecName: 'hdmv_pgs_subtitle',
          language: null,
          isText: false,
          isDefault: false,
        },
      ],
    })
  })

  it('ignores cover art and prefers the default analyzable video stream', async () => {
    const runner: CommandRunner = async () => ({
      stdout: probePayload({
        streams: [
          {
            index: 0,
            codec_type: 'video',
            codec_name: 'mjpeg',
            duration: '30',
            width: 100,
            height: 100,
            disposition: { attached_pic: 1, default: 0 },
          },
          {
            index: 1,
            codec_type: 'video',
            codec_name: 'h264',
            duration: '16',
            width: 640,
            height: 360,
            disposition: { attached_pic: 0, default: 0 },
          },
          {
            index: 4,
            codec_type: 'video',
            codec_name: 'hevc',
            duration: '15.5',
            width: 1280,
            height: 720,
            disposition: { attached_pic: 0, default: 1 },
          },
        ],
      }),
      stderr: '',
    })

    await expect(probeVideo(sourcePath, runner)).resolves.toMatchObject({
      videoStreamIndex: 4,
      durationMs: 15_500,
      width: 1280,
      height: 720,
    })
  })

  it('uses selected video duration instead of a longer container or audio tail', async () => {
    const runner: CommandRunner = async () => ({
      stdout: probePayload({
        format: {
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          duration: '30',
          tags: { major_brand: 'isom' },
        },
        streams: [
          {
            index: 2,
            codec_type: 'video',
            codec_name: 'h264',
            duration: '10',
            width: 640,
            height: 360,
            disposition: { attached_pic: 0, default: 1 },
          },
          {
            index: 3,
            codec_type: 'audio',
            codec_name: 'aac',
            duration: '30',
            channels: 2,
            sample_rate: '48000',
          },
        ],
      }),
      stderr: '',
    })

    await expect(probeVideo(sourcePath, runner)).resolves.toMatchObject({
      videoStreamIndex: 2,
      durationMs: 10_000,
    })
  })

  it('rejects media whose only video stream is attached cover art', async () => {
    const runner: CommandRunner = async () => ({
      stdout: probePayload({
        streams: [{
          index: 0,
          codec_type: 'video',
          codec_name: 'mjpeg',
          duration: '15',
          width: 100,
          height: 100,
          disposition: { attached_pic: 1, default: 1 },
        }],
      }),
      stderr: '',
    })

    await expect(probeVideo(sourcePath, runner)).rejects.toMatchObject({
      code: 'FFPROBE_NO_VIDEO',
    })
  })

  it.each([
    ['malformed JSON', '{not-json', 'FFPROBE_MALFORMED_JSON'],
    [
      'missing video stream',
      probePayload({ streams: [{ index: 0, codec_type: 'audio', codec_name: 'aac' }] }),
      'FFPROBE_NO_VIDEO',
    ],
    [
      'non-finite duration',
      probePayload({
        format: { format_name: 'mov,mp4', duration: 'Infinity', tags: { major_brand: 'isom' } },
      }),
      'FFPROBE_INVALID_DURATION',
    ],
    [
      'duration outside the safe millisecond range',
      probePayload({
        format: {
          format_name: 'mov,mp4',
          duration: '100000000000000',
          tags: { major_brand: 'isom' },
        },
      }),
      'FFPROBE_INVALID_DURATION',
    ],
    [
      'unsupported container',
      probePayload({
        format: { format_name: 'matroska,webm', duration: '15', tags: { major_brand: 'isom' } },
      }),
      'UNSUPPORTED_CONTAINER',
    ],
  ])('rejects %s with a stable domain code', async (_label, stdout, expectedCode) => {
    const runner: CommandRunner = async () => ({ stdout, stderr: '' })

    let caught: unknown
    try {
      await probeVideo(sourcePath, runner)
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBeInstanceOf(FfmpegBoundaryError)
    expect((caught as FfmpegBoundaryError).code).toBe(expectedCode)
  })

  it.each(['3gp4', '3gp5', '3g2a', 'mjp2', 'M4A ', undefined])(
    'rejects generic mov/mp4 demuxer output with disallowed major brand %s',
    async (majorBrand) => {
      const runner: CommandRunner = async () => ({
        stdout: probePayload({
          format: {
            format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
            duration: '15',
            ...(majorBrand === undefined ? {} : { tags: { major_brand: majorBrand } }),
          },
        }),
        stderr: '',
      })

      await expect(probeVideo(sourcePath, runner)).rejects.toMatchObject({
        code: 'UNSUPPORTED_CONTAINER_BRAND',
      })
    },
  )

  it.each(['isom', 'mp42', 'qt  '])(
    'accepts the allowed MP4/MOV major brand %s',
    async (majorBrand) => {
      const runner: CommandRunner = async () => ({
        stdout: probePayload({
          format: {
            format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
            duration: '15',
            tags: { major_brand: majorBrand },
          },
        }),
        stderr: '',
      })

      await expect(probeVideo(sourcePath, runner)).resolves.toMatchObject({ majorBrand })
    },
  )

  it('parses scene timestamps deterministically and passes metacharacters as one argv item', async () => {
    const calls: Array<{ binary: string; args: string[] }> = []
    const runner: CommandRunner = async (binary, args) => {
      calls.push({ binary, args })
      return {
        stdout: '',
        stderr: [
          '[Parsed_showinfo_1] n: 2 pts: 10000 pts_time:10.000',
          '[Parsed_showinfo_1] n: 0 pts: 5000 pts_time:5',
          '[Parsed_showinfo_1] n: 1 pts: 5000 pts_time:5.0004',
          '[Parsed_showinfo_1] n: 3 pts: -1000 pts_time:-1',
          '[Parsed_showinfo_1] n: 4 pts: 10000 pts_time:garbage',
        ].join('\n'),
      }
    }

    await expect(detectSceneTimestamps(sourcePath, 4, runner)).resolves.toEqual([5_000, 10_000])
    expect(calls).toEqual([{
      binary: 'ffmpeg',
      args: [
        '-hide_banner', '-nostdin', '-loglevel', 'info',
        '-i', sourcePath,
        '-map', '0:4',
        '-an', '-sn',
        '-vf', 'select=gt(scene\\,0.3),showinfo',
        '-f', 'null',
        '-',
      ],
    }])
  })

  it('evenly samples excessive scene events while preserving earliest and latest cuts', async () => {
    const runner: CommandRunner = async () => ({
      stdout: '',
      stderr: Array.from(
        { length: MAX_SCENE_TIMESTAMPS + 100 },
        (_, index) => `pts_time:${(index + 1) / 1000}`,
      ).join('\n'),
    })

    const timestamps = await detectSceneTimestamps(sourcePath, 0, runner)

    expect(timestamps).toHaveLength(MAX_SCENE_TIMESTAMPS)
    expect(timestamps[0]).toBe(1)
    expect(timestamps.at(-1)).toBe(MAX_SCENE_TIMESTAMPS + 100)
    expect(timestamps.some((timestamp) => timestamp > MAX_SCENE_TIMESTAMPS)).toBe(true)
    const gaps = timestamps.slice(1).map((timestamp, index) => timestamp - timestamps[index])
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1)
    expect(Math.max(...gaps)).toBeLessThanOrEqual(2)
  })

  it('stream-parses high-volume real-process scene output without generic stderr overflow', async () => {
    const child = fakeChildProcess()
    const detection = detectSceneTimestampsFromProcess(sourcePath, 0, {
      captureLimitBytes: 64,
      timeoutMs: 10_000,
      spawnImpl: () => child,
    })
    const noisyOutput = Array.from({ length: 400 }, (_, index) => (
      `[Parsed_showinfo_1 @ 0x1] n:${index} pts_time:${index / 10} ${'x'.repeat(3_000)}\n`
    )).join('')
    expect(Buffer.byteLength(noisyOutput)).toBeGreaterThan(1024 * 1024)
    for (let offset = 0; offset < noisyOutput.length; offset += 257) {
      child.stderr.write(noisyOutput.slice(offset, offset + 257))
    }
    child.emit('close', 0, null)

    const timestamps = await detection
    expect(child.kill).not.toHaveBeenCalled()
    expect(timestamps).toHaveLength(MAX_SCENE_TIMESTAMPS)
    expect(timestamps[0]).toBe(0)
    expect(timestamps.at(-1)).toBe(39_900)
    expect(timestamps.some((timestamp) => timestamp > 30_000)).toBe(true)
  })

  it('extracts a mapped JPEG through a nonempty sibling temp file and atomically replaces final', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'viral-frame-test-'))
    const outputPath = path.join(tempRoot, 'shot-000.jpg')
    await fs.writeFile(outputPath, 'old frame')
    const calls: Array<{ binary: string; args: string[] }> = []
    const runner: CommandRunner = async (binary, args) => {
      calls.push({ binary, args })
      await fs.writeFile(args.at(-1)!, 'valid jpeg placeholder')
      return { stdout: '', stderr: '' }
    }

    try {
      await extractFrame(sourcePath, outputPath, 1_250, 4, runner)

      const tempOutputPath = calls[0].args.at(-1)!
      expect(calls[0]).toMatchObject({ binary: 'ffmpeg' })
      expect(calls[0].args).toEqual([
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
        '-ss', '1.250',
        '-i', sourcePath,
        '-map', '0:4',
        '-frames:v', '1',
        '-vf', `scale='min(iw,${MAX_FRAME_LONGEST_EDGE})':'min(ih,${MAX_FRAME_LONGEST_EDGE})':force_original_aspect_ratio=decrease:force_divisible_by=2`,
        '-q:v', '2',
        tempOutputPath,
      ])
      expect(MAX_FRAME_PIXELS).toBe(MAX_FRAME_LONGEST_EDGE ** 2)
      expect(path.dirname(tempOutputPath)).toBe(tempRoot)
      expect(tempOutputPath).not.toBe(outputPath)
      expect(tempOutputPath.endsWith('.jpg')).toBe(true)
      await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('valid jpeg placeholder')
      await expect(fs.readdir(tempRoot)).resolves.toEqual(['shot-000.jpg'])
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('fails closed and preserves the previous frame when a JPEG exceeds the byte cap', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'viral-frame-test-'))
    const outputPath = path.join(tempRoot, 'shot.jpg')
    await fs.writeFile(outputPath, 'previous valid frame')
    const runner: CommandRunner = async (_binary, args) => {
      await fs.writeFile(args.at(-1)!, Buffer.alloc(MAX_FRAME_JPEG_BYTES + 1))
      return { stdout: '', stderr: '' }
    }

    try {
      await expect(extractFrame(sourcePath, outputPath, 0, 0, runner)).rejects.toMatchObject({
        code: 'FRAME_ARTIFACT_TOO_LARGE',
      })
      await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('previous valid frame')
      await expect(fs.readdir(tempRoot)).resolves.toEqual(['shot.jpg'])
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it.each([
    ['missing output', async () => undefined],
    ['zero-byte output', async (tempPath: string) => fs.writeFile(tempPath, '')],
  ])('rejects and cleans a %s frame artifact', async (_label, createArtifact) => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'viral-frame-test-'))
    const outputPath = path.join(tempRoot, 'shot.jpg')
    await fs.writeFile(outputPath, 'previous valid frame')
    const runner: CommandRunner = async (_binary, args) => {
      await createArtifact(args.at(-1)!)
      return { stdout: '', stderr: '' }
    }

    try {
      await expect(extractFrame(sourcePath, outputPath, 0, 0, runner)).rejects.toMatchObject({
        code: 'FRAME_ARTIFACT_INVALID',
      })
      await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('previous valid frame')
      await expect(fs.readdir(tempRoot)).resolves.toEqual(['shot.jpg'])
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('cleans a partial temp frame when the command runner fails', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'viral-frame-test-'))
    const outputPath = path.join(tempRoot, 'shot.jpg')
    const commandFailure = new FfmpegBoundaryError('COMMAND_FAILED', 'synthetic frame failure')
    const runner: CommandRunner = async (_binary, args) => {
      await fs.writeFile(args.at(-1)!, 'partial')
      throw commandFailure
    }

    try {
      await expect(extractFrame(sourcePath, outputPath, 0, 0, runner)).rejects.toBe(commandFailure)
      await expect(fs.readdir(tempRoot)).resolves.toEqual([])
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('extracts a selected embedded text subtitle stream to stdout', async () => {
    const calls: Array<{ binary: string; args: string[] }> = []
    const runner: CommandRunner = async (binary, args) => {
      calls.push({ binary, args })
      return { stdout: '1\n00:00:00,000 --> 00:00:01,000\nHello\n\n', stderr: '' }
    }

    await expect(extractEmbeddedSubtitles(sourcePath, 2, runner)).resolves.toBe(
      '1\n00:00:00,000 --> 00:00:01,000\nHello',
    )
    expect(calls).toEqual([{
      binary: 'ffmpeg',
      args: [
        '-hide_banner', '-nostdin', '-loglevel', 'error',
        '-i', sourcePath,
        '-map', '0:2',
        '-f', 'srt',
        '-',
      ],
    }])
  })

  it('extracts a bounded audio segment with exact millisecond offsets', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'viral-audio-segment-test-'))
    const outputPath = path.join(tempRoot, 'segment.mp3')
    const calls: string[][] = []
    const runner: CommandRunner = async (_binary, args) => {
      calls.push(args)
      await fs.writeFile(args.at(-1)!, 'audio')
      return { stdout: '', stderr: '' }
    }

    try {
      await extractAnalysisAudioSegment(sourcePath, outputPath, 1, 5_250, 12_750, runner)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual(expect.arrayContaining([
        '-ss', '5.250',
        '-t', '7.500',
        '-map', '0:1',
      ]))
      await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('audio')
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('extracts a full-quality source audio artifact for Director timelines', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'viral-source-audio-test-'))
    const outputPath = path.join(tempRoot, 'source.mp3')
    const calls: string[][] = []
    const runner: CommandRunner = async (_binary, args) => {
      calls.push(args)
      await fs.writeFile(args.at(-1)!, 'source audio')
      return { stdout: '', stderr: '' }
    }

    try {
      await extractSourceAudio(sourcePath, outputPath, 1, runner)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual(expect.arrayContaining([
        '-map', '0:1',
        '-ac', '2',
        '-ar', '48000',
        '-b:a', '192k',
      ]))
      await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('source audio')
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it.each([
    ['relative source path', () => probeVideo('relative.mp4', async () => ({ stdout: '', stderr: '' }))],
    ['NUL output path', () => extractFrame(sourcePath, '/tmp/bad\0.jpg', 0, 0, async () => ({ stdout: '', stderr: '' }))],
    ['negative frame timestamp', () => extractFrame(sourcePath, '/tmp/shot.jpg', -1, 0, async () => ({ stdout: '', stderr: '' }))],
    ['fractional video index', () => extractFrame(sourcePath, '/tmp/shot.jpg', 0, 1.5, async () => ({ stdout: '', stderr: '' }))],
    ['fractional subtitle index', () => extractEmbeddedSubtitles(sourcePath, 1.5, async () => ({ stdout: '', stderr: '' }))],
    ['empty audio segment', () => extractAnalysisAudioSegment(sourcePath, '/tmp/audio.mp3', 1, 1_000, 1_000, async () => ({ stdout: '', stderr: '' }))],
  ])('rejects an unsafe %s before invoking a command', async (_label, operation) => {
    await expect(operation()).rejects.toThrow(/invalid|absolute|non-negative/i)
  })

  it('bounds real process capture and reports nonzero and missing-binary failures with stable codes', async () => {
    try {
      await assertFfmpegAvailable()
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`FFmpeg runner verification requires ffmpeg and ffprobe on PATH: ${detail}`)
    }

    await expect(createCommandRunner(16)('ffmpeg', ['-version'])).rejects.toMatchObject({
      code: 'COMMAND_OUTPUT_LIMIT',
    })
    await expect(defaultCommandRunner('ffmpeg', ['-definitely-not-an-ffmpeg-option']))
      .rejects.toMatchObject({ code: 'COMMAND_FAILED' })

    const originalPath = process.env.PATH
    try {
      process.env.PATH = '/path/that/does/not/exist'
      await expect(defaultCommandRunner('ffmpeg', ['-version'])).rejects.toMatchObject({
        code: 'BINARY_NOT_FOUND',
        message: expect.stringMatching(/ffmpeg.*not available.*PATH/i),
      })
    } finally {
      process.env.PATH = originalPath
    }
  })
})
