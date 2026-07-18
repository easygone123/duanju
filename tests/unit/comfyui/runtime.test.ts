import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  readComfyRuntimeConfig,
  startComfyRuntime,
  type ComfyRuntimeConfig,
  type ComfyRuntimeDeps,
} from '@/lib/comfyui/runtime'
import { persistOwnedComfyNumericDiagnostics } from '@/lib/comfyui/runtime-execution-adapter'

const config: ComfyRuntimeConfig = {
  enabled: true,
  networkPolicy: { mode: 'allowlist', allowedHosts: [], allowedCidrs: [] },
  healthIntervalMs: 1_000,
  dispatchIntervalMs: 500,
  reconcileIntervalMs: 2_000,
  leaseTtlMs: 30_000,
  imageTimeoutMs: 300_000,
  videoTimeoutMs: 1_200_000,
  workflowMaxBytes: 2_097_152,
  inputMaxBytes: 26_214_400,
  outputMaxBytes: 536_870_912,
  dispatchConcurrency: 8,
  pageSize: 100,
  failureBackoffBaseMs: 1_000,
  failureBackoffMaxMs: 60_000,
}

function deps(overrides: Partial<ComfyRuntimeDeps> = {}): ComfyRuntimeDeps {
  return {
    healthTick: vi.fn().mockResolvedValue({ idle: false }),
    dispatchTick: vi.fn().mockResolvedValue(undefined),
    reconcileTick: vi.fn().mockResolvedValue(undefined),
    preSubmitRecoveryTick: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
    ...overrides,
  }
}

async function flushImmediateTicks() {
  await vi.advanceTimersByTimeAsync(0)
}

describe('ComfyUI runtime lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('ticks health, dispatch, reconcile, and pre-submit recovery immediately', async () => {
    vi.useFakeTimers()
    const dependencies = deps()
    const runtime = startComfyRuntime({ config, deps: dependencies })

    await flushImmediateTicks()

    expect(dependencies.healthTick).toHaveBeenCalledOnce()
    expect(dependencies.dispatchTick).toHaveBeenCalledOnce()
    expect(dependencies.reconcileTick).toHaveBeenCalledOnce()
    expect(dependencies.preSubmitRecoveryTick).toHaveBeenCalledOnce()
    expect(dependencies.healthTick).toHaveBeenCalledWith(expect.any(AbortSignal), config)
    expect(dependencies.dispatchTick).toHaveBeenCalledWith(expect.any(AbortSignal), config)
    await runtime.close()
  })

  it('does not overlap a slow dispatch tick and uses a bounded fallback interval', async () => {
    vi.useFakeTimers()
    const first = Promise.withResolvers<void>()
    const dispatchTick = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
    const runtime = startComfyRuntime({ config, deps: deps({ dispatchTick }) })
    await flushImmediateTicks()

    await vi.advanceTimersByTimeAsync(config.dispatchIntervalMs * 5)
    expect(dispatchTick).toHaveBeenCalledOnce()

    first.resolve()
    await flushImmediateTicks()
    await vi.advanceTimersByTimeAsync(config.dispatchIntervalMs)
    expect(dispatchTick).toHaveBeenCalledTimes(2)
    await runtime.close()
  })

  it('coalesces dispatcher wakeups and wakes immediately when health reports idle', async () => {
    vi.useFakeTimers()
    const healthTick = vi.fn()
      .mockResolvedValueOnce({ idle: false })
      .mockResolvedValueOnce({ idle: true })
    const dispatchTick = vi.fn().mockResolvedValue(undefined)
    const runtime = startComfyRuntime({ config, deps: deps({ healthTick, dispatchTick }) })
    await flushImmediateTicks()
    expect(dispatchTick).toHaveBeenCalledOnce()

    runtime.wakeDispatcher()
    runtime.wakeDispatcher()
    runtime.wakeDispatcher()
    await flushImmediateTicks()
    expect(dispatchTick).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(config.healthIntervalMs)
    expect(healthTick).toHaveBeenCalledTimes(2)
    expect(dispatchTick).toHaveBeenCalledTimes(3)
    await runtime.close()
  })

  it('runs reconciliation and the Task 8 pre-submit recovery scan periodically in order', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const reconcileTick = vi.fn(async () => { calls.push('reconcile') })
    const preSubmitRecoveryTick = vi.fn(async () => { calls.push('pre-submit') })
    const runtime = startComfyRuntime({
      config,
      deps: deps({ reconcileTick, preSubmitRecoveryTick }),
    })
    await flushImmediateTicks()
    expect(calls).toEqual(['reconcile', 'pre-submit'])

    await vi.advanceTimersByTimeAsync(config.reconcileIntervalMs)
    expect(calls).toEqual(['reconcile', 'pre-submit', 'reconcile', 'pre-submit'])
    await runtime.close()
  })

  it('still runs pre-submit recovery when request reconciliation fails', async () => {
    vi.useFakeTimers()
    const failure = new Error('reconcile unavailable')
    const preSubmitRecoveryTick = vi.fn().mockResolvedValue(undefined)
    const onError = vi.fn()
    const runtime = startComfyRuntime({
      config,
      deps: deps({
        reconcileTick: vi.fn().mockRejectedValue(failure),
        preSubmitRecoveryTick,
        onError,
      }),
    })
    await flushImmediateTicks()

    expect(preSubmitRecoveryTick).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(failure, 'reconcile')
    await runtime.close()
  })

  it('aborts active work, stops future ticks, and waits for graceful close', async () => {
    vi.useFakeTimers()
    let observedSignal: AbortSignal | undefined
    const stopped = Promise.withResolvers<void>()
    const dispatchTick = vi.fn((signal: AbortSignal) => {
      observedSignal = signal
      return stopped.promise
    })
    const runtime = startComfyRuntime({ config, deps: deps({ dispatchTick }) })
    await flushImmediateTicks()

    let closed = false
    const closing = runtime.close().then(() => { closed = true })
    expect(observedSignal?.aborted).toBe(true)
    await Promise.resolve()
    expect(closed).toBe(false)

    stopped.resolve()
    await closing
    await vi.advanceTimersByTimeAsync(config.dispatchIntervalMs * 3)
    expect(dispatchTick).toHaveBeenCalledOnce()
  })

  it('is inert when disabled', async () => {
    vi.useFakeTimers()
    const dependencies = deps()
    const runtime = startComfyRuntime({
      config: { ...config, enabled: false },
      deps: dependencies,
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(dependencies.healthTick).not.toHaveBeenCalled()
    expect(dependencies.dispatchTick).not.toHaveBeenCalled()
    expect(dependencies.reconcileTick).not.toHaveBeenCalled()
    await runtime.close()
  })
})

