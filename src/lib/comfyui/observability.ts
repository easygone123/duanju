const REDACTED = '[REDACTED]'
const SENSITIVE_KEY = /(authorization|token|secret|password|cookie|prompt|workflow|graph|api[-_]?key|variableSnapshot|inputs?|positive|negative)/i
const ALLOWED_LABELS = new Set([
  'state', 'mediaType', 'status', 'code', 'outcome',
])
const ALLOWED_CODES = new Set([
  'COMFY_CONNECTION_OFFLINE', 'COMFY_AUTH_FAILED', 'COMFY_NETWORK_TARGET_BLOCKED',
  'COMFY_WORKFLOW_FORMAT_INVALID', 'COMFY_WORKFLOW_BINDING_INVALID',
  'COMFY_WORKFLOW_INCOMPATIBLE', 'COMFY_NO_COMPATIBLE_INSTANCE',
  'COMFY_INPUT_UPLOAD_FAILED', 'COMFY_PROMPT_REJECTED', 'COMFY_EXECUTION_FAILED',
  'COMFY_EXECUTION_TIMEOUT', 'COMFY_OUTPUT_MISSING', 'COMFY_OUTPUT_TRANSFER_FAILED',
  'COMFY_RECONCILIATION_REQUIRED',
])
const ALLOWED_OUTCOMES = new Set([
  'completed', 'recorded_prompt', 'submission_attempt', 'claim_recheck',
  'submission_fence', 'detached_receipt', 'websocket_fallback',
  'terminal_write_failed', 'failover_write_failed', 'uncertain_submission',
])
const ALLOWED_STATES = new Set([
  'online_idle', 'online_busy_owned', 'online_busy_external', 'offline',
  'auth_failed', 'workflow_incompatible', 'completed',
])
const ALLOWED_STATUSES = new Set([
  'waiting_capacity', 'blocked_no_compatible_instance', 'leased', 'uploading',
  'submitting', 'submitted', 'running', 'transferring', 'reconciling',
  'completed', 'failed', 'canceled',
])

export interface ComfyMetricSink {
  increment(name: string, value: number, labels: Record<string, string>): void
  observe(name: string, value: number, labels: Record<string, string>): void
  gauge(name: string, value: number, labels: Record<string, string>): void
}

export interface ComfyLogSink {
  info(message: string, fields: Record<string, unknown>): void
  warn(message: string, fields: Record<string, unknown>): void
  error(message: string, fields: Record<string, unknown>): void
}

export interface ComfyCorrelationContext {
  taskId?: string
  requestId?: string
  workflowId?: string
  workflowVersionId?: string
  connectionId?: string
  promptId?: string
  leaseId?: string
}

export function createComfyObservability(input: {
  logger: ComfyLogSink
  metrics: ComfyMetricSink
  context: ComfyCorrelationContext
}) {
  const context = sanitizeCorrelation(input.context)
  const fields = (extra: Record<string, unknown> = {}) => ({
    ...context,
    ...redactComfyDiagnostic(extra) as Record<string, unknown>,
  })
  const labels = (extra: Record<string, string> = {}) => sanitizeMetricLabels(extra)
  return {
    info: (message: string, extra?: Record<string, unknown>) => input.logger.info(message, fields(extra)),
    warn: (message: string, extra?: Record<string, unknown>) => input.logger.warn(message, fields(extra)),
    error: (message: string, extra?: Record<string, unknown>) => input.logger.error(message, fields(extra)),
    increment: (name: string, extra?: Record<string, string>, value = 1) =>
      input.metrics.increment(metricName(name), value, labels(extra)),
    observe: (name: string, value: number, extra?: Record<string, string>) =>
      input.metrics.observe(metricName(name), finiteMetric(value), labels(extra)),
    gauge: (name: string, value: number, extra?: Record<string, string>) =>
      input.metrics.gauge(metricName(name), finiteMetric(value), labels(extra)),
  }
}

export type ComfyObservability = ReturnType<typeof createComfyObservability>

export function redactComfyDiagnostic(value: unknown, key = '', depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return REDACTED
  if (depth > 8) return '[TRUNCATED]'
  if (value instanceof Error) return { name: value.name, message: 'Operation failed' }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactComfyDiagnostic(item, '', depth + 1))
  if (isRecord(value)) {
    const result: Record<string, unknown> = {}
    for (const [nestedKey, nestedValue] of Object.entries(value).slice(0, 100)) {
      result[nestedKey] = redactComfyDiagnostic(nestedValue, nestedKey, depth + 1)
    }
    return result
  }
  if (typeof value === 'string') return redactString(value).slice(0, 1024)
  return value
}

function redactString(value: string) {
  return value
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, REDACTED)
    .replace(/([?&](?:token|api[-_]?key|password|secret)=)[^&\s]+/gi, `$1${REDACTED}`)
}

function sanitizeMetricLabels(value: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, label] of Object.entries(value)) {
    if (!ALLOWED_LABELS.has(key) || typeof label !== 'string') continue
    if (key === 'code' && !ALLOWED_CODES.has(label)) throw new TypeError('Invalid ComfyUI metric code')
    if (key === 'mediaType' && !['image', 'video'].includes(label)) throw new TypeError('Invalid media type')
    if (key === 'outcome' && !ALLOWED_OUTCOMES.has(label)) throw new TypeError('Invalid outcome')
    if (key === 'state' && !ALLOWED_STATES.has(label)) throw new TypeError('Invalid state')
    if (key === 'status' && !ALLOWED_STATUSES.has(label)) throw new TypeError('Invalid status')
    if (!/^[a-z0-9_]{1,64}$/i.test(label)) throw new TypeError('Invalid metric label')
    result[key] = label
  }
  return result
}

function sanitizeCorrelation(value: ComfyCorrelationContext) {
  const result: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') result[key] = raw.slice(0, 191)
  }
  return result
}

function metricName(name: string) {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new TypeError('Invalid ComfyUI metric name')
  return `comfy.${name}`
}

function finiteMetric(value: number) {
  if (!Number.isFinite(value)) throw new TypeError('Invalid ComfyUI metric value')
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
