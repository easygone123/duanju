export const COMFY_ERROR_CODE = {
  EXTERNAL_ID_INVALID: 'COMFY_EXTERNAL_ID_INVALID',
  CONNECTION_OFFLINE: 'COMFY_CONNECTION_OFFLINE',
  AUTH_FAILED: 'COMFY_AUTH_FAILED',
  NETWORK_TARGET_BLOCKED: 'COMFY_NETWORK_TARGET_BLOCKED',
  WORKFLOW_FORMAT_INVALID: 'COMFY_WORKFLOW_FORMAT_INVALID',
  WORKFLOW_BINDING_INVALID: 'COMFY_WORKFLOW_BINDING_INVALID',
  WORKFLOW_INCOMPATIBLE: 'COMFY_WORKFLOW_INCOMPATIBLE',
  NO_COMPATIBLE_INSTANCE: 'COMFY_NO_COMPATIBLE_INSTANCE',
  INPUT_UPLOAD_FAILED: 'COMFY_INPUT_UPLOAD_FAILED',
  PROMPT_REJECTED: 'COMFY_PROMPT_REJECTED',
  EXECUTION_FAILED: 'COMFY_EXECUTION_FAILED',
  EXECUTION_TIMEOUT: 'COMFY_EXECUTION_TIMEOUT',
  OUTPUT_MISSING: 'COMFY_OUTPUT_MISSING',
  OUTPUT_TRANSFER_FAILED: 'COMFY_OUTPUT_TRANSFER_FAILED',
  RECONCILIATION_REQUIRED: 'COMFY_RECONCILIATION_REQUIRED',
} as const

export type ComfyErrorCode = (typeof COMFY_ERROR_CODE)[keyof typeof COMFY_ERROR_CODE]

export class ComfyError extends Error {
  readonly code: ComfyErrorCode
  readonly retryable: boolean
  readonly details?: unknown

  constructor(
    code: ComfyErrorCode,
    message: string,
    options: { retryable?: boolean; cause?: unknown; details?: unknown } = {},
  ) {
    super(`${code}: ${message}`, { cause: options.cause })
    this.name = 'ComfyError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.details = options.details
  }
}
