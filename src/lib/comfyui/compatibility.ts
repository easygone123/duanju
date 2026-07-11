import { createHash } from 'node:crypto'

import { COMFY_ERROR_CODE, ComfyError } from './errors'
import type { ComfyApiWorkflow, ComfyWorkflowRequirements } from './types'

export interface ComfyCompatibilityResult {
  compatible: boolean
  missingNodes: string[]
  missingModels: Array<{ nodeId: string; field: string; value: string }>
  workflowHash: string
  capabilityFingerprint: string
}

export interface ComfyCompatibilityClient {
  getObjectInfo(): Promise<Record<string, unknown>>
  getModels(folder: string): Promise<string[]>
}

export type ComfyCompatibilityCache = Map<string, ComfyCompatibilityResult>

export interface CheckComfyCompatibilityInput {
  connectionId: string
  workflowHash: string
  graph: ComfyApiWorkflow
  requirements: ComfyWorkflowRequirements
  client: ComfyCompatibilityClient
  cache?: ComfyCompatibilityCache
  parseInputEnum?: typeof parseComfyInputEnum
}

interface InputEnum {
  values: string[]
  modelFolder?: string
}

const MODEL_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
export const MAX_COMFY_COMPATIBILITY_CANDIDATES = 256
export const MAX_COMFY_MODEL_FOLDERS = 32
export const MAX_COMFY_MODEL_PROBE_CONCURRENCY = 4
export const MAX_COMFY_ENUM_ENTRIES = 10_000
export const MAX_COMFY_ENUM_VALUE_BYTES = 1_024
export const MAX_COMFY_TOTAL_ENUM_VALUES = 8_192
export const MAX_COMFY_TOTAL_ENUM_BYTES = 1024 * 1024
const MAX_COMFY_MODEL_CATALOG_ENTRIES = 10_000
const MAX_COMFY_MODEL_NAME_LENGTH = 1_024

export async function checkComfyCompatibility(
  input: CheckComfyCompatibilityInput,
): Promise<ComfyCompatibilityResult> {
  if (input.requirements.candidateLoaderInputs.length > MAX_COMFY_COMPATIBILITY_CANDIDATES) {
    throw incompatible('Too many workflow model candidates')
  }
  const objectInfo = await input.client.getObjectInfo()
  const candidateEnums = buildCandidateEnumIndex(
    objectInfo,
    input.graph,
    input.requirements.candidateLoaderInputs,
    input.parseInputEnum ?? parseComfyInputEnum,
  )
  const modelFolders = [...new Set(candidateEnums.flatMap(({ inputEnum }) =>
    inputEnum?.modelFolder ? [inputEnum.modelFolder] : []))].sort()
  if (modelFolders.length > MAX_COMFY_MODEL_FOLDERS) {
    throw incompatible('Too many workflow model folders')
  }
  const folderEntries = await mapWithConcurrency(
    modelFolders,
    MAX_COMFY_MODEL_PROBE_CONCURRENCY,
    async (folder) => [folder, validateModelCatalog(await input.client.getModels(folder))] as const,
  )
  const modelsByFolder = Object.fromEntries(folderEntries)
  const capabilityFingerprint = fingerprint({ objectInfo, modelsByFolder })
  const cacheKey = compatibilityCacheKey(
    input.connectionId,
    input.workflowHash,
    capabilityFingerprint,
  )
  const cached = input.cache?.get(cacheKey)
  if (cached) return cloneResult(cached)

  const missingNodes = input.requirements.nodeClasses
    .filter((classType) => !isRecord(objectInfo[classType]))
    .sort()
  const missingModels = candidateEnums
    .filter(({ candidate, inputEnum }) =>
      inputEnum !== null && !inputEnum.values.includes(candidate.value))
    .map(({ candidate }) => ({
      nodeId: candidate.nodeId,
      field: candidate.inputName,
      value: candidate.value,
    }))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId)
      || left.field.localeCompare(right.field)
      || left.value.localeCompare(right.value))
  const result: ComfyCompatibilityResult = {
    compatible: missingNodes.length === 0 && missingModels.length === 0,
    missingNodes,
    missingModels,
    workflowHash: input.workflowHash,
    capabilityFingerprint,
  }
  if (input.cache) {
    deleteStaleEntries(input.cache, input.connectionId, input.workflowHash, cacheKey)
    input.cache.set(cacheKey, cloneResult(result))
  }
  return result
}

