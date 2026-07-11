import { isIP } from 'node:net'

import type { ComfyNetworkPolicyConfig } from './network-policy'

const DEFAULTS = {
  healthIntervalMs: 10_000,
  dispatchIntervalMs: 1_000,
  reconcileIntervalMs: 15_000,
  leaseTtlMs: 30_000,
  imageTimeoutMs: 300_000,
  videoTimeoutMs: 1_200_000,
  workflowMaxBytes: 2 * 1024 * 1024,
  inputMaxBytes: 25 * 1024 * 1024,
  outputMaxBytes: 512 * 1024 * 1024,
} as const

export interface ComfyRuntimeConfig {
  enabled: boolean
  networkPolicy: ComfyNetworkPolicyConfig
  healthIntervalMs: number
  dispatchIntervalMs: number
  reconcileIntervalMs: number
  leaseTtlMs: number
  imageTimeoutMs: number
  videoTimeoutMs: number
  workflowMaxBytes: number
  inputMaxBytes: number
  outputMaxBytes: number
}

export interface ComfyRuntimeDeps {
  healthTick(signal: AbortSignal, config: ComfyRuntimeConfig): Promise<{ idle: boolean } | void>
  dispatchTick(signal: AbortSignal, config: ComfyRuntimeConfig): Promise<void>
  reconcileTick(signal: AbortSignal, config: ComfyRuntimeConfig): Promise<void>
  preSubmitRecoveryTick(signal: AbortSignal, config: ComfyRuntimeConfig): Promise<void>
  onError(error: unknown, loop: 'health' | 'dispatch' | 'reconcile'): void
}

export interface ComfyRuntime {
  close(): Promise<void>
  wakeDispatcher(): void
}

interface StartComfyRuntimeOptions {
  config?: ComfyRuntimeConfig
  deps?: Partial<ComfyRuntimeDeps>
}

type LoopName = 'health' | 'dispatch' | 'reconcile'
type Timer = ReturnType<typeof setTimeout>

export function startComfyRuntime(options: StartComfyRuntimeOptions = {}): ComfyRuntime {
  const config = options.config ?? readComfyRuntimeConfig(process.env)
  const deps = requireRuntimeDeps(options.deps)
  const controller = new AbortController()
  const timers = new Map<LoopName, Timer>()
  const active = new Set<Promise<void>>()
  let closing = false
  let dispatchWakePending = false

  const clearTimer = (name: LoopName) => {
    const timer = timers.get(name)
    if (timer) clearTimeout(timer)
    timers.delete(name)
  }

  const schedule = (name: LoopName, delayMs: number, operation: () => Promise<void>) => {
    if (closing || !config.enabled) return
    clearTimer(name)
    const timer = setTimeout(() => {
      timers.delete(name)
      const promise = operation()
      active.add(promise)
      void promise.finally(() => active.delete(promise))
    }, delayMs)
    timer.unref?.()
    timers.set(name, timer)
  }

  const runDispatch = async (): Promise<void> => {
    dispatchWakePending = false
    try {
      await deps.dispatchTick(controller.signal, config)
    } catch (error) {
      if (!controller.signal.aborted) deps.onError(error, 'dispatch')
    } finally {
      if (!closing) {
        schedule('dispatch', dispatchWakePending ? 0 : config.dispatchIntervalMs, runDispatch)
      }
    }
  }

  const wakeDispatcher = () => {
    if (closing || !config.enabled) return
    dispatchWakePending = true
    if (timers.has('dispatch')) schedule('dispatch', 0, runDispatch)
  }

  const runHealth = async (): Promise<void> => {
    try {
      const result = await deps.healthTick(controller.signal, config)
      if (result?.idle) wakeDispatcher()
    } catch (error) {
      if (!controller.signal.aborted) deps.onError(error, 'health')
    } finally {
      schedule('health', config.healthIntervalMs, runHealth)
    }
  }

  const runReconcile = async (): Promise<void> => {
    try {
      await deps.reconcileTick(controller.signal, config)
    } catch (error) {
      if (!controller.signal.aborted) deps.onError(error, 'reconcile')
    }
    if (!controller.signal.aborted) {
      try {
        await deps.preSubmitRecoveryTick(controller.signal, config)
      } catch (error) {
        if (!controller.signal.aborted) deps.onError(error, 'reconcile')
      }
    }
    schedule('reconcile', config.reconcileIntervalMs, runReconcile)
  }

  if (config.enabled) {
    schedule('health', 0, runHealth)
    schedule('dispatch', 0, runDispatch)
    schedule('reconcile', 0, runReconcile)
  }

  return {
    wakeDispatcher,
    async close() {
      if (closing) {
        await Promise.allSettled([...active])
        return
      }
      closing = true
      controller.abort()
      for (const name of timers.keys()) clearTimer(name)
      await Promise.allSettled([...active])
    },
  }
}

