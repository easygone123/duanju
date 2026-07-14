import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  FfmpegBoundaryError,
  assertFfmpegAvailable,
  createCommandRunner,
  defaultCommandRunner,
  detectSceneTimestamps,
  extractEmbeddedSubtitles,
  extractFrame,
  probeVideo,
  type CommandRunner,
} from '@/lib/viral-replication/ffmpeg'

const sourcePath = path.resolve('/tmp/viral source;$(touch nope).mp4')

function probePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      duration: '15.000000',
    },
    streams: [
      {
        index: 0,
        codec_type: 'video',
        codec_name: 'h264',
        width: 640,
        height: 360,
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
        'format=format_name,duration:stream=index,codec_type,codec_name,width,height,channels,sample_rate:stream_tags=language',
        '-of', 'json',
        sourcePath,
      ],
    }])
    expect(metadata).toEqual({
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationMs: 15_000,
      width: 640,
      height: 360,
      hasVideo: true,
      hasAudio: true,
      hasSubtitles: true,
      videoStreams: [{ index: 0, codecName: 'h264', width: 640, height: 360 }],
      audioStreams: [{ index: 1, codecName: 'aac', channels: 2, sampleRate: 48_000 }],
      subtitleStreams: [
        { index: 2, codecName: 'mov_text', language: 'eng', isText: true },
        { index: 3, codecName: 'hdmv_pgs_subtitle', language: null, isText: false },
      ],
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
      probePayload({ format: { format_name: 'mov,mp4', duration: 'Infinity' } }),
      'FFPROBE_INVALID_DURATION',
    ],
    [
      'duration outside the safe millisecond range',
      probePayload({ format: { format_name: 'mov,mp4', duration: '100000000000000' } }),
      'FFPROBE_INVALID_DURATION',
    ],
    [
      'unsupported container',
      probePayload({ format: { format_name: 'matroska,webm', duration: '15' } }),
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

    await expect(detectSceneTimestamps(sourcePath, runner)).resolves.toEqual([5_000, 10_000])
    expect(calls).toEqual([{
      binary: 'ffmpeg',
      args: [
        '-hide_banner', '-nostdin', '-loglevel', 'info',
        '-i', sourcePath,
        '-an', '-sn',
        '-vf', 'select=gt(scene\\,0.3),showinfo',
        '-f', 'null',
        '-',
      ],
    }])
  })

  it('extracts an exact JPEG frame with a stable decimal timestamp and output argv', async () => {
    const outputPath = path.resolve('/tmp/output frames/shot-000.jpg')
    const calls: Array<{ binary: string; args: string[] }> = []
    const runner: CommandRunner = async (binary, args) => {
      calls.push({ binary, args })
      return { stdout: '', stderr: '' }
    }

    await extractFrame(sourcePath, outputPath, 1_250, runner)

    expect(calls).toEqual([{
      binary: 'ffmpeg',
      args: [
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
        '-ss', '1.250',
        '-i', sourcePath,
        '-frames:v', '1',
        '-q:v', '2',
        outputPath,
      ],
    }])
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

  it.each([
    ['relative source path', () => probeVideo('relative.mp4', async () => ({ stdout: '', stderr: '' }))],
    ['NUL output path', () => extractFrame(sourcePath, '/tmp/bad\0.jpg', 0, async () => ({ stdout: '', stderr: '' }))],
    ['negative frame timestamp', () => extractFrame(sourcePath, '/tmp/shot.jpg', -1, async () => ({ stdout: '', stderr: '' }))],
    ['fractional subtitle index', () => extractEmbeddedSubtitles(sourcePath, 1.5, async () => ({ stdout: '', stderr: '' }))],
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
