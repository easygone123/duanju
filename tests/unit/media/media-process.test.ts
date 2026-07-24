import { afterEach, describe, expect, it, vi } from 'vitest'

const storageMock = vi.hoisted(() => ({
  downloadAndUploadVideo: vi.fn(),
  generateUniqueKey: vi.fn(() => 'generated/result.jpg'),
  toFetchableUrl: vi.fn((value: string) => value),
  uploadObject: vi.fn(),
}))

vi.mock('@/lib/storage', () => storageMock)

import { isComfyStoredOutputKey, processMediaResult } from '@/lib/media-process'

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('media result processing', () => {
  it('reuses a persisted ComfyUI output without fetching or uploading it again', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const source = 'comfyui/user-1/project-1/request-1/output.png'

    await expect(processMediaResult({
      source,
      type: 'image',
      keyPrefix: 'panel-variant',
      targetId: 'panel-1',
    })).resolves.toBe(source)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(storageMock.uploadObject).not.toHaveBeenCalled()
    expect(storageMock.downloadAndUploadVideo).not.toHaveBeenCalled()
  })

  it('rejects unsafe strings as internal ComfyUI storage keys', () => {
    expect(isComfyStoredOutputKey('comfyui/../private.png')).toBe(false)
    expect(isComfyStoredOutputKey('comfyui\\private.png')).toBe(false)
    expect(isComfyStoredOutputKey('comfyui/')).toBe(false)
    expect(isComfyStoredOutputKey('https://store.example/comfyui/output.png')).toBe(false)
  })
})
