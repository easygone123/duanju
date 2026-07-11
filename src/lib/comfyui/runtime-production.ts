import { prisma } from '@/lib/prisma'
import { redis } from '@/lib/redis'
import { randomUUID } from 'node:crypto'

import { probeOwnedConnectionStatuses } from './connection-service'
import { cacheComfyHealthIfNewer } from './health'
import { checkComfyCompatibility, type ComfyCompatibilityCache } from './compatibility'
import { dispatchComfyRequest, reconcileComfyRequest } from './dispatcher'
import { COMFY_ERROR_CODE } from './errors'
import { releaseComfyRequestLease } from './lease'
import { scanExpiredPreSubmitComfyRequests } from './recovery-scan'
import {
  createDefaultComfySchedulerDependencies,
  scheduleNextComfyRequest,
} from './scheduler'
import type { ComfyRuntimeConfig } from './runtime'
import type {
  ComfyCursorPageInput,
  ComfyBackedOffLeaseInput,
  ComfyOwnerCursorItem,
  ComfyReconcileCursorInput,
  ComfyRuntimeOperationLimits,
} from './runtime-deps'
import {
  createProductionDispatcherDependencies,
  createProductionComfyClient,
  createProductionReconciliationDependencies,
} from './runtime-execution-adapter'
import type { ComfyApiWorkflow, ComfyWorkflowRequirements } from './types'
import { comfyLeaseKey, COMFY_LEASE_RELEASE_SCRIPT, COMFY_LEASE_RENEW_SCRIPT } from './test-lease'
import { reclaimComfyRecoveryLease } from './submission'

const compatibilityCache: ComfyCompatibilityCache = new Map()
const compatibilityExpiry = new Map<string, number>()

export async function listProductionComfyHealthOwners(input: ComfyCursorPageInput) {
  return listProductionComfyOwnerPage(input)
}

export async function probeProductionComfyOwnerHealth(
  userId: string,
  config: ComfyRuntimeConfig,
) {
  const statuses = await probeOwnedConnectionStatuses(userId, {
    networkPolicy: config.networkPolicy,
    clientLimits: {
      timeoutMs: Math.min(config.healthIntervalMs, 30_000),
      maxWorkflowBytes: config.workflowMaxBytes,
      maxInputBytes: config.inputMaxBytes,
      maxOutputBytes: config.outputMaxBytes,
    },
  })
  await Promise.all(statuses.map(({ connectionId, ...health }) => {
    const capabilityFingerprint = [...compatibilityCache.entries()]
      .find(([key]) => key.startsWith(`${connectionId}:`))?.[1].capabilityFingerprint
    return cacheComfyHealthIfNewer(
      redis, connectionId, { ...health, ...(capabilityFingerprint ? { capabilityFingerprint } : {}) },
      Math.min(config.healthIntervalMs * 3, 3_600_000),
    )
  }))
  return statuses
}

export async function listProductionComfyDispatchOwners(input: ComfyCursorPageInput) {
  const records = await prisma.comfyGenerationRequest.findMany({
    where: {
      status: { in: ['waiting_capacity', 'blocked_no_compatible_instance'] },
      ...(input.afterId ? { id: { gt: input.afterId } } : {}),
    },
    orderBy: { id: 'asc' },
    take: input.limit + 1,
    select: { id: true, userId: true },
  })
  return boundedPage<ComfyOwnerCursorItem>(records, input.limit, (record) => record.id)
}

async function listProductionComfyOwnerPage(input: ComfyCursorPageInput) {
  const records = await prisma.comfyConnection.findMany({
    where: { enabled: true, ...(input.afterId ? { id: { gt: input.afterId } } : {}) },
    orderBy: { id: 'asc' },
    take: input.limit + 1,
    select: { id: true, userId: true },
  })
  return boundedPage<ComfyOwnerCursorItem>(records, input.limit, (record) => record.id)
}

