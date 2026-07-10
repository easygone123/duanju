import { describe, expect, it } from 'vitest'
import { COMFY_REQUEST_STATUS } from '@/lib/comfyui/types'
import { COMFY_ERROR_CODE, ComfyError } from '@/lib/comfyui/errors'
import { formatComfyExternalId, parseComfyExternalId } from '@/lib/comfyui/external-id'

describe('ComfyUI domain contract', () => {
  it.each(['image', 'video'] as const)('round-trips %s external ids', (mediaType) => {
    expect(parseComfyExternalId(formatComfyExternalId(mediaType, 'req-1'))).toEqual({
      mediaType,
      requestId: 'req-1',
    })
  })

  it('declares durable waiting and reconciliation statuses', () => {
    expect(COMFY_REQUEST_STATUS.WAITING_CAPACITY).toBe('waiting_capacity')
    expect(COMFY_REQUEST_STATUS.RECONCILING).toBe('reconciling')
  })

  it.each([
    ['unsupported type', 'COMFY:AUDIO:req-1'],
    ['whitespace', 'COMFY:IMAGE:req 1'],
    ['trailing newline', 'COMFY:IMAGE:req-1\n'],
    ['control character', 'COMFY:IMAGE:req\u00001'],
    ['lowercase prefix', 'comfy:IMAGE:req-1'],
    ['lowercase type', 'COMFY:image:req-1'],
    ['empty request id', 'COMFY:IMAGE:'],
    ['extra segment', 'COMFY:IMAGE:req-1:extra'],
  ])('rejects malformed external ids: %s', (_case, externalId) => {
    const error = captureError(() => parseComfyExternalId(externalId))

    expect(error).toBeInstanceOf(ComfyError)
    expect((error as ComfyError).code).toBe(COMFY_ERROR_CODE.EXTERNAL_ID_INVALID)
    expect((error as ComfyError).retryable).toBe(false)
  })

  it('rejects unsupported media types when formatting', () => {
    expect(() => formatComfyExternalId('audio' as 'image', 'req-1')).toThrow(
      'COMFY_EXTERNAL_ID_INVALID',
    )
  })

  it.each(['', ' req-1', 'req 1', 'req-1\n', 'req\u00001', 'req-1:extra'])(
    'rejects malformed request tokens when formatting: %j',
    (requestId) => {
      const error = captureError(() => formatComfyExternalId('image', requestId))

      expect(error).toBeInstanceOf(ComfyError)
      expect((error as ComfyError).code).toBe(COMFY_ERROR_CODE.EXTERNAL_ID_INVALID)
      expect((error as ComfyError).retryable).toBe(false)
    },
  )

  it('preserves ComfyError cause, details, and retryability', () => {
    const cause = new Error('upstream')
    const details = { nodeId: '7' }
    const error = new ComfyError(COMFY_ERROR_CODE.EXECUTION_FAILED, 'failed', {
      cause,
      details,
      retryable: true,
    })

    expect(error.cause).toBe(cause)
    expect(error.details).toBe(details)
    expect(error.retryable).toBe(true)
  })
})

function captureError(callback: () => unknown): unknown {
  try {
    callback()
  } catch (error) {
    return error
  }

  return undefined
}
