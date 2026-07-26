import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  downloadViralVideoFromShareText,
  extractSupportedViralVideoUrl,
  ViralRemoteVideoError,
} from '@/lib/viral-replication/remote-video'

const cleanupRoots: string[] = []

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map(async (root) => {
    await fs.rm(root, { recursive: true, force: true })
  }))
})

describe('viral remote video import', () => {
  it('extracts official Douyin URLs from full share text', () => {
    expect(extractSupportedViralVideoUrl(
      '复制此链接打开抖音 https://v.douyin.com/abc123/ 看视频！',
    ).toString()).toBe('https://v.douyin.com/abc123/')
  })

  it.each([
    ['', 'VIRAL_LINK_INVALID'],
    ['没有链接的分享文本', 'VIRAL_LINK_INVALID'],
    ['https://example.com/video/1', 'VIRAL_LINK_DOMAIN_UNSUPPORTED'],
    ['https://douyin.com.evil.example/video/1', 'VIRAL_LINK_DOMAIN_UNSUPPORTED'],
  ])('rejects unsupported input %s', (value, code) => {
    expect(() => extractSupportedViralVideoUrl(value)).toThrowError(
      expect.objectContaining({ code }),
    )
  })

  it('downloads to an isolated file and returns a cleanup handle', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viral-link-test-'))
    cleanupRoots.push(root)
    const runDownloader = vi.fn(async (_binary: string, args: readonly string[]) => {
      const outputIndex = args.indexOf('--output')
      const outputTemplate = args[outputIndex + 1]
      await fs.writeFile(outputTemplate.replace('%(ext)s', 'mp4'), Buffer.from('video'))
      return { stdout: '', stderr: '' }
    })

    const result = await downloadViralVideoFromShareText('https://v.douyin.com/abc/', {
      tempRoot: root,
      runDownloader: runDownloader as never,
    })
    expect(result).toMatchObject({ mimeType: 'video/mp4', sizeBytes: 5 })
    expect(runDownloader).toHaveBeenCalledWith(
      'yt-dlp',
      expect.arrayContaining(['--no-config', '--no-playlist', 'https://v.douyin.com/abc/']),
      expect.objectContaining({ timeout: 300_000 }),
    )
    await result.cleanup()
    await expect(fs.stat(result.filePath)).rejects.toThrow()
  })

  it('reports a missing downloader separately from an inaccessible video', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viral-link-test-'))
    cleanupRoots.push(root)
    const missingDownloader = Object.assign(new Error('missing'), { code: 'ENOENT' })
    await expect(downloadViralVideoFromShareText('https://v.douyin.com/abc/', {
      tempRoot: root,
      runDownloader: vi.fn().mockRejectedValue(missingDownloader) as never,
    })).rejects.toMatchObject({
      code: 'VIRAL_LINK_DOWNLOADER_UNAVAILABLE',
    } satisfies Partial<ViralRemoteVideoError>)

    await expect(downloadViralVideoFromShareText('https://v.douyin.com/abc/', {
      tempRoot: root,
      runDownloader: vi.fn().mockRejectedValue(new Error('private video')) as never,
    })).rejects.toMatchObject({
      code: 'VIRAL_LINK_DOWNLOAD_FAILED',
    } satisfies Partial<ViralRemoteVideoError>)
  })
})
