import { COMFY_ERROR_CODE, ComfyError } from './errors'
import type {
  ComfyDeviceSummary,
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
    requirements: ComfyWorkflowRequirements
  }): Promise<ComfyCompatibilityResult>
  cacheSet(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>
}

export interface MonitorComfyHealthInput {
  connectionId: string
  workflowHash?: string
  requirements?: ComfyWorkflowRequirements
  checkedAt?: Date
  ttlMs: number
}

export interface MonitoredComfyHealth {
  health: ComfyHealthSummary
  compatibility?: ComfyCompatibilityResult
}

export async function monitorComfyHealth(
  input: MonitorComfyHealthInput,
  dependencies: ComfyHealthMonitorDependencies,
): Promise<MonitoredComfyHealth> {
  const checkedAt = input.checkedAt ?? new Date()
  let health: ComfyHealthSummary
  let compatibility: ComfyCompatibilityResult | undefined
  try {
    await dependencies.authorize()
    const systemStats = await dependencies.getSystemStats()
    const queue = await dependencies.getQueue()
    const hasLease = await dependencies.hasLease(input.connectionId)
    if (input.workflowHash && input.requirements) {
      compatibility = await dependencies.checkCompatibility({
        connectionId: input.connectionId,
        workflowHash: input.workflowHash,
        requirements: input.requirements,
      })
    }
    health = deriveComfyHealth({
      checkedAt,
      systemStats,
      queue,
      ownedNonterminalCount: hasLease ? 1 : 0,
    })
    if (compatibility && !compatibility.compatible) {
      health = { ...health, state: 'workflow_incompatible' }
    }
  } catch (error) {
    health = deriveComfyHealth({ checkedAt, error, ownedNonterminalCount: 0 })
  }
  await dependencies.cacheSet(
    comfyHealthKey(input.connectionId),
    JSON.stringify(health),
    'PX',
    input.ttlMs,
  )
  return { health, ...(compatibility ? { compatibility } : {}) }
}

export function comfyHealthKey(connectionId: string) {
  return `comfy:health:${connectionId}`
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
