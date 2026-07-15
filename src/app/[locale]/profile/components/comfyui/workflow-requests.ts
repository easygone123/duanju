import { apiFetch } from '@/lib/api-fetch'
import type {
  CanonicalWorkflowInput,
  WorkflowAutoMappingResult,
  WorkflowImportKind,
} from '@/lib/comfyui/workflow-auto-mapping-types'
import { WORKFLOW_IMPORT_KIND_META } from '@/lib/comfyui/workflow-auto-mapping-types'
import {
  isComfyTransformCompatible,
  isSafeDottedPath,
  validateComfyApiWorkflow,
  validateWorkflowContract,
} from '@/lib/comfyui/workflow-schema'
import type { ComfyVariableType } from '@/lib/comfyui/types'
import {
  analyzeComfyApiWorkflow,
  unwrapComfyApiWorkflowPayload,
} from '@/lib/comfyui/workflow-auto-mapper'
import {
  parseWorkflowImportText,
  readWorkflowImportFile,
  workflowPayload,
  workflowRequestErrorFromPayload,
  WorkflowRequestError,
  type WorkflowAuthorDraft,
} from './workflow-ui'

const ANALYZE_ENDPOINT = '/api/comfyui/workflows/analyze'
const WORKFLOWS_ENDPOINT = '/api/comfyui/workflows'
const CANONICAL_INPUTS = new Set([
  'prompt', 'negativePrompt', 'width', 'height', 'seed', 'sourceImage',
  'referenceImages', 'duration', 'fps', 'firstFrame', 'lastFrame', 'sourceVideo',
])
const VARIABLE_TYPES = new Set(['string', 'number', 'boolean', 'image_ref', 'image_ref_list', 'video_ref'])
const MAPPING_CONFIDENCE = new Set(['high', 'ambiguous', 'preserve_original', 'blocking'])
const BINDING_TRANSFORMS = new Set(['filename', 'image_ref', 'filename_list', 'filename_at'])
const CANONICAL_VALUE_TYPES: Record<CanonicalWorkflowInput, ComfyVariableType> = {
  prompt: 'string',
  negativePrompt: 'string',
  width: 'number',
  height: 'number',
  seed: 'number',
  sourceImage: 'image_ref',
  referenceImages: 'image_ref_list',
  duration: 'number',
  fps: 'number',
  firstFrame: 'image_ref',
  lastFrame: 'image_ref',
  sourceVideo: 'video_ref',
}

export interface WorkflowAnalysisResponse {
  sourceText: string
  analysis: WorkflowAutoMappingResult
}

function isJsonResponse(response: Response) {
  const contentType = response.headers.get('content-type')?.toLocaleLowerCase() ?? ''
  return contentType.includes('application/json') || contentType.includes('+json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isAllowedValue(value: unknown, allowed: ReadonlySet<string>): value is string {
  return typeof value === 'string' && allowed.has(value)
}

function isWorkflowGraph(value: unknown) {
  return isRecord(value) && Object.entries(value).every(([nodeId, node]) => isNonEmptyString(nodeId)
    && nodeId.trim() === nodeId
    && isRecord(node)
    && isNonEmptyString(node.class_type)
    && isRecord(node.inputs))
}

function isMappingProposal(value: unknown) {
  if (!isRecord(value)) return false
  return isNonEmptyString(value.id)
    && isAllowedValue(value.canonicalName, CANONICAL_INPUTS)
    && isNonEmptyString(value.nodeId)
    && isNonEmptyString(value.inputPath)
    && isAllowedValue(value.valueType, VARIABLE_TYPES)
    && isAllowedValue(value.confidence, MAPPING_CONFIDENCE)
    && isNonEmptyString(value.reasonCode)
    && typeof value.required === 'boolean'
    && (value.transform === undefined || isAllowedValue(value.transform, BINDING_TRANSFORMS))
    && (value.referenceIndex === undefined
      || (Number.isInteger(value.referenceIndex) && Number(value.referenceIndex) >= 0))
    && (value.nodeTitle === undefined || typeof value.nodeTitle === 'string')
}

function isOutputBinding(value: unknown) {
  if (!isRecord(value)) return false
  return isNonEmptyString(value.name)
    && isNonEmptyString(value.nodeId)
    && isNonEmptyString(value.fieldPath)
    && (value.mediaType === 'image' || value.mediaType === 'video')
    && typeof value.primary === 'boolean'
}

function isValidationIssue(value: unknown) {
  if (!isRecord(value)) return false
  return isNonEmptyString(value.code)
    && isNonEmptyString(value.message)
    && (value.path === undefined || typeof value.path === 'string')
}

async function safeResponseJson(response: Response): Promise<unknown> {
  if (!isJsonResponse(response)) return null
  return response.json().catch(() => null)
}

function isWorkflowAnalysis(value: unknown): value is WorkflowAutoMappingResult {
  if (!isRecord(value)) return false
  const item = value
  return isWorkflowGraph(item.graph)
    && (item.mediaType === 'image' || item.mediaType === 'video')
    && (item.purpose === 'generation' || item.purpose === 'upscale')
    && Array.isArray(item.proposals) && item.proposals.every(isMappingProposal)
    && Array.isArray(item.outputs) && item.outputs.every(isOutputBinding)
    && Array.isArray(item.issues) && item.issues.every(isValidationIssue)
    && Number.isInteger(item.referenceCapacity) && Number(item.referenceCapacity) >= 0
}

function malformedWorkflowResponse(): WorkflowRequestError {
  return new WorkflowRequestError('UNKNOWN')
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalizeJson(value[key])]))
}

