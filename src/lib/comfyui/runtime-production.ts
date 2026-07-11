import { prisma } from '@/lib/prisma'
import { redis } from '@/lib/redis'
import { randomUUID } from 'node:crypto'

import { probeOwnedConnectionStatuses } from './connection-service'
import { cacheComfyHealthIfNewer } from './health'
import { checkComfyCompatibility, type ComfyCompatibilityCache } from './compatibility'
import { dispatchComfyRequest, reconcileComfyRequest } from './dispatcher'
import { scanExpiredPreSubmitComfyRequests } from './recovery-scan'
import {
  createDefaultComfySchedulerDependencies,
  scheduleNextComfyRequest,
} from './scheduler'
import type { ComfyRuntimeConfig } from './runtime'
import type { ComfyRuntimeOperationLimits } from './runtime-deps'
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

export async function listProductionComfyHealthOwners() {
  const records = await prisma.comfyConnection.findMany({
    where: { enabled: true }, distinct: ['userId'], select: { userId: true },
  })
  return records.map((record) => record.userId)
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

export async function listProductionComfyDispatchOwners() {
  const records = await prisma.comfyGenerationRequest.findMany({
    where: { status: { in: ['waiting_capacity', 'blocked_no_compatible_instance'] } },
    distinct: ['userId'], select: { userId: true }, orderBy: { userId: 'asc' },
  })
  return records.map((record) => record.userId)
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

export async function listProductionComfyReconcileRequests() {
  const records = await prisma.comfyGenerationRequest.findMany({
    where: {
      status: { in: ['submitting', 'submitted', 'running', 'transferring', 'reconciling'] },
      connectionId: { not: null }, leaseId: { not: null },
    },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: 100,
    select: {
      id: true, mediaType: true, status: true, connectionId: true,
      leaseId: true, leaseExpiresAt: true,
    },
  })
  const candidates = [] as Array<{ requestId: string; mediaType: 'image' | 'video' }>
  for (const record of records) {
    if ((record.mediaType !== 'image' && record.mediaType !== 'video') || !record.connectionId) continue
    const redisOwner = await redis.get(comfyLeaseKey(record.connectionId))
    // Redis is the live ownership authority. A conservative DB expiry alone must
    // never let reconciliation race an active dispatcher heartbeat.
    const recoverable = redisOwner === null
    if (recoverable) candidates.push({ requestId: record.id, mediaType: record.mediaType })
  }
  return candidates
}

export async function reconcileProductionComfyRequest(
  requestId: string,
  limits: ComfyRuntimeOperationLimits,
  signal: AbortSignal,
) {
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
  try {
    if (!await reclaimProductionRequestIfNeeded(requestId, limits.leaseTtlMs)) return
    if (lockLost || signal.aborted) return
    const result = await reconcileComfyRequest(
      requestId,
      await createProductionReconciliationDependencies(requestId, limits, async () =>
        !lockLost && await redis.get(lockKey) === lockValue),
    )
    if (result.outcome === 'transferring' && !signal.aborted && !lockLost) {
      return dispatchComfyRequest(
        requestId,
        await createProductionDispatcherDependencies(requestId, limits, signal),
      )
    }
    return result
  } finally {
    clearInterval(heartbeat)
    await redis.eval(COMFY_LEASE_RELEASE_SCRIPT, 1, lockKey, lockValue).catch(() => 0)
  }
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
