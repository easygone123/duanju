import { COMFY_ERROR_CODE, ComfyError } from './errors'
import type { ComfyMediaType } from './types'

// The final lookahead is a strict end-of-input assertion; JavaScript's `$` also matches
// immediately before a trailing newline, which is not valid in an external ID token.
const COMFY_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?![\s\S])/

export interface ParsedComfyExternalId {
  mediaType: ComfyMediaType
  requestId: string
}

export function formatComfyExternalId(mediaType: ComfyMediaType, requestId: string): string {
  if (
    (mediaType !== 'image' && mediaType !== 'video') ||
    !COMFY_REQUEST_ID_PATTERN.test(requestId)
  ) {
    throw invalidExternalId(requestId)
  }

  return `COMFY:${mediaType.toUpperCase()}:${requestId}`
}

export function parseComfyExternalId(externalId: string): ParsedComfyExternalId {
  const [prefix, mediaTypeToken, requestId, ...extraSegments] = externalId.split(':')
  if (
    prefix !== 'COMFY' ||
    (mediaTypeToken !== 'IMAGE' && mediaTypeToken !== 'VIDEO') ||
    !COMFY_REQUEST_ID_PATTERN.test(requestId ?? '') ||
    extraSegments.length > 0
  ) {
    throw invalidExternalId(externalId)
  }

  return {
    mediaType: mediaTypeToken.toLowerCase() as ComfyMediaType,
    requestId,
  }
}

function invalidExternalId(value: string): ComfyError {
  return new ComfyError(
    COMFY_ERROR_CODE.EXTERNAL_ID_INVALID,
    `Invalid ComfyUI external ID: ${value}`,
  )
}
