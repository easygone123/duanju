import { COMFY_ERROR_CODE, ComfyError } from './errors'
import type {
  ComfyDeviceSummary,
  ComfyApiWorkflow,
  ComfyHealthSummary,
  ComfyQueueSnapshot,
  ComfySystemStats,
} from './types'
import type {
  ComfyCompatibilityResult,
} from './compatibility'
import type { ComfyWorkflowRequirements } from './types'

export interface ComfyHealthMonitorDependencies {
  authorize(): Promise<void>
  getSystemStats(): Promise<ComfySystemStats>
  getQueue(): Promise<ComfyQueueSnapshot>
  hasLease(connectionId: string): Promise<boolean>
  checkCompatibility(input: {
    connectionId: string
    workflowHash: string
    graph: ComfyApiWorkflow
    requirements: ComfyWorkflowRequirements
  }): Promise<ComfyCompatibilityResult>
  cacheEval(
    script: string,
    keyCount: number,
    key: string,
    checkedAt: string,
    value: string,
    ttlMs: number,
  ): Promise<unknown>
  recordState?(input: {
    connectionId: string
    state: ComfyHealthSummary['state']
    up: 0 | 1
    idle: 0 | 1
    ownedBusy: 0 | 1
    externalBusy: 0 | 1
  }): void
}

export interface MonitorComfyHealthInput {
  connectionId: string
  workflowHash?: string
  graph?: ComfyApiWorkflow
  requirements?: ComfyWorkflowRequirements
  checkedAt?: Date
  ttlMs: number
}

export interface MonitoredComfyHealth {
  health: ComfyHealthSummary
  compatibility?: ComfyCompatibilityResult
  compatibilityError?: {
    code: 'COMFY_COMPATIBILITY_CHECK_FAILED'
    message: 'Compatibility check unavailable'
  }
}

interface ComfyHealthCacheEvalClient {
  eval(
    script: string,
    keyCount: number,
    key: string,
    checkedAt: string,
    value: string,
    ttlMs: number,
  ): Promise<unknown>
}

const CACHE_IF_NEWER_SCRIPT = `
local current = redis.call('get', KEYS[1])
if current then
  local ok, decoded = pcall(cjson.decode, current)
  if ok and decoded['checkedAt'] and decoded['checkedAt'] >= ARGV[1] then
    return 0
  end
end
redis.call('set', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1
`

export async function monitorComfyHealth(
  input: MonitorComfyHealthInput,
  dependencies: ComfyHealthMonitorDependencies,
): Promise<MonitoredComfyHealth> {
  const checkedAt = input.checkedAt ?? new Date()
  let baseHealth: ComfyHealthSummary
  let compatibility: ComfyCompatibilityResult | undefined
  let compatibilityError: MonitoredComfyHealth['compatibilityError']
  try {
    await dependencies.authorize()
    const systemStats = await dependencies.getSystemStats()
    const queue = await dependencies.getQueue()
    const hasLease = await dependencies.hasLease(input.connectionId)
    baseHealth = deriveComfyHealth({
      checkedAt,
      systemStats,
      queue,
      ownedNonterminalCount: hasLease ? 1 : 0,
    })
  } catch (error) {
    baseHealth = deriveComfyHealth({ checkedAt, error, ownedNonterminalCount: 0 })
  }
  if (baseHealth.state !== 'offline' && baseHealth.state !== 'auth_failed'
    && input.workflowHash && input.graph && input.requirements) {
    try {
      compatibility = await dependencies.checkCompatibility({
        connectionId: input.connectionId,
        workflowHash: input.workflowHash,
        graph: input.graph,
        requirements: input.requirements,
      })
    } catch {
      compatibilityError = {
        code: 'COMFY_COMPATIBILITY_CHECK_FAILED',
        message: 'Compatibility check unavailable',
      }
    }
  }
  await cacheComfyHealthIfNewer(
    { eval: dependencies.cacheEval }, input.connectionId, baseHealth, input.ttlMs,
  )
  dependencies.recordState?.({
    connectionId: input.connectionId,
    state: baseHealth.state,
    up: baseHealth.state === 'offline' || baseHealth.state === 'auth_failed' ? 0 : 1,
    idle: baseHealth.state === 'online_idle' ? 1 : 0,
    ownedBusy: baseHealth.state === 'online_busy_owned' ? 1 : 0,
    externalBusy: baseHealth.state === 'online_busy_external' ? 1 : 0,
  })
  const health = compatibility && !compatibility.compatible
    ? { ...baseHealth, state: 'workflow_incompatible' as const }
    : baseHealth
  return {
    health,
    ...(compatibility ? { compatibility } : {}),
    ...(compatibilityError ? { compatibilityError } : {}),
  }
}

