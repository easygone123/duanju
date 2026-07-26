import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { VIRAL_UPLOAD_MAX_BYTES } from './constants'
import { writeRequestBodyToTempFile } from './temp-file'

const execFileAsync = promisify(execFile)
const SHARE_TEXT_MAX_CHARS = 4_000
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1_000
const SHARE_PAGE_MAX_BYTES = 2 * 1024 * 1024
const SUPPORTED_HOSTS = ['douyin.com', 'iesdouyin.com'] as const
const SUPPORTED_MEDIA_HOSTS = ['snssdk.com', 'douyinvod.com', 'amemv.com'] as const
const DOUYIN_MOBILE_USER_AGENT = [
  'Mozilla/5.0 (Linux; Android 13; Pixel 7)',
  'AppleWebKit/537.36 (KHTML, like Gecko)',
  'Chrome/120.0.0.0 Mobile Safari/537.36',
].join(' ')

export type ViralRemoteVideoErrorCode =
  | 'VIRAL_LINK_INVALID'
  | 'VIRAL_LINK_DOMAIN_UNSUPPORTED'
  | 'VIRAL_LINK_DOWNLOADER_UNAVAILABLE'
  | 'VIRAL_LINK_DOWNLOAD_FAILED'
  | 'VIRAL_VIDEO_TOO_LARGE'

export class ViralRemoteVideoError extends Error {
  readonly code: ViralRemoteVideoErrorCode

  constructor(code: ViralRemoteVideoErrorCode, message = code) {
    super(message)
    this.name = 'ViralRemoteVideoError'
    this.code = code
  }
}

export type DownloadedViralVideo = {
  filePath: string
  mimeType: 'video/mp4' | 'video/quicktime'
  sizeBytes: number
  cleanup: () => Promise<void>
}

type RemoteVideoDependencies = {
  runDownloader?: typeof execFileAsync
  fetcher?: typeof fetch
  tempRoot?: string
  binary?: string
  signal?: AbortSignal
}

function isSupportedHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  return SUPPORTED_HOSTS.some((host) => normalized === host || normalized.endsWith(`.${host}`))
}

function isSupportedMediaHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  return SUPPORTED_MEDIA_HOSTS.some((host) => normalized === host || normalized.endsWith(`.${host}`))
}

export function extractSupportedViralVideoUrl(shareText: string): URL {
  const normalized = shareText.trim()
  if (!normalized || normalized.length > SHARE_TEXT_MAX_CHARS) {
    throw new ViralRemoteVideoError('VIRAL_LINK_INVALID')
  }
  const match = normalized.match(/https?:\/\/[^\s<>"']+/i)
  if (!match) throw new ViralRemoteVideoError('VIRAL_LINK_INVALID')

  let url: URL
  try {
    url = new URL(match[0].replace(/[，。！？、；：,.!?;:)\]}]+$/u, ''))
  } catch {
    throw new ViralRemoteVideoError('VIRAL_LINK_INVALID')
  }
  if (!isSupportedHost(url.hostname)) {
    throw new ViralRemoteVideoError('VIRAL_LINK_DOMAIN_UNSUPPORTED')
  }
  url.username = ''
  url.password = ''
  url.hash = ''
  return url
}

function readNestedRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const nested = (value as Record<string, unknown>)[key]
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : null
}

function readUrlList(value: unknown): string[] {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
  return Array.isArray(record?.url_list)
    ? record.url_list.filter((item): item is string => typeof item === 'string' && item.startsWith('https://'))
    : []
}

