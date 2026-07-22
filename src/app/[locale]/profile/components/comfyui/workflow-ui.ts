import type {
  ComfyInputBinding,
  ComfyMediaType,
  ComfyOutputBinding,
  ComfyVariableDefinition,
  ComfyWorkflowPurpose,
  WorkflowValidationIssue,
} from '@/lib/comfyui/types'
import type {
  CanonicalWorkflowInput,
  WorkflowAutoMappingResult,
} from '@/lib/comfyui/workflow-auto-mapping-types'

export type WorkflowCompatibilityStatus = 'online' | 'offline' | 'auth_failed' | 'disabled' | 'timeout'

export interface WorkflowCompatibilityResponseItem {
  connectionId: string
  connectionName: string
  status: WorkflowCompatibilityStatus
  compatible: boolean
  missingNodes?: string[]
  missingModels?: Array<{ nodeId: string; field: string; value: string }>
}

export interface WorkflowCompatibilityRequestTicket {
  kind: 'initial' | 'loadMore'
  workflowId: string
  versionId: string
  cursor: string | null
  generation: number
  controller: AbortController
}

export function createWorkflowCompatibilityCoordinator() {
  let generation = 0
  let identity: { workflowId: string; versionId: string; cursor: string | null } | null = null
  let initialController: AbortController | null = null
  let loadMoreController: AbortController | null = null

  const abortRequests = () => {
    initialController?.abort(); loadMoreController?.abort()
    initialController = null; loadMoreController = null
  }
  const select = (workflowId: string, versionId: string) => {
    abortRequests(); generation += 1
    identity = { workflowId, versionId, cursor: null }
    return { ...identity, generation }
  }
  const begin = (kind: 'initial' | 'loadMore', cursor: string | null): WorkflowCompatibilityRequestTicket | null => {
    if (!identity) return null
    if (kind === 'loadMore' && (loadMoreController || !cursor || cursor !== identity.cursor)) return null
    if (kind === 'initial' && initialController) initialController.abort()
    const controller = new AbortController()
    if (kind === 'initial') initialController = controller
    else loadMoreController = controller
    return { kind, ...identity, cursor, generation, controller }
  }
  const isCurrent = (ticket: WorkflowCompatibilityRequestTicket) => {
    const activeController = ticket.kind === 'initial' ? initialController : loadMoreController
    return !ticket.controller.signal.aborted
      && activeController === ticket.controller
      && ticket.generation === generation
      && ticket.workflowId === identity?.workflowId
      && ticket.versionId === identity?.versionId
      && ticket.cursor === identity?.cursor
  }
  const finish = (ticket: WorkflowCompatibilityRequestTicket) => {
    if (ticket.kind === 'initial' && initialController === ticket.controller) initialController = null
    if (ticket.kind === 'loadMore' && loadMoreController === ticket.controller) loadMoreController = null
  }
  const accept = (ticket: WorkflowCompatibilityRequestTicket, nextCursor: string | null) => {
    if (!isCurrent(ticket) || !identity) return false
    identity.cursor = nextCursor
    finish(ticket)
    return true
  }
  const cancel = (selection: { generation: number }) => {
    if (selection.generation !== generation) return
    abortRequests(); identity = null; generation += 1
  }
  return {
    select,
    beginInitial: () => begin('initial', null),
    beginLoadMore: (cursor: string) => begin('loadMore', cursor),
    isCurrent,
    accept,
    finish,
    cancel,
  }
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
  purpose: ComfyWorkflowPurpose
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
  purpose: ComfyWorkflowPurpose
  status: 'draft' | 'published' | 'archived'
  currentVersionId: string | null
  currentVersion: WorkflowVersionView | null
  versions: WorkflowVersionView[]
  validation: { valid: boolean; issues: WorkflowValidationIssue[] }
}

export interface WorkflowAuthorDraft {
  name: string
  mediaType: ComfyMediaType
  purpose: ComfyWorkflowPurpose
  apiFormatJson: string
  variableDefinitions: ComfyVariableDefinition[]
  bindings: ComfyInputBinding[]
  outputs: ComfyOutputBinding[]
}

export interface WorkflowMappingConfirmation {
  roles: Record<string, CanonicalWorkflowInput | 'preserve_original'>
  primaryOutputNodeId?: string
  requiredInputs?: readonly CanonicalWorkflowInput[]
}