function jsonEqual(left: unknown, right: unknown) {
  return JSON.stringify(canonicalizeJson(left)) === JSON.stringify(canonicalizeJson(right))
}

function hasDottedInput(graph: WorkflowAutoMappingResult['graph'], nodeId: string, path: string) {
  let value: unknown = graph[nodeId]?.inputs
  for (const segment of path.split('.')) {
    if (!isRecord(value) || !Object.hasOwn(value, segment)) return false
    value = value[segment]
  }
  return true
}

function hasDuplicate(values: string[]) {
  return new Set(values).size !== values.length
}

function validatesSharedContract(analysis: WorkflowAutoMappingResult) {
  const variableDefinitions = analysis.proposals.map((proposal, index) => ({
    name: `mapping${index}`,
    type: proposal.valueType,
    required: true,
    ...(proposal.valueType === 'image_ref_list'
      ? { maxItems: Math.max(analysis.referenceCapacity, (proposal.referenceIndex ?? 0) + 1, 1) }
      : {}),
  }))
  const bindings = analysis.proposals.map((proposal, index) => ({
    nodeId: proposal.nodeId,
    inputPath: proposal.inputPath,
    variable: `mapping${index}`,
    valueType: proposal.valueType,
    ...(proposal.transform ? { transform: proposal.transform } : {}),
    ...(proposal.transform === 'filename_at' ? { valueIndex: proposal.referenceIndex } : {}),
  }))
  const outputs = analysis.outputs.map((output, index) => ({ ...output, primary: index === 0 }))
  const toleratedIssues = new Set([
    'COMFY_OUTPUT_REQUIRED',
    'COMFY_OUTPUT_PRIMARY_INVALID',
    'COMFY_UPSCALE_OUTPUT_REQUIRED',
  ])
  return validateWorkflowContract({
    graph: analysis.graph,
    purpose: analysis.purpose,
    variableDefinitions,
    bindings,
    outputs,
  }).every((issue) => toleratedIssues.has(issue.code))
}

