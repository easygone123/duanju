import { describe, expect, it, vi } from 'vitest'

import { transferComfyOutputs } from '@/lib/comfyui/media'

describe('ComfyUI media external-effect fence', () => {
  it('does not download or store recovered output after reconciliation ownership is lost', async () => {
    const downloadOutput = vi.fn()
    const uploadObject = vi.fn()

    await expect(transferComfyOutputs({
      userId: 'user-1', projectId: 'project-1', requestId: 'request-1',
      outputs: [{
        name: 'primary', nodeId: '1', mediaType: 'image', primary: true,
        filename: 'output.png', subfolder: '', type: 'output',
      }],
      client: { uploadImage: vi.fn(), downloadOutput },
      dependencies: {
        verifyExternalEffect: vi.fn().mockResolvedValue(false),
        resolveOwnedMedia: vi.fn(), readOwnedObject: vi.fn(),
        uploadObject, objectExists: vi.fn(), resolveStoredUrl: vi.fn(),
      },
    })).rejects.toThrow('ComfyUI execution ownership lost')

    expect(downloadOutput).not.toHaveBeenCalled()
    expect(uploadObject).not.toHaveBeenCalled()
  })
})