describe('ComfyUI numeric diagnostics persistence', () => {
  it('writes a bounded safe projection under the complete active request owner', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 })
    const persisted = await persistOwnedComfyNumericDiagnostics({
      requestId: 'request-1', userId: 'user-1', projectId: 'project-1',
      connectionId: 'connection-1', leaseId: 'lease-1',
    }, [{
      variable: 'duration', sourceValue: 5, targetValue: 81,
      encodedAs: 'number', sourceUnit: 'seconds', targetUnit: 'frames',
      effectiveFps: 16, rounding: 'round', frameOffset: 1,
      apiKey: 'must-not-persist', rawMedia: 'must-not-persist',
    } as never], updateMany)

    expect(persisted).toBe(true)
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'request-1', userId: 'user-1', projectId: 'project-1',
        connectionId: 'connection-1', leaseId: 'lease-1',
        status: 'uploading', promptId: null, clientId: null, cancelRequestedAt: null,
      },
      data: { numericDiagnostics: [{
        variable: 'duration', sourceValue: 5, targetValue: 81,
        encodedAs: 'number', sourceUnit: 'seconds', targetUnit: 'frames',
        effectiveFps: 16, rounding: 'round', frameOffset: 1,
      }] },
    })
    expect(JSON.stringify(updateMany.mock.calls[0])).not.toContain('must-not-persist')
  })

  it('reports ownership loss when the scoped update matches no active request', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 })
    await expect(persistOwnedComfyNumericDiagnostics({
      requestId: 'request-1', userId: 'user-1', projectId: 'project-1',
      connectionId: 'connection-1', leaseId: 'lease-1',
    }, [], updateMany)).resolves.toBe(false)
  })
})

