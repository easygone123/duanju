import { describe, expect, it } from 'vitest'
import { COMFY_REQUEST_STATUS } from '@/lib/comfyui/types'
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

  it('rejects malformed external ids', () => {
    expect(() => parseComfyExternalId('COMFY:AUDIO:req-1')).toThrow(
      'COMFY_EXTERNAL_ID_INVALID',
    )
  })

  it('rejects unsupported media types and empty request ids when formatting', () => {
    expect(() => formatComfyExternalId('audio' as 'image', 'req-1')).toThrow(
      'COMFY_EXTERNAL_ID_INVALID',
    )
    expect(() => formatComfyExternalId('image', '')).toThrow('COMFY_EXTERNAL_ID_INVALID')
  })
})