export function comfyHealthKey(connectionId: string) {
  return `comfy:health:${connectionId}`
}

export async function cacheComfyHealthIfNewer(
  client: ComfyHealthCacheEvalClient,
  connectionId: string,
  health: ComfyHealthSummary,
  ttlMs: number,
) {
  return client.eval(
    CACHE_IF_NEWER_SCRIPT,
    1,
    comfyHealthKey(connectionId),
    health.checkedAt,
    JSON.stringify(health),
    ttlMs,
  )
}

interface DeriveComfyHealthInput {
  checkedAt: Date
  systemStats?: ComfySystemStats
  queue?: ComfyQueueSnapshot
  ownedNonterminalCount: number
  error?: unknown
}

export function deriveComfyHealth(input: DeriveComfyHealthInput): ComfyHealthSummary {
  if (input.error !== undefined) {
    const authFailed = isAuthFailure(input.error)
    return {
      state: authFailed ? 'auth_failed' : 'offline',
      checkedAt: input.checkedAt.toISOString(),
      code: authFailed ? COMFY_ERROR_CODE.AUTH_FAILED : COMFY_ERROR_CODE.CONNECTION_OFFLINE,
      message: authFailed ? 'Authentication failed' : 'Connection unavailable',
      runningCount: 0,
      pendingCount: 0,
    }
  }

  const runningCount = input.queue?.running.length ?? 0
  const pendingCount = input.queue?.pending.length ?? 0
  const state = input.ownedNonterminalCount > 0
    ? 'online_busy_owned'
    : runningCount + pendingCount > 0
      ? 'online_busy_external'
      : 'online_idle'
  const version = readVersion(input.systemStats)
  const devices = readDevices(input.systemStats)

  return {
    state,
    checkedAt: input.checkedAt.toISOString(),
    ...(version ? { version } : {}),
    ...(devices.length > 0 ? { devices } : {}),
    runningCount,
    pendingCount,
  }
}

export function sanitizeComfyHealthDiagnostic(summary: ComfyHealthSummary) {
  return {
    lastHealthAt: new Date(summary.checkedAt),
    lastHealthCode: summary.state,
    lastHealthMessage: summary.message?.slice(0, 200) ?? null,
    lastSeenVersion: summary.version?.slice(0, 100) ?? null,
    deviceSummary: summary.devices?.slice(0, 16).map((device) => ({
      ...(device.name ? { name: device.name.slice(0, 160) } : {}),
      ...(device.type ? { type: device.type.slice(0, 80) } : {}),
      ...(device.vramTotalBytes !== undefined ? { vramTotalBytes: device.vramTotalBytes } : {}),
      ...(device.vramFreeBytes !== undefined ? { vramFreeBytes: device.vramFreeBytes } : {}),
    })) ?? [],
  }
}

function isAuthFailure(error: unknown): boolean {
  if (error instanceof ComfyError) return error.code === COMFY_ERROR_CODE.AUTH_FAILED
  return !!error && typeof error === 'object' && 'code' in error
    && error.code === COMFY_ERROR_CODE.AUTH_FAILED
}

function readVersion(stats: ComfySystemStats | undefined): string | undefined {
  const value = stats?.system?.comfyui_version ?? stats?.system?.comfyuiVersion
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 100) : undefined
}

function readDevices(stats: ComfySystemStats | undefined): ComfyDeviceSummary[] {
  if (!Array.isArray(stats?.devices)) return []
  return stats.devices.slice(0, 16).map((device) => {
    const name = boundedString(device.name, 160)
    const type = boundedString(device.type, 80)
    const vramTotalBytes = nonnegativeNumber(device.vram_total ?? device.vramTotal)
    const vramFreeBytes = nonnegativeNumber(device.vram_free ?? device.vramFree)
    return {
      ...(name ? { name } : {}),
      ...(type ? { type } : {}),
      ...(vramTotalBytes !== undefined ? { vramTotalBytes } : {}),
      ...(vramFreeBytes !== undefined ? { vramFreeBytes } : {}),
    }
  })
}

function boundedString(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : undefined
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