export function extractDouyinPlayUrlFromShareHtml(html: string): string {
  const marker = 'window._ROUTER_DATA = '
  const start = html.indexOf(marker)
  if (start < 0) throw new ViralRemoteVideoError('VIRAL_LINK_DOWNLOAD_FAILED')
  const jsonStart = start + marker.length
  const jsonEnd = html.indexOf('</script>', jsonStart)
  if (jsonEnd < 0) throw new ViralRemoteVideoError('VIRAL_LINK_DOWNLOAD_FAILED')

  let routerData: unknown
  try {
    routerData = JSON.parse(html.slice(jsonStart, jsonEnd).trim().replace(/;$/, ''))
  } catch {
    throw new ViralRemoteVideoError('VIRAL_LINK_DOWNLOAD_FAILED')
  }
  const loaderData = readNestedRecord(routerData, 'loaderData')
  const videoPage = readNestedRecord(loaderData, 'video_(id)/page')
  const videoInfo = readNestedRecord(videoPage, 'videoInfoRes')
  const items = Array.isArray(videoInfo?.item_list) ? videoInfo.item_list : []
  const item = items[0] && typeof items[0] === 'object' && !Array.isArray(items[0])
    ? items[0] as Record<string, unknown>
    : null
  const video = readNestedRecord(item, 'video')
  const directCandidates = [
    ...readUrlList(video?.play_addr),
    ...readUrlList(video?.play_addr_h264),
    ...readUrlList(video?.download_addr),
  ]
  const bitRates = Array.isArray(video?.bit_rate) ? video.bit_rate : []
  for (const bitRate of bitRates) {
    const record = bitRate && typeof bitRate === 'object' && !Array.isArray(bitRate)
      ? bitRate as Record<string, unknown>
      : null
    directCandidates.push(...readUrlList(record?.play_addr))
  }
  const playUrl = directCandidates[0]
  if (!playUrl) throw new ViralRemoteVideoError('VIRAL_LINK_DOWNLOAD_FAILED')
  if (!isSupportedMediaHost(new URL(playUrl).hostname)) {
    throw new ViralRemoteVideoError('VIRAL_LINK_DOWNLOAD_FAILED')
  }
  return playUrl
}

async function downloadFromDouyinSharePage(
  url: URL,
  dependencies: RemoteVideoDependencies,
): Promise<DownloadedViralVideo> {
  const fetcher = dependencies.fetcher ?? fetch
  const headers = {
    'user-agent': DOUYIN_MOBILE_USER_AGENT,
    accept: 'text/html,application/xhtml+xml',
    'accept-language': 'zh-CN,zh;q=0.9',
  }
  const pageResponse = await fetcher(url, {
    headers,
    redirect: 'follow',
    signal: dependencies.signal,
  })
  if (!pageResponse.ok) throw new ViralRemoteVideoError('VIRAL_LINK_DOWNLOAD_FAILED')
  const pageLength = Number(pageResponse.headers.get('content-length') || 0)
  if (pageLength > SHARE_PAGE_MAX_BYTES) {
    throw new ViralRemoteVideoError('VIRAL_LINK_DOWNLOAD_FAILED')
  }
  const html = await pageResponse.text()
  if (Buffer.byteLength(html) > SHARE_PAGE_MAX_BYTES) {
    throw new ViralRemoteVideoError('VIRAL_LINK_DOWNLOAD_FAILED')
  }
  const playUrl = extractDouyinPlayUrlFromShareHtml(html)
  const noWatermarkUrl = playUrl.replace('/aweme/v1/playwm/', '/aweme/v1/play/')
  const playCandidates = [...new Set([noWatermarkUrl, playUrl])]
  for (const candidate of playCandidates) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const videoResponse = await fetcher(candidate, {
          headers: {
            'user-agent': DOUYIN_MOBILE_USER_AGENT,
            referer: pageResponse.url || url.toString(),
            accept: 'video/mp4,video/*;q=0.9,*/*;q=0.8',
          },
          redirect: 'follow',
          signal: dependencies.signal,
        })
        if (!videoResponse.ok || !videoResponse.body) continue
        const declaredSize = Number(videoResponse.headers.get('content-length') || 0)
        if (declaredSize > VIRAL_UPLOAD_MAX_BYTES) {
          throw new ViralRemoteVideoError('VIRAL_VIDEO_TOO_LARGE')
        }
        const tempFile = await writeRequestBodyToTempFile(videoResponse.body, {
          maxBytes: VIRAL_UPLOAD_MAX_BYTES,
          tempRoot: dependencies.tempRoot,
          prefix: 'viral-link-native',
        })
        return {
          filePath: tempFile.filePath,
          mimeType: 'video/mp4',
          sizeBytes: tempFile.sizeBytes,
          cleanup: tempFile.cleanup,
        }
      } catch (error: unknown) {
        if (
          error instanceof ViralRemoteVideoError
          && error.code === 'VIRAL_VIDEO_TOO_LARGE'
        ) {
          throw error
        }
        if (dependencies.signal?.aborted) throw error
      }
    }
  }
  throw new ViralRemoteVideoError('VIRAL_LINK_DOWNLOAD_FAILED')
}

