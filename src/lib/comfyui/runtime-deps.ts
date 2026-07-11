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

export interface ComfyCursorPageInput {
  afterId: string | null
  limit: number
}

export interface ComfyCursorPage<T> {
  items: T[]
  nextCursor: string | null
}

export interface ComfyOwnerCursorItem {
  id: string
  userId: string
}

export interface ComfyReconcileCursorInput extends ComfyCursorPageInput {
  now: Date
}

export interface ComfyReconcileCursorItem {
  requestId: string
  mediaType: 'image' | 'video'
}

export interface ProductionComfyRuntimeServices {
  listHealthOwners(input: ComfyCursorPageInput): Promise<ComfyCursorPage<ComfyOwnerCursorItem>>
  probeOwnerHealth(
    userId: string,
    config: ComfyRuntimeConfig,
  ): Promise<Array<{ state: ComfyHealthState }>>
  listDispatchOwners(input: ComfyCursorPageInput): Promise<ComfyCursorPage<ComfyOwnerCursorItem>>
  scheduleNext(userId: string, config: ComfyRuntimeConfig): Promise<ScheduleResult>
  dispatch(
    requestId: string,
    limits: ComfyRuntimeOperationLimits,
    signal: AbortSignal,
  ): Promise<unknown>
  listReconcileRequests(
    input: ComfyReconcileCursorInput,
  ): Promise<ComfyCursorPage<ComfyReconcileCursorItem>>
  reconcile(
    requestId: string,
    limits: ComfyRuntimeOperationLimits,
    signal: AbortSignal,
  ): Promise<unknown>
  scanExpiredPreSubmit(): Promise<unknown>
  onError(error: unknown, loop: 'health' | 'dispatch' | 'reconcile'): void
}

const productionServices: ProductionComfyRuntimeServices = {
  listHealthOwners: async (input) => (await import('./runtime-production')).listProductionComfyHealthOwners(input),
  probeOwnerHealth: async (userId, config) => (await import('./runtime-production')).probeProductionComfyOwnerHealth(userId, config),
  listDispatchOwners: async (input) => (await import('./runtime-production')).listProductionComfyDispatchOwners(input),
  scheduleNext: async (userId, config) => (await import('./runtime-production')).scheduleProductionComfyRequest(userId, config),
  dispatch: async (requestId, limits, signal) => (await import('./runtime-production')).dispatchProductionComfyRequest(requestId, limits, signal),
  listReconcileRequests: async (input) => (await import('./runtime-production')).listProductionComfyReconcileRequests(input),
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
  let healthCursor: string | null = null
  let dispatchCursor: string | null = null
  let reconcileCursor: string | null = null
  const healthOwnersSeen = new Set<string>()
  const dispatchOwnersSeen = new Set<string>()
  const dispatchOwnersPending: string[] = []
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
      const page = await services.listHealthOwners({ afterId: healthCursor, limit: config.pageSize })
      healthCursor = page.nextCursor
      for (const userId of ownersForRound(page, healthOwnersSeen)) {
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
      if (dispatchOwnersPending.length === 0) {
        const page = await services.listDispatchOwners({
          afterId: dispatchCursor, limit: config.pageSize,
        })
        dispatchCursor = page.nextCursor
        dispatchOwnersPending.push(...ownersForRound(page, dispatchOwnersSeen))
      }
      const executions: Promise<unknown>[] = []
      let visited = 0
      for (const userId of dispatchOwnersPending) {
        if (executions.length >= config.dispatchConcurrency || signal.aborted) break
        visited += 1
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
      dispatchOwnersPending.splice(0, visited)
      await Promise.all(executions)
    },
    async reconcileTick(signal, config) {
      const page = await services.listReconcileRequests({
        afterId: reconcileCursor, limit: config.pageSize, now: new Date(),
      })
      reconcileCursor = page.nextCursor
      for (const request of page.items) {
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

function ownersForRound(
  page: ComfyCursorPage<ComfyOwnerCursorItem>,
  seen: Set<string>,
) {
  const owners: string[] = []
  for (const item of page.items) {
    if (seen.has(item.userId)) continue
    seen.add(item.userId)
    owners.push(item.userId)
  }
  if (page.nextCursor === null) seen.clear()
  return owners
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
