import { createHash } from 'node:crypto'

import type { ComfyWorkflowRequirements } from './types'

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
  requirements: ComfyWorkflowRequirements
  client: ComfyCompatibilityClient
  cache?: ComfyCompatibilityCache
}

interface InputEnum {
  values: string[]
  modelFolder?: string
}

const MODEL_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export async function checkComfyCompatibility(
  input: CheckComfyCompatibilityInput,
): Promise<ComfyCompatibilityResult> {
  const objectInfo = await input.client.getObjectInfo()
  const inputEnums = collectInputEnums(objectInfo, input.requirements.nodeClasses)
  const modelFolders = [...new Set(inputEnums.flatMap((entry) =>
    entry.modelFolder ? [entry.modelFolder] : []))].sort()
  const modelsByFolder = Object.fromEntries(await Promise.all(modelFolders.map(async (folder) =>
    [folder, normalizeStringArray(await input.client.getModels(folder))] as const)))
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
  const missingModels = input.requirements.candidateLoaderInputs
    .filter((candidate) => !inputEnums.some((entry) =>
      entry.inputName === candidate.inputName && entry.values.includes(candidate.value)))
    .map((candidate) => ({
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

function collectInputEnums(
  objectInfo: Record<string, unknown>,
  requiredClasses: string[],
): Array<InputEnum & { inputName: string }> {
  const entries: Array<InputEnum & { inputName: string }> = []
  for (const classType of requiredClasses) {
    const schema = objectInfo[classType]
    if (!isRecord(schema) || !isRecord(schema.input)) continue
    for (const groupName of ['required', 'optional']) {
      const group = schema.input[groupName]
      if (!isRecord(group)) continue
      for (const [inputName, definition] of Object.entries(group)) {
        const parsed = parseInputEnum(definition)
        if (parsed) entries.push({ inputName, ...parsed })
      }
    }
  }
  return entries
}

function parseInputEnum(value: unknown): InputEnum | null {
  if (!Array.isArray(value) || !Array.isArray(value[0])) return null
  const values = normalizeStringArray(value[0])
  if (values.length === 0) return null
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
