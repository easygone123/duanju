import { comfyAuthSecrets } from './auth'
import { COMFY_ERROR_CODE, ComfyError, type ComfyErrorCode } from './errors'
import type { ComfyApiWorkflow, ComfyConnectionAuth } from './types'

export interface ComfyHttpErrorContext {
  auth: ComfyConnectionAuth
  workflow?: ComfyApiWorkflow
}

export async function readComfySuccessBody(
  response: Response,
  limit: number,
  errorCode: ComfyErrorCode,
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw bodyTooLarge(errorCode)
  if (!response.body) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let size = 0
  for await (const rawChunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    const chunk = Buffer.from(rawChunk)
    size += chunk.length
    if (size > limit) throw bodyTooLarge(errorCode)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export async function buildComfyHttpError(
  response: Response,
  limit: number,
  operationCode: ComfyErrorCode,
  context: ComfyHttpErrorContext,
): Promise<ComfyError> {
  const errorBody = await readErrorBody(response, limit)
  const authFailed = response.status === 401 || response.status === 403
  const code = authFailed ? COMFY_ERROR_CODE.AUTH_FAILED : operationCode
  const details: Record<string, unknown> = {
    httpStatus: response.status,
    bodyTruncated: errorBody.truncated,
  }
  if (operationCode === COMFY_ERROR_CODE.PROMPT_REJECTED && !authFailed) {
    const parsed = parseJsonObject(errorBody.bytes.toString('utf8'))
    details.nodeErrors = sanitizeNodeErrors(parsed?.node_errors, context)
  }
  return new ComfyError(
    code,
    authFailed
      ? 'ComfyUI authentication failed'
      : operationCode === COMFY_ERROR_CODE.PROMPT_REJECTED
        ? 'ComfyUI prompt rejected'
        : 'ComfyUI request failed',
    { details },
  )
}

export function sanitizeComfyNodeErrors(
  value: unknown,
  context: ComfyHttpErrorContext,
): Record<string, unknown> {
  return sanitizeNodeErrors(value, context)
}

function sanitizeNodeErrors(
  value: unknown,
  context: ComfyHttpErrorContext,
): Record<string, unknown> {
  if (!isRecord(value)) return {}
  const redactions = [
    ...comfyAuthSecrets(context.auth),
    ...collectStringLeaves(context.workflow),
  ].filter(Boolean)
  const entries = Object.entries(value).slice(0, 100).map(([rawNodeId, rawNode]) => {
    const nodeId = redactDiagnostic(rawNodeId, redactions, 128)
    const node = isRecord(rawNode) ? rawNode : {}
    const rawClassType = typeof node.class_type === 'string'
      ? node.class_type
      : typeof node.classType === 'string'
        ? node.classType
        : undefined
    const errors = Array.isArray(node.errors)
      ? node.errors.slice(0, 20).map((rawError) => sanitizeNodeError(rawError, redactions))
      : []
    return [nodeId, {
      nodeId,
      ...(rawClassType ? { classType: redactDiagnostic(rawClassType, redactions, 128) } : {}),
      errors,
    }]
  })
  return Object.fromEntries(entries)
}

function sanitizeNodeError(value: unknown, redactions: string[]): Record<string, string> {
  const error = isRecord(value) ? value : {}
  const type = typeof error.type === 'string'
    ? redactDiagnostic(error.type, redactions, 128)
    : undefined
  const code = typeof error.code === 'string'
    ? redactDiagnostic(error.code, redactions, 128)
    : undefined
  const rawMessage = typeof error.message === 'string'
    ? error.message
    : typeof error.details === 'string'
      ? error.details
      : 'Validation failed'
  return {
    ...(type ? { type } : {}),
    ...(code ? { code } : {}),
    message: redactDiagnostic(rawMessage, redactions, 512),
  }
}

function collectStringLeaves(value: unknown): string[] {
  const leaves: string[] = []
  const pending: unknown[] = [value]
  while (pending.length > 0 && leaves.length < 10_000) {
    const current = pending.pop()
    if (typeof current === 'string') leaves.push(current)
    else if (Array.isArray(current)) pending.push(...current)
    else if (isRecord(current)) pending.push(...Object.values(current))
  }
  return leaves
}

function redactDiagnostic(value: string, redactions: string[], limit: number): string {
  return redactions.some((secret) => value.includes(secret)) ? '[REDACTED]' : bound(value, limit)
}

function bound(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

async function readErrorBody(
  response: Response,
  limit: number,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  const declaredHeader = response.headers.get('content-length')
  const declaredLength = declaredHeader === null ? undefined : Number(declaredHeader)
  if (declaredLength !== undefined && Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel()
    return { bytes: Buffer.alloc(0), truncated: true }
  }
  if (!response.body) return { bytes: Buffer.alloc(0), truncated: false }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return { bytes: Buffer.concat(chunks), truncated: false }
      const chunk = Buffer.from(value)
      size += chunk.length
      if (size > limit) {
        await reader.cancel()
        return { bytes: Buffer.alloc(0), truncated: true }
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function bodyTooLarge(code: ComfyErrorCode): ComfyError {
  return new ComfyError(code, 'ComfyUI response exceeded size limit')
}