export async function scheduleProductionComfyRequest(
  userId: string,
  config: ComfyRuntimeConfig,
) {
  const dependencies = createDefaultComfySchedulerDependencies(
    async (connectionId, workflowVersionId, capabilityFingerprint) => {
      const version = await prisma.comfyWorkflowVersion.findFirst({
        where: {
          id: workflowVersionId,
          workflow: { userId },
        },
      })
      const connection = await prisma.comfyConnection.findFirst({
        where: { id: connectionId, userId, enabled: true },
      })
      if (!version || !connection) return false
      if (compatibilityCache.size > 10_000) compatibilityCache.clear()
      const exactKey = capabilityFingerprint
        ? `${connectionId}:${version.contentHash}:${capabilityFingerprint}` : null
      if (exactKey && (compatibilityExpiry.get(exactKey) ?? 0) > Date.now()) {
        const cached = compatibilityCache.get(exactKey)
        if (cached) return cached.compatible
      }
      try {
        const result = await checkComfyCompatibility({
          connectionId,
          workflowHash: version.contentHash,
          graph: version.apiFormatJson as unknown as ComfyApiWorkflow,
          requirements: version.requirements as unknown as ComfyWorkflowRequirements,
          client: createProductionComfyClient(connection, {
            leaseTtlMs: config.leaseTtlMs,
            workflowMaxBytes: config.workflowMaxBytes,
            inputMaxBytes: config.inputMaxBytes,
            outputMaxBytes: config.outputMaxBytes,
            executionTimeoutMs: config.imageTimeoutMs,
            networkPolicy: config.networkPolicy,
          }),
          cache: compatibilityCache,
        })
        const resultKey = `${connectionId}:${version.contentHash}:${result.capabilityFingerprint}`
        compatibilityExpiry.set(resultKey, Date.now() + config.healthIntervalMs * 3)
        return result.compatible
      } catch {
        return null
      }
    },
  )
  const result = await scheduleNextComfyRequest(userId, dependencies, {
    leaseTtlMs: config.leaseTtlMs,
  })
  if (result.outcome !== 'leased') return result
  const request = await prisma.comfyGenerationRequest.findFirst({
    where: { id: result.requestId, userId, connectionId: result.connectionId, leaseId: result.leaseId },
    select: { mediaType: true },
  })
  if (!request || (request.mediaType !== 'image' && request.mediaType !== 'video')) {
    throw new Error('Invalid leased ComfyUI request')
  }
  const mediaType: 'image' | 'video' = request.mediaType
  return { ...result, mediaType }
}

export async function dispatchProductionComfyRequest(
  requestId: string,
  limits: ComfyRuntimeOperationLimits,
  signal: AbortSignal,
) {
  return dispatchComfyRequest(
    requestId,
    await createProductionDispatcherDependencies(requestId, limits, signal),
  )
}

export async function returnProductionBackedOffLease(input: ComfyBackedOffLeaseInput) {
  const where = {
    id: input.requestId, userId: input.userId, connectionId: input.connectionId,
    leaseId: input.leaseId, status: 'leased',
  }
  try {
    const returned = await prisma.comfyGenerationRequest.updateMany({
      where,
      data: {
        status: 'waiting_capacity', connectionId: null, leaseId: null,
        leaseExpiresAt: null,
      },
    })
    if (returned.count !== 1) {
      await releaseComfyRequestLease(input).catch(() => false)
      return 'lost' as const
    }
    await releaseComfyRequestLease(input).catch(() => false)
    return 'waiting' as const
  } catch {
    const reconciling = await prisma.comfyGenerationRequest.updateMany({
      where,
      data: {
        status: 'reconciling', reconcilingAt: new Date(), leaseExpiresAt: new Date(),
        errorCode: COMFY_ERROR_CODE.RECONCILIATION_REQUIRED,
      },
    })
    if (reconciling.count !== 1) {
      await releaseComfyRequestLease(input).catch(() => false)
      return 'lost' as const
    }
    await releaseComfyRequestLease(input).catch(() => false)
    return 'reconciling' as const
  }
}

export async function listProductionComfyReconcileRequests(input: ComfyReconcileCursorInput) {
  const records = await prisma.comfyGenerationRequest.findMany({
    where: {
      status: { in: ['submitting', 'submitted', 'running', 'transferring', 'reconciling'] },
      leaseExpiresAt: { lte: input.now },
      connectionId: { not: null }, leaseId: { not: null },
      ...(input.afterId ? { id: { gt: input.afterId } } : {}),
    },
    orderBy: { id: 'asc' },
    take: input.limit + 1,
    select: { id: true, mediaType: true, connectionId: true },
  })
  const pageRecords = records.slice(0, input.limit)
  const candidates = [] as Array<{ requestId: string; mediaType: 'image' | 'video' }>
  for (const record of pageRecords) {
    if ((record.mediaType !== 'image' && record.mediaType !== 'video') || !record.connectionId) continue
    const redisOwner = await redis.get(comfyLeaseKey(record.connectionId)).catch(() => undefined)
    // Redis is the live ownership authority. A conservative DB expiry alone must
    // never let reconciliation race an active dispatcher heartbeat.
    if (redisOwner === null) candidates.push({ requestId: record.id, mediaType: record.mediaType })
  }
  return {
    items: candidates,
    nextCursor: records.length > input.limit && pageRecords.length > 0
      ? pageRecords[pageRecords.length - 1].id : null,
  }
}

