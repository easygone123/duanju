import { randomUUID } from 'node:crypto'

import { COMFY_ERROR_CODE, ComfyError } from './errors'
import type {
  ComfyMediaRef,
  ComfyOutputRef,
  ComfyStoredOutputRef,
  ComfyUploadedFile,
  ComfyVariableDefinition,
  ComfyVariableValue,
} from './types'

const DEFAULT_MAX_INPUT_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_TOTAL_INPUT_BYTES = 512 * 1024 * 1024
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024

export interface ComfyMediaClient {
  uploadImage(input: {
    filename: string
    contentType: string
    bytes: Uint8Array
    subfolder?: string
    overwrite?: boolean
  }): Promise<ComfyUploadedFile>
  downloadOutput(ref: ComfyOutputRef): Promise<Buffer>
}

export interface ComfyMediaDependencies {
  toFetchableUrl(value: string): string
  fetchInput(url: string, maxBytes: number): Promise<Buffer>
  uploadObject(bytes: Buffer, key: string, maxRetries: number, contentType: string): Promise<string>
  resolveStoredUrl(key: string): string
  randomId?: () => string
}

export async function prepareComfyMediaUploads(input: {
  userId: string
  requestId: string
  variables: Record<string, ComfyVariableValue>
  definitions: ComfyVariableDefinition[]
  client: ComfyMediaClient
  dependencies: ComfyMediaDependencies
  maxInputBytes?: number
  maxTotalInputBytes?: number
}) {
  const uploads: Record<string, ComfyUploadedFile | ComfyUploadedFile[]> = {}
  let totalBytes = 0
  for (const definition of input.definitions) {
    if (!['image_ref', 'image_ref_list', 'video_ref'].includes(definition.type)) continue
    const raw = input.variables[definition.name]
    if (raw === undefined) continue
    const refs = Array.isArray(raw) ? raw : [raw]
    const uploaded: ComfyUploadedFile[] = []
    for (const candidate of refs) {
      if (!isMediaRef(candidate)) throw inputUploadError()
      const maxBytes = input.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES
      const url = input.dependencies.toFetchableUrl(candidate.storageKey)
      const bytes = await input.dependencies.fetchInput(url, maxBytes)
      totalBytes += bytes.byteLength
      if (bytes.byteLength > maxBytes || totalBytes > (input.maxTotalInputBytes ?? DEFAULT_MAX_TOTAL_INPUT_BYTES)) {
        throw inputUploadError()
      }
      const detected = detectMedia(bytes)
      if (!detected || !matchesDefinition(detected.mimeType, definition.type)) throw inputUploadError()
      const id = input.dependencies.randomId?.() ?? randomUUID()
      const safeStem = safeFilename(candidate.filename ?? definition.name)
      uploaded.push(await input.client.uploadImage({
        filename: `${id}-${safeStem}.${detected.extension}`,
        contentType: detected.mimeType,
        bytes,
        subfolder: `waoowaoo/${safePath(input.userId)}/${safePath(input.requestId)}`,
        overwrite: false,
      }))
    }
    uploads[definition.name] = Array.isArray(raw) ? uploaded : uploaded[0]
  }
  return uploads
}

export async function transferComfyOutputs(input: {
  userId: string
  projectId: string
  requestId: string
  outputs: ComfyOutputRef[]
  client: ComfyMediaClient
  dependencies: ComfyMediaDependencies
  maxOutputBytes?: number
}): Promise<ComfyStoredOutputRef[]> {
  const stored: ComfyStoredOutputRef[] = []
  for (const output of input.outputs) {
    const bytes = await input.client.downloadOutput(output)
    if (bytes.byteLength > (input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)) throw transferError()
    const detected = detectMedia(bytes)
    if (!detected || !detected.mimeType.startsWith(`${output.mediaType}/`)) throw transferError()
    const id = input.dependencies.randomId?.() ?? randomUUID()
    const key = [
      'comfyui', safePath(input.userId), safePath(input.projectId), safePath(input.requestId),
      `${id}-${safeFilename(output.name)}.${detected.extension}`,
    ].join('/')
    const storageKey = await input.dependencies.uploadObject(bytes, key, 1, detected.mimeType)
    stored.push({ ...output, storageKey, url: input.dependencies.resolveStoredUrl(storageKey) })
  }
  return stored
}

function detectMedia(bytes: Uint8Array): { mimeType: string; extension: string } | null {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mimeType: 'image/png', extension: 'png' }
  if (starts(bytes, [0xff, 0xd8, 0xff])) return { mimeType: 'image/jpeg', extension: 'jpg' }
  if (ascii(bytes, 0, 4) === 'GIF8') return { mimeType: 'image/gif', extension: 'gif' }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return { mimeType: 'image/webp', extension: 'webp' }
  if (ascii(bytes, 4, 4) === 'ftyp') return { mimeType: 'video/mp4', extension: 'mp4' }
  if (starts(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return { mimeType: 'video/webm', extension: 'webm' }
  return null
}

function matchesDefinition(mimeType: string, type: ComfyVariableDefinition['type']) {
  return type === 'video_ref' ? mimeType.startsWith('video/') : mimeType.startsWith('image/')
}

function safeFilename(value: string) {
  return value.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'media'
}

function safePath(value: string) {
  return value.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 191) || 'unknown'
}

function starts(bytes: Uint8Array, prefix: number[]) {
  return prefix.every((value, index) => bytes[index] === value)
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return Buffer.from(bytes.subarray(offset, offset + length)).toString('ascii')
}

function isMediaRef(value: unknown): value is ComfyMediaRef {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as ComfyMediaRef).storageKey === 'string'
}

function inputUploadError() {
  return new ComfyError(COMFY_ERROR_CODE.INPUT_UPLOAD_FAILED, 'ComfyUI input media is invalid')
}

function transferError() {
  return new ComfyError(COMFY_ERROR_CODE.OUTPUT_TRANSFER_FAILED, 'ComfyUI output media is invalid', { retryable: true })
}
