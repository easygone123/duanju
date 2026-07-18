import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  getInternalObjectUrl: vi.fn(),
  getMediaObjectByPublicId: vi.fn(),
  getSignedUrl: vi.fn((key: string) => `http://localhost:19000/waoowaoo/${key}?signed=browser`),
  toFetchableUrl: vi.fn((url: string) => url),
}))

vi.mock('@/lib/media/service', () => ({
  getMediaObjectByPublicId: mocks.getMediaObjectByPublicId,
}))

vi.mock('@/lib/storage', () => ({
  getInternalObjectUrl: mocks.getInternalObjectUrl,
  getSignedUrl: mocks.getSignedUrl,
  toFetchableUrl: mocks.toFetchableUrl,
}))

import { GET } from '@/app/m/[publicId]/route'

function mediaFixture(overrides: { storageKey: string; mimeType: string }) {
  return {
    id: 'media-1',
    publicId: 'public-1',
    url: '/m/public-1',
    storageKey: overrides.storageKey,
    sha256: 'sha256-media-1',
    mimeType: overrides.mimeType,
    sizeBytes: null,
    width: null,
    height: null,
    durationMs: null,
    updatedAt: '2026-07-18T00:00:00.000Z',
  }
}

describe('media proxy route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', mocks.fetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches an image through the internal storage URL', async () => {
    const storageKey = 'projects/panel.png'
    const internalUrl = 'http://minio:9000/waoowaoo/projects/panel.png?signed=1'
    const bytes = new Uint8Array([1, 2, 3, 4])
    mocks.getMediaObjectByPublicId.mockResolvedValue(mediaFixture({ storageKey, mimeType: 'image/png' }))
    mocks.getInternalObjectUrl.mockResolvedValue(internalUrl)
    mocks.fetch.mockResolvedValue(new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(bytes.byteLength),
      },
    }))

    const response = await GET(
      new NextRequest('http://localhost/m/public-1'),
      { params: Promise.resolve({ publicId: 'public-1' }) },
    )

    expect(mocks.getInternalObjectUrl).toHaveBeenCalledWith(storageKey)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    const [fetchUrl, fetchInit] = mocks.fetch.mock.calls[0]
    expect(fetchUrl).toBe(internalUrl)
    expect(new Headers(fetchInit?.headers).has('range')).toBe(false)
    expect(mocks.getSignedUrl).not.toHaveBeenCalled()
    expect(mocks.toFetchableUrl).not.toHaveBeenCalled()

    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength))
    expect(response.headers.get('etag')).toBe('"sha256-media-1"')
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  it('forwards a video Range request and preserves the partial response', async () => {
    const storageKey = 'projects/clip.mp4'
    const internalUrl = 'http://minio:9000/waoowaoo/projects/clip.mp4?signed=1'
    const bytes = new Uint8Array(1024).fill(7)
    const upstream = new Response(bytes, {
      status: 206,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': '1024',
        'Content-Range': 'bytes 0-1023/4096',
        'Accept-Ranges': 'bytes',
      },
    })
    mocks.getMediaObjectByPublicId.mockResolvedValue(mediaFixture({ storageKey, mimeType: 'video/mp4' }))
    mocks.getInternalObjectUrl.mockResolvedValue(internalUrl)
    mocks.fetch.mockResolvedValue(upstream)

    const response = await GET(
      new NextRequest('http://localhost/m/public-1', {
        headers: { Range: 'bytes=0-1023' },
      }),
      { params: Promise.resolve({ publicId: 'public-1' }) },
    )

    expect(mocks.getInternalObjectUrl).toHaveBeenCalledWith(storageKey)
    expect(mocks.fetch).toHaveBeenCalledWith(internalUrl, {
      headers: { Range: 'bytes=0-1023' },
    })
    expect(mocks.getSignedUrl).not.toHaveBeenCalled()
    expect(mocks.toFetchableUrl).not.toHaveBeenCalled()

    expect(response.status).toBe(206)
    expect(response.body).toBe(upstream.body)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('content-length')).toBe('1024')
    expect(response.headers.get('content-range')).toBe('bytes 0-1023/4096')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  })
})