export function compatibilityCacheKey(
  connectionId: string,
  workflowHash: string,
  capabilityFingerprint: string,
) {
  return `${connectionId}:${workflowHash}:${capabilityFingerprint}`
}

function buildCandidateEnumIndex(
  objectInfo: Record<string, unknown>,
  graph: ComfyApiWorkflow,
  candidates: ComfyWorkflowRequirements['candidateLoaderInputs'],
  parser: typeof parseComfyInputEnum,
) {
  const memo = new Map<string | undefined, Map<string, InputEnum | null>>()
  let totalValues = 0
  let totalBytes = 0
  return candidates.map((candidate) => {
    const classType = graph[candidate.nodeId]?.class_type
    let classMemo = memo.get(classType)
    if (!classMemo) {
      classMemo = new Map<string, InputEnum | null>()
      memo.set(classType, classMemo)
    }
    if (!classMemo.has(candidate.inputName)) {
      const inputEnum = parser(readInputDefinition(objectInfo, classType, candidate.inputName))
      if (inputEnum) {
        totalValues += inputEnum.values.length
        totalBytes += inputEnum.values.reduce(
          (sum, value) => sum + Buffer.byteLength(value, 'utf8'), 0,
        )
        if (totalValues > MAX_COMFY_TOTAL_ENUM_VALUES
          || totalBytes > MAX_COMFY_TOTAL_ENUM_BYTES) {
          throw incompatible('ComfyUI input enums exceed compatibility budget')
        }
      }
      classMemo.set(candidate.inputName, inputEnum)
    }
    return { candidate, inputEnum: classMemo.get(candidate.inputName) ?? null }
  })
}

function readInputDefinition(
  objectInfo: Record<string, unknown>,
  classType: string | undefined,
  inputName: string,
): unknown {
  if (!classType) return undefined
  const schema = objectInfo[classType]
  if (!isRecord(schema) || !isRecord(schema.input)) return undefined
  for (const groupName of ['required', 'optional']) {
    const group = schema.input[groupName]
    if (isRecord(group) && inputName in group) return group[inputName]
  }
  return undefined
}

export function parseComfyInputEnum(value: unknown): InputEnum | null {
  if (!Array.isArray(value) || !Array.isArray(value[0])) return null
  if (value[0].length === 0) return null
  if (value[0].length > MAX_COMFY_ENUM_ENTRIES
    || value[0].some((entry) => typeof entry !== 'string'
      || entry.length === 0
      || Buffer.byteLength(entry, 'utf8') > MAX_COMFY_ENUM_VALUE_BYTES)) {
    throw incompatible('Invalid ComfyUI input enum')
  }
  const values = normalizeStringArray(value[0])
  const options = value[1]
  const rawFolder = isRecord(options)
    ? options.model_folder ?? options.modelFolder
    : undefined
  const modelFolder = typeof rawFolder === 'string' && MODEL_FOLDER_PATTERN.test(rawFolder)
    ? rawFolder
    : undefined
  return { values, ...(modelFolder ? { modelFolder } : {}) }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((entry): entry is string =>
    typeof entry === 'string' && entry.length > 0))].sort()
}

function validateModelCatalog(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_COMFY_MODEL_CATALOG_ENTRIES
    || value.some((entry) => typeof entry !== 'string'
      || entry.length === 0 || entry.length > MAX_COMFY_MODEL_NAME_LENGTH)) {
    throw incompatible('Invalid ComfyUI model catalog')
  }
  return normalizeStringArray(value)
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await operation(values[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker))
  return results
}

function incompatible(message: string) {
  return new ComfyError(COMFY_ERROR_CODE.WORKFLOW_INCOMPATIBLE, message)
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]))
}

function deleteStaleEntries(
  cache: ComfyCompatibilityCache,
  connectionId: string,
  workflowHash: string,
  currentKey: string,
) {
  const prefix = `${connectionId}:${workflowHash}:`
  for (const key of cache.keys()) {
    if (key !== currentKey && key.startsWith(prefix)) cache.delete(key)
  }
}

function cloneResult(result: ComfyCompatibilityResult): ComfyCompatibilityResult {
  return {
    ...result,
    missingNodes: [...result.missingNodes],
    missingModels: result.missingModels.map((entry) => ({ ...entry })),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
