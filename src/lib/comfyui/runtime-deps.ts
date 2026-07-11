import { logError as _ulogError } from '@/lib/logging/core'

import type { ComfyRuntimeConfig, ComfyRuntimeDeps } from './runtime'
import type { ComfyHealthState } from './types'

const MAX_ASSIGNMENTS_PER_OWNER_TICK = 100

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
  return {
    onError: services.onError,
    async healthTick(signal, config) {
      let idle = false
      for (const userId of await services.listHealthOwners()) {
        if (signal.aborted) break
        const statuses = await services.probeOwnerHealth(userId, config)
        if (statuses.some((status) => status.state === 'online_idle')) idle = true
      }
      return { idle }
    },
    async dispatchTick(signal, config) {
      const executions: Promise<unknown>[] = []
      for (const userId of await services.listDispatchOwners()) {
        for (let count = 0; count < MAX_ASSIGNMENTS_PER_OWNER_TICK && !signal.aborted; count += 1) {
          const result = await services.scheduleNext(userId, config)
          if (result.outcome !== 'leased') break
          executions.push(services.dispatch(
            result.requestId,
            limitsFor(result.mediaType, config),
            signal,
          ).catch((error) => services.onError(error, 'dispatch')))
        }
      }
      await Promise.all(executions)
    },
    async reconcileTick(signal, config) {
      for (const request of await services.listReconcileRequests()) {
        if (signal.aborted) break
        await services.reconcile(
          request.requestId,
          limitsFor(request.mediaType, config),
          signal,
        )
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
