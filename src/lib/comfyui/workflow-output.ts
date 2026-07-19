import { COMFY_ERROR_CODE, ComfyError } from './errors'
import { isSafeDottedPath } from './workflow-schema'
import type { ComfyOutputBinding, ComfyOutputRef } from './types'

export function extractComfyOutputs(
  history: unknown,
  spec: ComfyOutputBinding[],
): ComfyOutputRef[] {
  assertOutputSpec(spec)
  const historyOutputs = findHistoryOutputs(history)
  const extracted: ComfyOutputRef[] = []

  for (const binding of spec) {
    const nodeOutput = historyOutputs && Object.hasOwn(historyOutputs, binding.nodeId)
      ? historyOutputs[binding.nodeId]
      : undefined
    const declaredValue = resolveOutputValue(nodeOutput, binding)
    const values = Array.isArray(declaredValue) ? declaredValue : [declaredValue]
    if (declaredValue === undefined || values.length === 0) throw outputMissing(binding)

    for (const value of values) {
      if (!isOutputFile(value)) throw outputMissing(binding)
      extracted.push({
        name: binding.name,
        nodeId: binding.nodeId,
        mediaType: binding.mediaType,
        primary: binding.primary,
        filename: value.filename,
        subfolder: value.subfolder,
        type: value.type,
      })
    }
  }

  return extracted
}

const VIDEO_OUTPUT_FIELD_ALIASES = ['gifs', 'videos', 'files'] as const

function resolveOutputValue(nodeOutput: unknown, binding: ComfyOutputBinding): unknown {
  const declared = getPath(nodeOutput, binding.fieldPath)
  if (declared !== undefined) return declared
  if (binding.mediaType !== 'video'
    || !VIDEO_OUTPUT_FIELD_ALIASES.includes(
      binding.fieldPath as (typeof VIDEO_OUTPUT_FIELD_ALIASES)[number],
    )) return undefined

  const compatible = VIDEO_OUTPUT_FIELD_ALIASES
    .filter((field) => field !== binding.fieldPath)
    .map((field) => getPath(nodeOutput, field))
    .filter((value) => value !== undefined)
  return compatible.length === 1 ? compatible[0] : undefined
}

function assertOutputSpec(spec: ComfyOutputBinding[]): void {
  if (
    spec.length === 0
    || spec.filter((binding) => binding.primary).length !== 1
    || spec.some((binding) => !isSafeDottedPath(binding.fieldPath))
  ) {
    throw new ComfyError(
      COMFY_ERROR_CODE.WORKFLOW_BINDING_INVALID,
      'Output bindings require safe paths and exactly one primary output.',
    )
  }
}

function findHistoryOutputs(history: unknown): Record<string, unknown> | undefined {
  if (!isObject(history)) return undefined
  if (Object.hasOwn(history, 'outputs') && isObject(history.outputs)) return history.outputs

  const candidates = Object.values(history)
    .filter(isObject)
    .map((entry) => entry.outputs)
    .filter(isObject)
  return candidates.length === 1 ? candidates[0] : undefined
}

function getPath(value: unknown, path: string): unknown {
  let cursor = value
  for (const segment of path.split('.')) {
    if (Array.isArray(cursor) && /^\d+$/.test(segment)) {
      cursor = cursor[Number(segment)]
      continue
    }
    if (!isObject(cursor)) return undefined
    if (!Object.hasOwn(cursor, segment)) return undefined
    cursor = cursor[segment]
  }
  return cursor
}

function isOutputFile(value: unknown): value is {
  filename: string
  subfolder: string
  type: string
} {
  return isObject(value)
    && typeof value.filename === 'string'
    && typeof value.subfolder === 'string'
    && typeof value.type === 'string'
}

function outputMissing(binding: ComfyOutputBinding): ComfyError {
  return new ComfyError(
    COMFY_ERROR_CODE.OUTPUT_MISSING,
    `Declared output "${binding.nodeId}.${binding.fieldPath}" is missing.`,
    { details: { nodeId: binding.nodeId, fieldPath: binding.fieldPath } },
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