export function confirmWorkflowAnalysis(
  analysis: WorkflowAutoMappingResult,
  confirmation: WorkflowMappingConfirmation,
): Pick<WorkflowAuthorDraft, 'variableDefinitions' | 'bindings' | 'outputs'> {
  const definitions = new Map<string, ComfyVariableDefinition>()
  const bindings: ComfyInputBinding[] = []
  let nextReferenceIndex = 0

  const resolvedProposals = analysis.proposals.map((proposal) => {
    const selectedRole = confirmation.roles[proposal.id]
    if (proposal.confidence === 'ambiguous' && proposal.required && (!selectedRole || selectedRole === 'preserve_original')) {
      throw new Error('workflowMappingConfirmationRequired')
    }
    const canonicalName = selectedRole
      || (proposal.confidence === 'ambiguous' || proposal.confidence === 'preserve_original'
        ? 'preserve_original'
        : proposal.canonicalName)
    return { proposal, canonicalName }
  })
  const requiredInputs = confirmation.requiredInputs
    ? new Set<CanonicalWorkflowInput>(confirmation.requiredInputs)
    : null
  const requiredByCanonical = new Map<CanonicalWorkflowInput, boolean>()
  for (const { proposal, canonicalName } of resolvedProposals) {
    if (canonicalName === 'preserve_original') continue
    requiredByCanonical.set(
      canonicalName,
      requiredInputs
        ? requiredInputs.has(canonicalName)
        : Boolean(requiredByCanonical.get(canonicalName) || proposal.required),
    )
  }

  for (const { proposal, canonicalName } of resolvedProposals) {
    if (canonicalName === 'preserve_original') continue

    const isReferenceList = canonicalName === 'referenceImages'
    const isBerniniSlots = proposal.transform === 'bernini_image_slots'
    const isLtxDirectorTimeline = proposal.transform === 'ltx_director_timeline'
    const valueType = isReferenceList ? 'image_ref_list' : proposal.valueType
    const existing = definitions.get(canonicalName)
    const required = requiredByCanonical.get(canonicalName) ?? false
    const referenceIndex = isReferenceList
      ? (proposal.referenceIndex ?? nextReferenceIndex)
      : undefined
    if (referenceIndex !== undefined) {
      nextReferenceIndex = Math.max(nextReferenceIndex, referenceIndex + 1)
    }
    const referenceCapacity = isReferenceList
      ? Math.max(existing?.maxItems ?? 0, analysis.referenceCapacity, (referenceIndex ?? 0) + 1)
      : undefined
    definitions.set(canonicalName, {
      name: canonicalName,
      type: valueType,
      required,
      ...(!required && isBerniniSlots
        ? { defaultValue: [] }
        : !required ? { missingValuePolicy: 'preserve_original' as const } : {}),
      ...(isReferenceList ? { maxItems: referenceCapacity } : {}),
    })
    bindings.push({
      nodeId: proposal.nodeId,
      inputPath: proposal.inputPath,
      variable: canonicalName,
      valueType,
      ...(isReferenceList
        ? proposal.transform === 'bernini_image_slots'
          ? { transform: 'bernini_image_slots' as const }
          : isLtxDirectorTimeline
            ? { transform: 'ltx_director_timeline' as const }
          : {
            transform: proposal.transform === 'filename_list' ? 'filename_list' : 'filename_at',
            ...(proposal.transform === 'filename_list' ? {} : { valueIndex: referenceIndex }),
          }
        : proposal.transform ? { transform: proposal.transform } : {}),
      ...(proposal.numericTransform
        ? { numericTransform: structuredClone(proposal.numericTransform) }
        : {}),
      ...(!required && !isBerniniSlots
        ? { missingValuePolicy: 'preserve_original' as const }
        : {}),
    })
  }

  for (const binding of bindings) {
    if (binding.numericTransform?.targetUnit !== 'frames' || definitions.has('fps')) continue
    definitions.set('fps', {
      name: 'fps', type: 'number', required: false,
      defaultValue: binding.numericTransform.fps!.fallback,
    })
  }

  const primaryNodeId = confirmation.primaryOutputNodeId
    || analysis.outputs.find((output) => output.primary)?.nodeId
    || (analysis.outputs.length === 1 ? analysis.outputs[0]?.nodeId : undefined)
  if (!primaryNodeId || !analysis.outputs.some((output) => output.nodeId === primaryNodeId)) {
    throw new Error('workflowPrimaryOutputRequired')
  }

  return {
    variableDefinitions: [...definitions.values()],
    bindings,
    outputs: analysis.outputs.map((output) => ({
      ...output,
      primary: output.nodeId === primaryNodeId,
    })),
  }
}