async function findDownloadedVideo(directory: string): Promise<string> {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const candidates = entries
    .filter((entry) => entry.isFile() && /^source\.(?:mp4|mov)$/i.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
  if (candidates.length !== 1) {
    throw new ViralRemoteVideoError('VIRAL_LINK_DOWNLOAD_FAILED')
  }
  return candidates[0]
}

export async function downloadViralVideoFromShareText(
  shareText: string,
  dependencies: RemoteVideoDependencies = {},
): Promise<DownloadedViralVideo> {
  const url = extractSupportedViralVideoUrl(shareText)
  try {
    return await downloadFromDouyinSharePage(url, dependencies)
  } catch (error: unknown) {
    if (error instanceof ViralRemoteVideoError && error.code === 'VIRAL_VIDEO_TOO_LARGE') {
      throw error
    }
    if (dependencies.signal?.aborted) {
      throw new ViralRemoteVideoError('VIRAL_LINK_DOWNLOAD_FAILED')
    }
    // The public mobile share page is the cookie-free primary path. Keep
    // yt-dlp as a fallback in case Douyin changes its SSR payload.
  }

  const tempRoot = dependencies.tempRoot ?? os.tmpdir()
  await fs.mkdir(tempRoot, { recursive: true })
  const directory = await fs.mkdtemp(path.join(tempRoot, 'viral-link-'))
  const cleanup = async () => {
    await fs.rm(directory, { recursive: true, force: true })
  }

  try {
    const runDownloader = dependencies.runDownloader ?? execFileAsync
    const binary = dependencies.binary ?? (process.env.VIRAL_VIDEO_DOWNLOADER_BIN?.trim() || 'yt-dlp')
    try {
      await runDownloader(binary, [
        '--no-config',
        '--no-playlist',
        '--no-progress',
        '--no-warnings',
        '--socket-timeout', '30',
        '--retries', '3',
        '--fragment-retries', '3',
        '--max-filesize', String(VIRAL_UPLOAD_MAX_BYTES),
        '--format', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
        '--merge-output-format', 'mp4',
        '--remux-video', 'mp4',
        '--output', path.join(directory, 'source.%(ext)s'),
        url.toString(),
      ], {
        encoding: 'utf8',
        timeout: DOWNLOAD_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        signal: dependencies.signal,
      })
    } catch (error: unknown) {
      if (
        error
        && typeof error === 'object'
        && 'code' in error
        && error.code === 'ENOENT'
      ) {
        throw new ViralRemoteVideoError('VIRAL_LINK_DOWNLOADER_UNAVAILABLE')
      }
      throw new ViralRemoteVideoError('VIRAL_LINK_DOWNLOAD_FAILED')
    }

    const filePath = await findDownloadedVideo(directory)
    const stat = await fs.stat(filePath)
    if (!stat.isFile() || stat.size <= 0) {
      throw new ViralRemoteVideoError('VIRAL_LINK_DOWNLOAD_FAILED')
    }
    if (stat.size > VIRAL_UPLOAD_MAX_BYTES) {
      throw new ViralRemoteVideoError('VIRAL_VIDEO_TOO_LARGE')
    }
    return {
      filePath,
      mimeType: filePath.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/mp4',
      sizeBytes: stat.size,
      cleanup,
    }
  } catch (error: unknown) {
    await cleanup()
    if (error instanceof ViralRemoteVideoError) throw error
    throw new ViralRemoteVideoError('VIRAL_LINK_DOWNLOAD_FAILED')
  }
}
