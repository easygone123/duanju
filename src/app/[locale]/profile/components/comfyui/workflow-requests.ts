import { apiFetch } from '@/lib/api-fetch'
import type {
  WorkflowAutoMappingResult,
  WorkflowImportKind,
} from '@/lib/comfyui/workflow-auto-mapping-types'
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

function isMappingProposal(value: unknown) {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && CANONICAL_INPUTS.has(String(value.canonicalName))
    && typeof value.nodeId === 'string'
    && typeof value.inputPath === 'string'
    && VARIABLE_TYPES.has(String(value.valueType))
    && MAPPING_CONFIDENCE.has(String(value.confidence))
    && typeof value.reasonCode === 'string'
    && typeof value.required === 'boolean'
    && (value.transform === undefined || BINDING_TRANSFORMS.has(String(value.transform)))
    && (value.referenceIndex === undefined
      || (Number.isInteger(value.referenceIndex) && Number(value.referenceIndex) >= 0))
    && (value.nodeTitle === undefined || typeof value.nodeTitle === 'string')
}

function isOutputBinding(value: unknown) {
  if (!isRecord(value)) return false
  return typeof value.name === 'string'
    && typeof value.nodeId === 'string'
    && typeof value.fieldPath === 'string'
    && (value.mediaType === 'image' || value.mediaType === 'video')
    && typeof value.primary === 'boolean'
}

function isValidationIssue(value: unknown) {
  if (!isRecord(value)) return false
  return typeof value.code === 'string'
    && typeof value.message === 'string'
    && (value.path === undefined || typeof value.path === 'string')
}

async function safeResponseJson(response: Response): Promise<unknown> {
  if (!isJsonResponse(response)) return null
  return response.json().catch(() => null)
}

function isWorkflowAnalysis(value: unknown): value is WorkflowAutoMappingResult {
  if (!isRecord(value)) return false
  const item = value
  return isRecord(item.graph)
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

export async function analyzeWorkflowJson(
  kind: WorkflowImportKind,
  file: File,
): Promise<WorkflowAnalysisResponse> {
  const sourceText = await readWorkflowImportFile(file)
  const apiFormatJson = parseWorkflowImportText(sourceText)
  const response = await apiFetch(ANALYZE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, apiFormatJson }),
  })
  const payload = await safeResponseJson(response)
  if (!response.ok) throw workflowRequestErrorFromPayload(payload)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw malformedWorkflowResponse()
  }
  const analysis = (payload as Record<string, unknown>).analysis
  if (!isWorkflowAnalysis(analysis)) throw malformedWorkflowResponse()
  return { sourceText, analysis }
}

export async function createWorkflowDraft(draft: WorkflowAuthorDraft): Promise<string> {
  const response = await apiFetch(WORKFLOWS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...workflowPayload(draft),
      name: draft.name,
      mediaType: draft.mediaType,
    }),
  })
  const payload = await safeResponseJson(response)
  if (!response.ok) throw workflowRequestErrorFromPayload(payload)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw malformedWorkflowResponse()
  }
  const workflow = (payload as Record<string, unknown>).workflow
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw malformedWorkflowResponse()
  }
  const id = (workflow as Record<string, unknown>).id
  if (typeof id !== 'string' || !id.trim()) throw malformedWorkflowResponse()
  return id
}
