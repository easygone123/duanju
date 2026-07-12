import { ApiError } from '@/lib/api-errors'

export const MAX_WORKFLOW_JSON_BYTES = 4 * 1024 * 1024
export const MAX_WORKFLOW_CONTRACT_BYTES = 6 * 1024 * 1024
export const MAX_WORKFLOW_DEPTH = 64
export const MAX_WORKFLOW_NODES = 2_000
export const MAX_WORKFLOW_VALUES = 100_000
export const MAX_WORKFLOW_KEYS = 50_000
export const MAX_LIVE_VARIABLES = 256
export const MAX_LIVE_VARIABLE_BYTES = 256 * 1024

export async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  if (!request.body) throw new ApiError('INVALID_PARAMS')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new ApiError('INVALID_PARAMS')
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError('INVALID_PARAMS')
  }
}

export function assertBoundedWorkflowJson(value: unknown) {
  assertBoundedJson(value, {
    maxBytes: MAX_WORKFLOW_JSON_BYTES,
    maxDepth: MAX_WORKFLOW_DEPTH,
    maxValues: MAX_WORKFLOW_VALUES,
    maxKeys: MAX_WORKFLOW_KEYS,
  })
  if (isObject(value) && Object.keys(value).length > MAX_WORKFLOW_NODES) invalid()
}

export function assertBoundedWorkflowContract(value: {
  purpose?: unknown
  graph: unknown
  variableDefinitions: unknown
  bindings: unknown
  outputs: unknown
}) {
  assertBoundedJson(value, {
    maxBytes: MAX_WORKFLOW_CONTRACT_BYTES,
    maxDepth: MAX_WORKFLOW_DEPTH,
    maxValues: MAX_WORKFLOW_VALUES,
    maxKeys: MAX_WORKFLOW_KEYS,
  })
  if (isObject(value.graph) && Object.keys(value.graph).length > MAX_WORKFLOW_NODES) invalid()
}

export function isBoundedLiveVariables(value: unknown) {
  try {
    if (!isObject(value) || Object.keys(value).length > MAX_LIVE_VARIABLES) return false
    assertBoundedJson(value, {
      maxBytes: MAX_LIVE_VARIABLE_BYTES, maxDepth: 16, maxValues: 4_096, maxKeys: 2_048,
    })
    return true
  } catch {
    return false
  }
}

function assertBoundedJson(value: unknown, limits: {
  maxBytes: number
  maxDepth: number
  maxValues: number
  maxKeys: number
}) {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const seen = new WeakSet<object>()
  let bytes = 0
  let values = 0
  let keys = 0
  while (stack.length > 0) {
    const entry = stack.pop()!
    values += 1
    if (values > limits.maxValues || entry.depth > limits.maxDepth) invalid()
    if (typeof entry.value === 'string') bytes += Buffer.byteLength(JSON.stringify(entry.value))
    else if (entry.value === null) bytes += 4
    else if (typeof entry.value === 'number' || typeof entry.value === 'boolean') {
      bytes += String(entry.value).length
    } else if (Array.isArray(entry.value)) {
      if (seen.has(entry.value)) invalid()
      seen.add(entry.value)
      bytes += entry.value.length + 2
      for (const child of entry.value) stack.push({ value: child, depth: entry.depth + 1 })
    } else if (isObject(entry.value)) {
      if (seen.has(entry.value)) invalid()
      seen.add(entry.value)
      const entries = Object.entries(entry.value)
      keys += entries.length
      if (keys > limits.maxKeys) invalid()
      bytes += entries.length + 2
      for (const [key, child] of entries) {
        bytes += Buffer.byteLength(JSON.stringify(key)) + 1
        stack.push({ value: child, depth: entry.depth + 1 })
      }
    } else {
      invalid()
    }
    if (bytes > limits.maxBytes) invalid()
  }
}

function invalid(): never {
  throw new ApiError('INVALID_PARAMS')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
