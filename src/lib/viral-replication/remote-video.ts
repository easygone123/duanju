import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { VIRAL_UPLOAD_MAX_BYTES } from './constants'

const execFileAsync = promisify(execFile)
const SHARE_TEXT_MAX_CHARS = 4_000
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1_000
const SUPPORTED_HOSTS = ['douyin.com', 'iesdouyin.com'] as const

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
  tempRoot?: string
  binary?: string
  signal?: AbortSignal
}

function isSupportedHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  return SUPPORTED_HOSTS.some((host) => normalized === host || normalized.endsWith(`.${host}`))
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