describe('ComfyUI runtime configuration', () => {
  it('enables trusted ComfyUI by default and parses every approved setting exactly', () => {
    expect(readComfyRuntimeConfig({})).toMatchObject({
      enabled: true,
      networkPolicy: { mode: 'trusted', allowedHosts: [], allowedCidrs: [] },
    })

    expect(readComfyRuntimeConfig({
      COMFYUI_ENABLED: 'true',
      COMFYUI_NETWORK_MODE: 'trusted',
      COMFYUI_ALLOWED_HOSTS: 'gpu.local, *.example.com, ::1',
      COMFYUI_ALLOWED_CIDRS: '10.0.0.0/8,fd00::/8',
      COMFYUI_HEALTH_INTERVAL_MS: '1100',
      COMFYUI_DISPATCH_INTERVAL_MS: '600',
      COMFYUI_RECONCILE_INTERVAL_MS: '2100',
      COMFYUI_LEASE_TTL_MS: '31000',
      COMFYUI_IMAGE_TIMEOUT_MS: '301000',
      COMFYUI_VIDEO_TIMEOUT_MS: '1201000',
      COMFYUI_WORKFLOW_MAX_BYTES: '2097153',
      COMFYUI_INPUT_MAX_BYTES: '26214401',
      COMFYUI_OUTPUT_MAX_BYTES: '536870913',
      COMFYUI_DISPATCH_CONCURRENCY: '9',
      COMFYUI_PAGE_SIZE: '101',
      COMFYUI_FAILURE_BACKOFF_BASE_MS: '1100',
      COMFYUI_FAILURE_BACKOFF_MAX_MS: '61000',
    })).toEqual({
      enabled: true,
      networkPolicy: {
        mode: 'trusted',
        allowedHosts: ['gpu.local', '*.example.com', '::1'],
        allowedCidrs: ['10.0.0.0/8', 'fd00::/8'],
      },
      healthIntervalMs: 1100,
      dispatchIntervalMs: 600,
      reconcileIntervalMs: 2100,
      leaseTtlMs: 31000,
      imageTimeoutMs: 301000,
      videoTimeoutMs: 1201000,
      workflowMaxBytes: 2097153,
      inputMaxBytes: 26214401,
      outputMaxBytes: 536870913,
      dispatchConcurrency: 9,
      pageSize: 101,
      failureBackoffBaseMs: 1100,
      failureBackoffMaxMs: 61000,
    })
  })

  it.each([
    ['COMFYUI_ENABLED', '1'],
    ['COMFYUI_NETWORK_MODE', 'open'],
    ['COMFYUI_HEALTH_INTERVAL_MS', '0'],
    ['COMFYUI_DISPATCH_INTERVAL_MS', '1.5'],
    ['COMFYUI_RECONCILE_INTERVAL_MS', 'wat'],
    ['COMFYUI_LEASE_TTL_MS', '999'],
    ['COMFYUI_IMAGE_TIMEOUT_MS', '-1'],
    ['COMFYUI_VIDEO_TIMEOUT_MS', '999999999'],
    ['COMFYUI_WORKFLOW_MAX_BYTES', '12'],
    ['COMFYUI_INPUT_MAX_BYTES', '9999999999'],
    ['COMFYUI_OUTPUT_MAX_BYTES', 'Infinity'],
    ['COMFYUI_ALLOWED_HOSTS', 'https://gpu.local'],
    ['COMFYUI_ALLOWED_CIDRS', '10.0.0.0/99'],
  ])('fails fast without logging sensitive config when %s is invalid', (key, value) => {
    const consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ]
    expect(() => readComfyRuntimeConfig({
      COMFYUI_ENABLED: 'true',
      COMFYUI_NETWORK_MODE: 'trusted',
      [key]: value,
    })).toThrow(`Invalid ${key}`)
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled()
  })

  it('fails fast when enabled allowlist mode has no permitted hosts or networks', () => {
    expect(() => readComfyRuntimeConfig({
      COMFYUI_ENABLED: 'true',
      COMFYUI_NETWORK_MODE: 'allowlist',
    }))
      .toThrow('Invalid COMFYUI_ALLOWED_HOSTS/COMFYUI_ALLOWED_CIDRS')
  })

  it('keeps disabled ComfyUI inert without validating unused Comfy-only settings', () => {
    expect(readComfyRuntimeConfig({
      COMFYUI_ENABLED: 'false',
      COMFYUI_NETWORK_MODE: 'not-a-mode',
      COMFYUI_ALLOWED_HOSTS: 'https://invalid',
      COMFYUI_ALLOWED_CIDRS: 'invalid',
      COMFYUI_HEALTH_INTERVAL_MS: 'invalid',
    })).toMatchObject({
      enabled: false,
      networkPolicy: { mode: 'allowlist', allowedHosts: [], allowedCidrs: [] },
    })
  })
})
