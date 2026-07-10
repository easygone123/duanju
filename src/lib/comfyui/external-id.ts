import { COMFY_ERROR_CODE, ComfyError } from './errors'
import type { ComfyMediaType } from './types'

const COMFY_EXTERNAL_ID_PATTERN = /^COMFY:(IMAGE|VIDEO):([^:]+)$/

export interface ParsedComfyExternalId {
  mediaType: ComfyMediaType
  requestId: string
}

export function formatComfyExternalId(mediaType: ComfyMediaType, requestId: string): string {
  if ((mediaType !== 'image' && mediaType !== 'video') || !requestId || requestId.includes(':')) {
    throw invalidExternalId(requestId)
  }

  return `COMFY:${mediaType.toUpperCase()}:${requestId}`
}

export function parseComfyExternalId(externalId: string): ParsedComfyExternalId {
  const match = COMFY_EXTERNAL_ID_PATTERN.exec(externalId)
  if (!match) {
    throw invalidExternalId(externalId)
  }

  return {
    mediaType: match[1].toLowerCase() as ComfyMediaType,
    requestId: match[2],
  }
}

function invalidExternalId(value: string): ComfyError {
  return new ComfyError(
    COMFY_ERROR_CODE.EXTERNAL_ID_INVALID,
    `Invalid ComfyUI external ID: ${value}`,
  )
}