function isConsistentWorkflowAnalysis(
  kind: WorkflowImportKind,
  uploadedGraph: Record<string, unknown>,
  analysis: WorkflowAutoMappingResult,
) {
  const meta = WORKFLOW_IMPORT_KIND_META[kind]
  if (analysis.mediaType !== meta.mediaType || analysis.purpose !== meta.purpose) return false

  try {
    validateComfyApiWorkflow(analysis.graph)
  } catch {
    return false
  }
  if (!jsonEqual(uploadedGraph, analysis.graph)) return false

  if (hasDuplicate(analysis.proposals.map((proposal) => proposal.id))) return false
  if (hasDuplicate(analysis.proposals.map((proposal) => `${proposal.nodeId}\u0000${proposal.inputPath}`))) return false
  const referenceIndexes: number[] = []
  for (const proposal of analysis.proposals) {
    if (!Object.hasOwn(analysis.graph, proposal.nodeId)
      || !isSafeDottedPath(proposal.inputPath)
      || !hasDottedInput(analysis.graph, proposal.nodeId, proposal.inputPath)
      || proposal.valueType !== CANONICAL_VALUE_TYPES[proposal.canonicalName]
      || proposal.required !== meta.requiredInputs.includes(proposal.canonicalName)) return false
    if (proposal.transform && !isComfyTransformCompatible(proposal.transform, proposal.valueType)) return false
    if (proposal.transform === 'filename_at' && proposal.referenceIndex === undefined) return false
    if (proposal.referenceIndex !== undefined) {
      if (proposal.canonicalName !== 'referenceImages'
        || proposal.valueType !== 'image_ref_list'
        || proposal.referenceIndex >= analysis.referenceCapacity) return false
      referenceIndexes.push(proposal.referenceIndex)
    }
  }
  if (hasDuplicate(referenceIndexes.map(String))) return false

  if (hasDuplicate(analysis.outputs.map((output) => output.name))) return false
  if (hasDuplicate(analysis.outputs.map((output) => `${output.nodeId}\u0000${output.fieldPath}`))) return false
  for (const output of analysis.outputs) {
    if (!Object.hasOwn(analysis.graph, output.nodeId)
      || !isSafeDottedPath(output.fieldPath)
      || output.mediaType !== analysis.mediaType) return false
  }
  const primaryCount = analysis.outputs.filter((output) => output.primary).length
  if (primaryCount > 1 || (analysis.outputs.length === 1 && primaryCount !== 1)) return false

  if (!validatesSharedContract(analysis)) return false
  try {
    return jsonEqual(analysis, analyzeComfyApiWorkflow({ graph: uploadedGraph, kind }))
  } catch {
    return false
  }
}

async function workflowApiFetch(endpoint: string, init: RequestInit): Promise<Response> {
  try {
    return await apiFetch(endpoint, init)
  } catch (error) {
    if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') throw error
    throw new WorkflowRequestError('NETWORK_ERROR')
  }
}

export async function analyzeWorkflowJson(
  kind: WorkflowImportKind,
  file: File,
  signal?: AbortSignal,
): Promise<WorkflowAnalysisResponse> {
  const sourceText = await readWorkflowImportFile(file)
  const apiFormatJson = parseWorkflowImportText(sourceText)
  const response = await workflowApiFetch(ANALYZE_ENDPOINT, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, apiFormatJson }),
  })
  const payload = await safeResponseJson(response)
  if (!response.ok) throw workflowRequestErrorFromPayload(payload, response.status)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw malformedWorkflowResponse()
  }
  const analysis = (payload as Record<string, unknown>).analysis
  if (!isWorkflowAnalysis(analysis)) throw malformedWorkflowResponse()
  const expectedGraph = unwrapComfyApiWorkflowPayload(apiFormatJson)
  if (!isRecord(expectedGraph)
    || !isConsistentWorkflowAnalysis(kind, expectedGraph, analysis)) throw malformedWorkflowResponse()
  return {
    sourceText: expectedGraph === apiFormatJson ? sourceText : JSON.stringify(expectedGraph, null, 2),
    analysis,
  }
}

export async function createWorkflowDraft(
  draft: WorkflowAuthorDraft,
  creationId: string,
): Promise<string> {
  const body = JSON.stringify({
    ...workflowPayload(draft),
    name: draft.name,
    mediaType: draft.mediaType,
    creationId,
  })
  const response = await workflowApiFetch(WORKFLOWS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  const payload = await safeResponseJson(response)
  if (!response.ok) throw workflowRequestErrorFromPayload(payload, response.status)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw malformedWorkflowResponse()
  }
  const workflow = (payload as Record<string, unknown>).workflow
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw malformedWorkflowResponse()
  }
  const id = (workflow as Record<string, unknown>).id
  if (typeof id !== 'string') throw malformedWorkflowResponse()
  const normalizedId = id.trim()
  if (!normalizedId) throw malformedWorkflowResponse()
  return normalizedId
}
