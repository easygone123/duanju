import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  downloadViralVideoFromShareText,
  extractDouyinPlayUrlFromShareHtml,
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
  const shareHtml = (playUrl = 'https://aweme.snssdk.com/aweme/v1/playwm/?video_id=source') => (
    `<html><script>window._ROUTER_DATA = ${JSON.stringify({
      loaderData: {
        'video_(id)/page': {
          videoInfoRes: {
            item_list: [{
              video: { play_addr: { url_list: [playUrl] } },
            }],
          },
        },
      },
    })}</script></html>`
  )

  it('extracts official Douyin URLs from full share text', () => {
    expect(extractSupportedViralVideoUrl(
      '复制此链接打开抖音 https://v.douyin.com/abc123/ 看视频！',
    ).toString()).toBe('https://v.douyin.com/abc123/')
  })

  it('extracts the public play address from Douyin mobile share metadata', () => {
    expect(extractDouyinPlayUrlFromShareHtml(shareHtml()))
      .toBe('https://aweme.snssdk.com/aweme/v1/playwm/?video_id=source')
    expect(() => extractDouyinPlayUrlFromShareHtml('<html></html>')).toThrowError(
      expect.objectContaining({ code: 'VIRAL_LINK_DOWNLOAD_FAILED' }),
    )
  })

  it('downloads directly from the public mobile share page without cookies', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viral-link-test-'))
    cleanupRoots.push(root)
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(shareHtml(), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }))
      .mockResolvedValueOnce(new Response(Buffer.from('video'), {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': '5' },
      }))
    const runDownloader = vi.fn()

    const result = await downloadViralVideoFromShareText('https://v.douyin.com/abc/', {
      tempRoot: root,
      fetcher,
      runDownloader: runDownloader as never,
    })
    expect(result).toMatchObject({ mimeType: 'video/mp4', sizeBytes: 5 })
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://aweme.snssdk.com/aweme/v1/play/?video_id=source',
      expect.objectContaining({ redirect: 'follow' }),
    )
    expect(runDownloader).not.toHaveBeenCalled()
    await result.cleanup()
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
      fetcher: vi.fn().mockRejectedValue(new Error('share page unavailable')),
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
      fetcher: vi.fn().mockRejectedValue(new Error('share page unavailable')),
      runDownloader: vi.fn().mockRejectedValue(missingDownloader) as never,
    })).rejects.toMatchObject({
      code: 'VIRAL_LINK_DOWNLOADER_UNAVAILABLE',
    } satisfies Partial<ViralRemoteVideoError>)

    await expect(downloadViralVideoFromShareText('https://v.douyin.com/abc/', {
      tempRoot: root,
      fetcher: vi.fn().mockRejectedValue(new Error('share page unavailable')),
      runDownloader: vi.fn().mockRejectedValue(new Error('private video')) as never,
    })).rejects.toMatchObject({
      code: 'VIRAL_LINK_DOWNLOAD_FAILED',
    } satisfies Partial<ViralRemoteVideoError>)
  })
})
