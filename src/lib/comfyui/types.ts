export const COMFY_REQUEST_STATUS = {
  WAITING_CAPACITY: 'waiting_capacity',
  BLOCKED_NO_COMPATIBLE_INSTANCE: 'blocked_no_compatible_instance',
  LEASED: 'leased',
  UPLOADING: 'uploading',
  SUBMITTING: 'submitting',
  SUBMITTED: 'submitted',
  RUNNING: 'running',
  TRANSFERRING: 'transferring',
  RECONCILING: 'reconciling',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELED: 'canceled',
} as const

export type ComfyRequestStatus =
  (typeof COMFY_REQUEST_STATUS)[keyof typeof COMFY_REQUEST_STATUS]

export const COMFY_ACTIVE_REQUEST_STATUSES = [
  COMFY_REQUEST_STATUS.LEASED,
  COMFY_REQUEST_STATUS.UPLOADING,
  COMFY_REQUEST_STATUS.SUBMITTING,
  COMFY_REQUEST_STATUS.SUBMITTED,
  COMFY_REQUEST_STATUS.RUNNING,
  COMFY_REQUEST_STATUS.TRANSFERRING,
  COMFY_REQUEST_STATUS.RECONCILING,
] as const

export type ComfyMediaType = 'image' | 'video'

export type ComfyAuthType = 'none' | 'bearer' | 'basic'

export type ComfyConnectionAuth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }

export const COMFY_HEALTH_STATE = {
  ONLINE_IDLE: 'online_idle',
  ONLINE_BUSY_OWNED: 'online_busy_owned',
  ONLINE_BUSY_EXTERNAL: 'online_busy_external',
  OFFLINE: 'offline',
  AUTH_FAILED: 'auth_failed',
  WORKFLOW_INCOMPATIBLE: 'workflow_incompatible',
} as const

export type ComfyHealthState =
  (typeof COMFY_HEALTH_STATE)[keyof typeof COMFY_HEALTH_STATE]

export interface ComfyDeviceSummary {
  name?: string
  type?: string
  vramTotalBytes?: number
  vramFreeBytes?: number
}

export interface ComfyHealthSummary {
  state: ComfyHealthState
  checkedAt: string
  code?: string
  message?: string
  version?: string
  devices?: ComfyDeviceSummary[]
  runningCount: number
  pendingCount: number
  capabilityFingerprint?: string
}

export interface ComfyQueueSnapshot {
  running: unknown[]
  pending: unknown[]
}

export interface ComfySystemStats {
  system?: Record<string, unknown>
  devices?: Array<Record<string, unknown>>
}

export interface ComfyApiWorkflowNode {
  class_type: string
  inputs: Record<string, unknown>
  _meta?: Record<string, unknown>
}

export type ComfyApiWorkflow = Record<string, ComfyApiWorkflowNode>

export interface WorkflowValidationIssue {
  code: string
  message: string
  path?: string
}

export interface WorkflowContractInput {
  graph: unknown
  variableDefinitions: ComfyVariableDefinition[]
  bindings: ComfyInputBinding[]
  outputs: ComfyOutputBinding[]
}

export type ComfyVariableType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'image_ref'
  | 'image_ref_list'
  | 'video_ref'

export interface ComfyMediaRef {
  storageKey: string
  mimeType?: string
  filename?: string
}

export type ComfyVariableValue = string | number | boolean | ComfyMediaRef | ComfyMediaRef[]

export type ComfyMissingValuePolicy = 'preserve_original'

export interface ComfyVariableDefinition {
  name: string
  type: ComfyVariableType
  required: boolean
  defaultValue?: ComfyVariableValue
  missingValuePolicy?: ComfyMissingValuePolicy
  options?: Array<string | number | boolean>
}

export type ComfyBindingTransform = 'filename' | 'image_ref' | 'filename_list'

export interface ComfyInputBinding {
  nodeId: string
  inputPath: string
  variable: string
  valueType: ComfyVariableType
  transform?: ComfyBindingTransform
  missingValuePolicy?: ComfyMissingValuePolicy
}

export interface RenderWorkflowInput {
  graph: ComfyApiWorkflow
  variables: Record<string, ComfyVariableValue | undefined>
  variableDefinitions: ComfyVariableDefinition[]
  bindings: ComfyInputBinding[]
  uploads: Record<string, ComfyUploadedFile | ComfyUploadedFile[] | undefined>
}

export interface ComfyOutputBinding {
  name: string
  nodeId: string
  fieldPath: string
  mediaType: ComfyMediaType
  primary: boolean
}

export interface ComfyWorkflowRequirements {
  nodeClasses: string[]
  candidateLoaderInputs: Array<{ nodeId: string; inputName: string; value: string }>
}

export interface ComfyUploadedFile {
  name: string
  subfolder: string
  type: string
}

export interface ComfyUploadInput {
  filename: string
  contentType: string
  bytes: Uint8Array
  subfolder?: string
  overwrite?: boolean
}

export interface ComfyOutputRef {
  name: string
  nodeId: string
  mediaType: ComfyMediaType
  primary: boolean
  filename: string
  subfolder: string
  type: string
}

export interface ComfyStoredOutputRef extends ComfyOutputRef {
  storageKey: string
  url: string
  byteSize: number
  mediaId?: string
}

export interface ComfyGenerationResultRefs {
  primary: ComfyStoredOutputRef
  outputs: ComfyStoredOutputRef[]
}

export type ComfyExecutionEvent =
  | { type: 'status'; queueRemaining?: number }
  | { type: 'execution_start'; promptId: string }
  | { type: 'executing'; promptId: string; nodeId: string | null }
  | { type: 'progress'; promptId: string; nodeId?: string; value: number; max: number }
  | { type: 'executed'; promptId: string; nodeId: string }
  | {
      type: 'execution_error'
      promptId: string
      nodeId?: string
      message: string
    }

export interface ComfyGenerationRequestSnapshot {
  id: string
  invocationKey: string
  userId: string
  projectId: string
  taskId: string
  mediaType: ComfyMediaType
  workflowId: string
  workflowVersionId: string
  variableSnapshot: Record<string, ComfyVariableValue>
  status: ComfyRequestStatus
  connectionId?: string
  leaseId?: string
  promptId?: string
  clientId?: string
  outputRefs?: ComfyOutputRef[]
}