export function readComfyRuntimeConfig(
  env: Record<string, string | undefined>,
): ComfyRuntimeConfig {
  const enabled = parseBoolean(env, 'COMFYUI_ENABLED', false)
  if (!enabled) return defaultRuntimeConfig()
  const mode = parseNetworkMode(env.COMFYUI_NETWORK_MODE)
  const allowedHosts = parseHosts(env.COMFYUI_ALLOWED_HOSTS)
  const allowedCidrs = parseCidrs(env.COMFYUI_ALLOWED_CIDRS)
  if (enabled && mode === 'allowlist' && allowedHosts.length === 0 && allowedCidrs.length === 0) {
    throw invalid('COMFYUI_ALLOWED_HOSTS/COMFYUI_ALLOWED_CIDRS')
  }
  return {
    enabled,
    networkPolicy: { mode, allowedHosts, allowedCidrs },
    healthIntervalMs: parseInteger(env, 'COMFYUI_HEALTH_INTERVAL_MS', DEFAULTS.healthIntervalMs, 100, 3_600_000),
    dispatchIntervalMs: parseInteger(env, 'COMFYUI_DISPATCH_INTERVAL_MS', DEFAULTS.dispatchIntervalMs, 100, 3_600_000),
    reconcileIntervalMs: parseInteger(env, 'COMFYUI_RECONCILE_INTERVAL_MS', DEFAULTS.reconcileIntervalMs, 100, 3_600_000),
    leaseTtlMs: parseInteger(env, 'COMFYUI_LEASE_TTL_MS', DEFAULTS.leaseTtlMs, 3_000, 300_000),
    imageTimeoutMs: parseInteger(env, 'COMFYUI_IMAGE_TIMEOUT_MS', DEFAULTS.imageTimeoutMs, 1_000, 86_400_000),
    videoTimeoutMs: parseInteger(env, 'COMFYUI_VIDEO_TIMEOUT_MS', DEFAULTS.videoTimeoutMs, 1_000, 86_400_000),
    workflowMaxBytes: parseInteger(env, 'COMFYUI_WORKFLOW_MAX_BYTES', DEFAULTS.workflowMaxBytes, 1_024, 100 * 1024 * 1024),
    inputMaxBytes: parseInteger(env, 'COMFYUI_INPUT_MAX_BYTES', DEFAULTS.inputMaxBytes, 1_024, 2 * 1024 * 1024 * 1024),
    outputMaxBytes: parseInteger(env, 'COMFYUI_OUTPUT_MAX_BYTES', DEFAULTS.outputMaxBytes, 1_024, 2 * 1024 * 1024 * 1024),
  }
}

function defaultRuntimeConfig(): ComfyRuntimeConfig {
  return {
    enabled: false,
    networkPolicy: { mode: 'allowlist', allowedHosts: [], allowedCidrs: [] },
    ...DEFAULTS,
  }
}

function requireRuntimeDeps(input: Partial<ComfyRuntimeDeps> | undefined): ComfyRuntimeDeps {
  const missing = (['healthTick', 'dispatchTick', 'reconcileTick', 'preSubmitRecoveryTick'] as const)
    .filter((key) => typeof input?.[key] !== 'function')
  if (missing.length > 0) throw new Error(`Missing ComfyUI runtime dependencies: ${missing.join(', ')}`)
  return {
    healthTick: input!.healthTick!,
    dispatchTick: input!.dispatchTick!,
    reconcileTick: input!.reconcileTick!,
    preSubmitRecoveryTick: input!.preSubmitRecoveryTick!,
    onError: input?.onError ?? (() => undefined),
  }
}

function parseBoolean(env: Record<string, string | undefined>, key: string, fallback: boolean) {
  const value = env[key]
  if (value === undefined || value === '') return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw invalid(key)
}

function parseNetworkMode(value: string | undefined): ComfyNetworkPolicyConfig['mode'] {
  if (value === undefined || value === '' || value === 'allowlist') return 'allowlist'
  if (value === 'trusted') return 'trusted'
  throw invalid('COMFYUI_NETWORK_MODE')
}

function parseInteger(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalid(key)
  return value
}

function parseHosts(value: string | undefined) {
  return parseList(value, 'COMFYUI_ALLOWED_HOSTS', (entry) => {
    const host = entry.startsWith('*.') ? entry.slice(2) : entry
    if (!host || (!isIP(host) && (/[\s/:?#@\[\]]/.test(host) || !isHostname(host)))) {
      throw invalid('COMFYUI_ALLOWED_HOSTS')
    }
    return entry.toLowerCase()
  })
}

function parseCidrs(value: string | undefined) {
  return parseList(value, 'COMFYUI_ALLOWED_CIDRS', (entry) => {
    const pieces = entry.split('/')
    if (pieces.length !== 2) throw invalid('COMFYUI_ALLOWED_CIDRS')
    const family = isIP(pieces[0])
    const prefix = Number(pieces[1])
    if (!family || !Number.isInteger(prefix) || prefix < 0
      || prefix > (family === 4 ? 32 : 128)) throw invalid('COMFYUI_ALLOWED_CIDRS')
    return entry.toLowerCase()
  })
}

function parseList(
  value: string | undefined,
  key: string,
  validate: (entry: string) => string,
) {
  if (!value?.trim()) return []
  const entries = value.split(',').map((entry) => entry.trim())
  if (entries.some((entry) => !entry)) throw invalid(key)
  return [...new Set(entries.map(validate))]
}

function isHostname(value: string) {
  return value.length <= 253 && value.split('.').every((label) =>
    label.length > 0 && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
}

function invalid(key: string) {
  return new Error(`Invalid ${key}`)
}
