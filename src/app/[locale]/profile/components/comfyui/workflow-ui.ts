import type {
  ComfyInputBinding,
  ComfyMediaType,
  ComfyOutputBinding,
  ComfyVariableDefinition,
  WorkflowValidationIssue,
} from '@/lib/comfyui/types'

export type WorkflowCompatibilityStatus = 'online' | 'offline' | 'auth_failed' | 'disabled' | 'timeout'

export interface WorkflowCompatibilityResponseItem {
  connectionId: string
  connectionName: string
  status: WorkflowCompatibilityStatus
  compatible: boolean
  missingNodes?: string[]
  missingModels?: Array<{ nodeId: string; field: string; value: string }>
}

export function mapWorkflowCompatibility(item: WorkflowCompatibilityResponseItem) {
  return {
    connectionId: item.connectionId,
    connectionName: item.connectionName,
    state: item.status === 'disabled'
      ? 'disabled' as const
      : item.status === 'timeout'
        ? 'timeout' as const
      : item.status === 'auth_failed'
        ? 'auth_failed' as const
        : item.status === 'offline'
          ? 'offline' as const
          : item.compatible ? 'compatible' as const : 'incompatible' as const,
    missingNodes: item.missingNodes ?? [],
    missingModels: item.missingModels ?? [],
  }
}

export const MAX_WORKFLOW_JSON_BYTES = 4 * 1024 * 1024

export interface WorkflowVersionView {
  id: string
  version: number
  apiFormatJson: unknown
  variableDefinitions: ComfyVariableDefinition[]
  bindings: ComfyInputBinding[]
  outputs: ComfyOutputBinding[]
  contentHash: string
  publishedAt: string | null
  lastSuccessfulTestAt: string | null
  validation: { valid: boolean; issues: WorkflowValidationIssue[] }
}

export interface WorkflowView {
  id: string
  name: string
  mediaType: ComfyMediaType
  status: 'draft' | 'published' | 'archived'
  currentVersionId: string | null
  currentVersion: WorkflowVersionView | null
  versions: WorkflowVersionView[]
  validation: { valid: boolean; issues: WorkflowValidationIssue[] }
}

export interface WorkflowAuthorDraft {
  name: string
  mediaType: ComfyMediaType
  apiFormatJson: string
  variableDefinitions: ComfyVariableDefinition[]
  bindings: ComfyInputBinding[]
  outputs: ComfyOutputBinding[]
}

export function emptyWorkflowDraft(): WorkflowAuthorDraft {
  return { name: '', mediaType: 'image', apiFormatJson: '', variableDefinitions: [], bindings: [], outputs: [] }
}

export function draftFromWorkflow(workflow: WorkflowView, version?: WorkflowVersionView | null): WorkflowAuthorDraft {
  const savedVersion = version ?? workflow.versions[0] ?? workflow.currentVersion
  if (!savedVersion) return { ...emptyWorkflowDraft(), name: workflow.name, mediaType: workflow.mediaType }
  return {
    name: workflow.name,
    mediaType: workflow.mediaType,
    apiFormatJson: JSON.stringify(savedVersion.apiFormatJson, null, 2),
    variableDefinitions: savedVersion.variableDefinitions.map((item) => ({ ...item })),
    bindings: savedVersion.bindings.map((item) => ({ ...item })),
    outputs: savedVersion.outputs.map((item) => ({ ...item })),
  }
}

export function parseWorkflowImportText(text: string): Record<string, unknown> {
  if (new TextEncoder().encode(text).byteLength > MAX_WORKFLOW_JSON_BYTES) throw new Error('workflowTooLarge')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('workflowInvalidJson') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('workflowInvalidJson')
  return value as Record<string, unknown>
}

export async function readWorkflowImportFile(file: File): Promise<string> {
  if (file.size > MAX_WORKFLOW_JSON_BYTES) throw new Error('workflowTooLarge')
  const text = await file.text()
  parseWorkflowImportText(text)
  return text
}

export function discoverPlaceholderNames(text: string): string[] {
  const names = new Set<string>()
  for (const match of text.matchAll(/\$\{([^{}]+)\}/g)) if (match[1]) names.add(match[1])
  return [...names].sort()
}

export function setPrimaryOutput(outputs: ComfyOutputBinding[], index: number): ComfyOutputBinding[] {
  return outputs.map((output, outputIndex) => ({ ...output, primary: outputIndex === index }))
}

export function removeWorkflowOutput(outputs: ComfyOutputBinding[], index: number): ComfyOutputBinding[] {
  if (outputs.length <= 1 || !outputs[index]) return outputs
  const removedPrimary = outputs[index].primary
  const remaining = outputs.filter((_, outputIndex) => outputIndex !== index)
  return removedPrimary ? setPrimaryOutput(remaining, 0) : remaining
}

export function workflowPayload(draft: WorkflowAuthorDraft) {
  return {
    apiFormatJson: parseWorkflowImportText(draft.apiFormatJson),
    variableDefinitions: draft.variableDefinitions,
    bindings: draft.bindings,
    outputs: draft.outputs,
  }
}

export type WorkflowErrorKey =
  | 'requestFailed'
  | 'workflowInvalidJson'
  | 'workflowTooLarge'
  | 'workflowRequestInvalid'
  | 'workflowConflict'
  | 'workflowNotFound'
  | 'workflowAccessDenied'
  | 'workflowMissingConfig'
  | 'workflowTimedOut'
  | 'workflowNetworkFailed'
  | 'workflowExternalFailed'

export class WorkflowRequestError extends Error {
  constructor(readonly code: string) {
    super('workflowRequestFailed')
    this.name = 'WorkflowRequestError'
  }
}

const SAFE_WORKFLOW_API_ERRORS: Readonly<Record<string, WorkflowErrorKey>> = {
  INVALID_PARAMS: 'workflowRequestInvalid',
  CONFLICT: 'workflowConflict',
  NOT_FOUND: 'workflowNotFound',
  UNAUTHORIZED: 'workflowAccessDenied',
  FORBIDDEN: 'workflowAccessDenied',
  MISSING_CONFIG: 'workflowMissingConfig',
  GENERATION_TIMEOUT: 'workflowTimedOut',
  NETWORK_ERROR: 'workflowNetworkFailed',
  EXTERNAL_ERROR: 'workflowExternalFailed',
}

export function workflowRequestErrorFromPayload(payload: unknown): WorkflowRequestError {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return new WorkflowRequestError('UNKNOWN')
  const record = payload as Record<string, unknown>
  const nested = record.error && typeof record.error === 'object' && !Array.isArray(record.error)
    ? record.error as Record<string, unknown>
    : null
  const code = typeof nested?.code === 'string'
    ? nested.code
    : typeof record.code === 'string' ? record.code : 'UNKNOWN'
  return new WorkflowRequestError(code)
}

export function safeWorkflowErrorKey(error: unknown): WorkflowErrorKey {
  if (error instanceof Error && ['workflowInvalidJson', 'workflowTooLarge'].includes(error.message)) {
    return error.message as 'workflowInvalidJson' | 'workflowTooLarge'
  }
  if (error instanceof WorkflowRequestError) return SAFE_WORKFLOW_API_ERRORS[error.code] ?? 'requestFailed'
  return 'requestFailed'
}
