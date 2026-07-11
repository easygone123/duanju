import { logError as _ulogError } from '@/lib/logging/core'

import type { ComfyRuntimeConfig, ComfyRuntimeDeps } from './runtime'
import type { ComfyHealthState } from './types'

export interface ComfyRuntimeOperationLimits {
  leaseTtlMs: number
  workflowMaxBytes: number
  inputMaxBytes: number
  outputMaxBytes: number
  executionTimeoutMs: number
  networkPolicy: ComfyRuntimeConfig['networkPolicy']
}

type ScheduleResult =
  | { outcome: 'empty' | 'waiting_capacity' | 'blocked_no_compatible_instance' | 'lost_race' }
  | { outcome: 'leased'; requestId: string; connectionId: string; leaseId: string; mediaType: 'image' | 'video' }

export interface ProductionComfyRuntimeServices {
  listHealthOwners(): Promise<string[]>
  probeOwnerHealth(
    userId: string,
    config: ComfyRuntimeConfig,
  ): Promise<Array<{ state: ComfyHealthState }>>
  listDispatchOwners(): Promise<string[]>
  scheduleNext(userId: string, config: ComfyRuntimeConfig): Promise<ScheduleResult>
  dispatch(
    requestId: string,
    limits: ComfyRuntimeOperationLimits,
    signal: AbortSignal,
  ): Promise<unknown>
  listReconcileRequests(): Promise<Array<{ requestId: string; mediaType: 'image' | 'video' }>>
  reconcile(
    requestId: string,
    limits: ComfyRuntimeOperationLimits,
    signal: AbortSignal,
  ): Promise<unknown>
  scanExpiredPreSubmit(): Promise<unknown>
  onError(error: unknown, loop: 'health' | 'dispatch' | 'reconcile'): void
}

const productionServices: ProductionComfyRuntimeServices = {
  listHealthOwners: async () => (await import('./runtime-production')).listProductionComfyHealthOwners(),
  probeOwnerHealth: async (userId, config) => (await import('./runtime-production')).probeProductionComfyOwnerHealth(userId, config),
  listDispatchOwners: async () => (await import('./runtime-production')).listProductionComfyDispatchOwners(),
  scheduleNext: async (userId, config) => (await import('./runtime-production')).scheduleProductionComfyRequest(userId, config),
  dispatch: async (requestId, limits, signal) => (await import('./runtime-production')).dispatchProductionComfyRequest(requestId, limits, signal),
  listReconcileRequests: async () => (await import('./runtime-production')).listProductionComfyReconcileRequests(),
  reconcile: async (requestId, limits, signal) => (await import('./runtime-production')).reconcileProductionComfyRequest(requestId, limits, signal),
  scanExpiredPreSubmit: async () => (await import('./runtime-production')).scanProductionExpiredPreSubmit(),
  onError: (_error, loop) => {
    _ulogError('[ComfyUI runtime] loop failed', { loop })
  },
}

export function createProductionComfyRuntimeDeps(
  overrides: Partial<ProductionComfyRuntimeServices> = {},
): ComfyRuntimeDeps {
  const services = { ...productionServices, ...overrides }
  let ownerCursor = 0
  const failures = new Map<string, { attempts: number; retryAt: number }>()
  const allowed = (key: string) => (failures.get(key)?.retryAt ?? 0) <= Date.now()
  const failed = (key: string, config: ComfyRuntimeConfig) => {
    const attempts = (failures.get(key)?.attempts ?? 0) + 1
    const exponential = Math.min(
      config.failureBackoffMaxMs,
      config.failureBackoffBaseMs * 2 ** Math.min(attempts - 1, 16),
    )
    failures.set(key, { attempts, retryAt: Date.now() + exponential * (0.75 + Math.random() * 0.5) })
  }
  const succeeded = (key: string) => failures.delete(key)
  return {
    onError: services.onError,
    async healthTick(signal, config) {
      let idle = false
      for (const userId of await services.listHealthOwners()) {
        if (signal.aborted) break
        const key = `health:${userId}`
        if (!allowed(key)) continue
        try {
          const statuses = await services.probeOwnerHealth(userId, config)
          if (statuses.some((status) => status.state === 'online_idle')) idle = true
          succeeded(key)
        } catch (error) {
          failed(key, config); services.onError(error, 'health')
        }
      }
      return { idle }
    },
    async dispatchTick(signal, config) {
      const owners = await services.listDispatchOwners()
      const rotated = [...owners.slice(ownerCursor), ...owners.slice(0, ownerCursor)]
        .slice(0, config.pageSize)
      ownerCursor = owners.length === 0 ? 0 : (ownerCursor + rotated.length) % owners.length
      const executions: Promise<unknown>[] = []
      for (const userId of rotated) {
        if (executions.length >= config.dispatchConcurrency || signal.aborted) break
        const key = `dispatch:${userId}`
        if (!allowed(key)) continue
        try {
          const result = await services.scheduleNext(userId, config)
          succeeded(key)
          if (result.outcome === 'leased') {
            const requestKey = `dispatch-request:${result.requestId}`
            if (!allowed(requestKey)) continue
            executions.push(services.dispatch(
              result.requestId, limitsFor(result.mediaType, config), signal,
            ).then(() => succeeded(requestKey)).catch((error) => {
              failed(requestKey, config); services.onError(error, 'dispatch')
            }))
          }
        } catch (error) {
          failed(key, config); services.onError(error, 'dispatch')
        }
      }
      await Promise.all(executions)
    },
    async reconcileTick(signal, config) {
      for (const request of await services.listReconcileRequests()) {
        if (signal.aborted) break
        const key = `reconcile:${request.requestId}`
        if (!allowed(key)) continue
        try {
          await services.reconcile(request.requestId, limitsFor(request.mediaType, config), signal)
          succeeded(key)
        } catch (error) {
          failed(key, config); services.onError(error, 'reconcile')
        }
      }
    },
    async preSubmitRecoveryTick(signal) {
      if (!signal.aborted) await services.scanExpiredPreSubmit()
    },
  }
}

function limitsFor(
  mediaType: 'image' | 'video',
  config: ComfyRuntimeConfig,
): ComfyRuntimeOperationLimits {
  return {
    leaseTtlMs: config.leaseTtlMs,
    workflowMaxBytes: config.workflowMaxBytes,
    inputMaxBytes: config.inputMaxBytes,
    outputMaxBytes: config.outputMaxBytes,
    executionTimeoutMs: mediaType === 'image' ? config.imageTimeoutMs : config.videoTimeoutMs,
    networkPolicy: config.networkPolicy,
  }
}