function boundedPage<T>(records: T[], limit: number, idOf: (record: T) => string) {
  const items = records.slice(0, limit)
  return {
    items,
    nextCursor: records.length > limit && items.length > 0 ? idOf(items[items.length - 1]) : null,
  }
}

export async function reconcileProductionComfyRequest(
  requestId: string,
  limits: ComfyRuntimeOperationLimits,
  signal: AbortSignal,
  overrides: Partial<ProductionComfyReconcileServices> = {},
) {
  const services = { ...productionReconcileServices, ...overrides }
  if (signal.aborted) return
  const lockKey = `comfy:reconcile:${requestId}`
  const lockValue = randomUUID()
  if (await redis.set(lockKey, lockValue, 'PX', limits.leaseTtlMs, 'NX') !== 'OK') return
  let lockLost = false
  const heartbeat = setInterval(() => {
    void redis.eval(COMFY_LEASE_RENEW_SCRIPT, 1, lockKey, lockValue, limits.leaseTtlMs)
      .then((value) => { if (value !== 1) lockLost = true })
      .catch(() => { lockLost = true })
  }, Math.max(100, Math.floor(limits.leaseTtlMs / 3)))
  heartbeat.unref?.()
  const ownsClaim = async () => !lockLost && await redis.get(lockKey) === lockValue
  try {
    if (!await services.reclaimRequest(requestId, limits.leaseTtlMs)) return
    if (signal.aborted || !await ownsClaim()) return
    const result = await services.reconcile(
      requestId,
      await services.createReconciliationDependencies(requestId, limits, ownsClaim),
    )
    if (result.outcome === 'transferring' && !signal.aborted && await ownsClaim()) {
      return await services.dispatch(
        requestId,
        await services.createDispatcherDependencies(requestId, limits, signal, ownsClaim),
      )
    }
    return result
  } finally {
    clearInterval(heartbeat)
    await redis.eval(COMFY_LEASE_RELEASE_SCRIPT, 1, lockKey, lockValue).catch(() => 0)
  }
}

interface ProductionComfyReconcileServices {
  reclaimRequest: typeof reclaimProductionRequestIfNeeded
  createReconciliationDependencies: typeof createProductionReconciliationDependencies
  reconcile: typeof reconcileComfyRequest
  createDispatcherDependencies: typeof createProductionDispatcherDependencies
  dispatch: typeof dispatchComfyRequest
}

const productionReconcileServices: ProductionComfyReconcileServices = {
  reclaimRequest: reclaimProductionRequestIfNeeded,
  createReconciliationDependencies: createProductionReconciliationDependencies,
  reconcile: reconcileComfyRequest,
  createDispatcherDependencies: createProductionDispatcherDependencies,
  dispatch: dispatchComfyRequest,
}

async function reclaimProductionRequestIfNeeded(requestId: string, ttlMs: number) {
  const record = await prisma.comfyGenerationRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true, userId: true, connectionId: true, leaseId: true,
      leaseExpiresAt: true, status: true,
      submissionAttempts: { select: { id: true }, take: 1 },
    },
  })
  if (!record?.connectionId || !record.leaseId || !record.leaseExpiresAt) return false
  const redisOwner = await redis.get(comfyLeaseKey(record.connectionId))
  if (redisOwner !== null) return false
  const now = new Date()
  if (record.leaseExpiresAt.getTime() > now.getTime()) {
    await prisma.comfyGenerationRequest.updateMany({
      where: { id: record.id, leaseId: record.leaseId }, data: { leaseExpiresAt: now },
    })
  }
  const result = await reclaimComfyRecoveryLease({
    requestId: record.id, userId: record.userId, connectionId: record.connectionId,
    previousLeaseId: record.leaseId, newLeaseId: randomUUID(), ttlMs,
    leaseExpiredAt: now, now, hasSubmissionAttempt: record.submissionAttempts.length > 0,
  })
  return result.outcome === 'reclaimed'
}

export async function scanProductionExpiredPreSubmit() {
  return scanExpiredPreSubmitComfyRequests()
}