export function emptyWorkflowDraft(): WorkflowAuthorDraft {
  return { name: '', mediaType: 'image', purpose: 'generation', apiFormatJson: '', variableDefinitions: [], bindings: [], outputs: [] }
}

export function draftFromWorkflow(workflow: WorkflowView, version?: WorkflowVersionView | null): WorkflowAuthorDraft {
  const savedVersion = version ?? workflow.versions[0] ?? workflow.currentVersion
  if (!savedVersion) return { ...emptyWorkflowDraft(), name: workflow.name, mediaType: workflow.mediaType }
  return {
    name: workflow.name,
    mediaType: workflow.mediaType,
    purpose: savedVersion.purpose ?? 'generation',
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
    purpose: draft.purpose,
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
  | 'workflowProjectDefaultConflict'
  | 'workflowNotFound'
  | 'workflowAccessDenied'
  | 'workflowMissingConfig'
  | 'workflowTimedOut'
  | 'workflowNetworkFailed'
  | 'workflowExternalFailed'
  | WorkflowAnalysisErrorKey

export type WorkflowAnalysisErrorReason =
  | 'COMFY_WORKFLOW_API_FORMAT_REQUIRED'
  | 'COMFY_WORKFLOW_API_FORMAT_INVALID'

export type WorkflowRequestErrorReason =
  | WorkflowAnalysisErrorReason
  | 'COMFY_WORKFLOW_PROJECT_DEFAULT_CONFLICT'

export type WorkflowAnalysisErrorKey =
  | `guided.issues.${WorkflowAnalysisErrorReason}`
  | 'guided.issues.unknown'

const SAFE_WORKFLOW_ANALYSIS_REASONS = new Set<WorkflowAnalysisErrorReason>([
  'COMFY_WORKFLOW_API_FORMAT_REQUIRED',
  'COMFY_WORKFLOW_API_FORMAT_INVALID',
])

function safeWorkflowAnalysisReason(value: unknown): WorkflowAnalysisErrorReason | undefined {
  return typeof value === 'string'
    && SAFE_WORKFLOW_ANALYSIS_REASONS.has(value as WorkflowAnalysisErrorReason)
    ? value as WorkflowAnalysisErrorReason
    : undefined
}

function safeWorkflowRequestReason(code: string, value: unknown): WorkflowRequestErrorReason | undefined {
  if (code === 'INVALID_PARAMS') return safeWorkflowAnalysisReason(value)
  if (code === 'CONFLICT' && value === 'COMFY_WORKFLOW_PROJECT_DEFAULT_CONFLICT') return value
  return undefined
}

export class WorkflowRequestError extends Error {
  readonly reason?: WorkflowRequestErrorReason
  readonly status?: number

  constructor(readonly code: string, reason?: unknown, status?: number) {
    super('workflowRequestFailed')
    this.name = 'WorkflowRequestError'
    this.reason = safeWorkflowRequestReason(code, reason)
    this.status = typeof status === 'number'
      && Number.isInteger(status)
      && status >= 100
      && status <= 599
      ? status
      : undefined
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

export function workflowRequestErrorFromPayload(payload: unknown, status?: number): WorkflowRequestError {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return new WorkflowRequestError('UNKNOWN', undefined, status)
  const record = payload as Record<string, unknown>
  const nested = record.error && typeof record.error === 'object' && !Array.isArray(record.error)
    ? record.error as Record<string, unknown>
    : null
  const code = typeof nested?.code === 'string'
    ? nested.code
    : typeof record.code === 'string' ? record.code : 'UNKNOWN'
  const details = nested?.details && typeof nested.details === 'object' && !Array.isArray(nested.details)
    ? nested.details as Record<string, unknown>
    : null
  return new WorkflowRequestError(code, details?.reason, status)
}

export function safeWorkflowErrorKey(error: unknown): WorkflowErrorKey {
  if (error instanceof Error && ['workflowInvalidJson', 'workflowTooLarge'].includes(error.message)) {
    return error.message as 'workflowInvalidJson' | 'workflowTooLarge'
  }
  if (error instanceof WorkflowRequestError) return SAFE_WORKFLOW_API_ERRORS[error.code] ?? 'requestFailed'
  return 'requestFailed'
}

export function safeWorkflowAnalysisErrorKey(error: unknown): WorkflowErrorKey {
  if (error instanceof WorkflowRequestError) {
    const reason = safeWorkflowAnalysisReason(error.reason)
    if (reason) return `guided.issues.${reason}`
  }
  return safeWorkflowErrorKey(error)
}
