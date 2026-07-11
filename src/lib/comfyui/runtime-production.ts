import { prisma } from '@/lib/prisma'
import { redis } from '@/lib/redis'

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

const compatibilityCache: ComfyCompatibilityCache = new Map()

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
  const statuses = await probeOwnedConnectionStatuses(userId)
  await Promise.all(statuses.map(({ connectionId, ...health }) =>
    cacheComfyHealthIfNewer(
      redis, connectionId, health,
      Math.min(config.healthIntervalMs * 3, 3_600_000),
    )))
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
    async (connectionId, workflowVersionId) => {
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
    select: { id: true, mediaType: true },
  })
  return records.flatMap((record) => record.mediaType === 'image' || record.mediaType === 'video'
    ? [{ requestId: record.id, mediaType: record.mediaType as 'image' | 'video' }]
    : [])
}

export async function reconcileProductionComfyRequest(
  requestId: string,
  limits: ComfyRuntimeOperationLimits,
  signal: AbortSignal,
) {
  if (signal.aborted) return
  const result = await reconcileComfyRequest(
    requestId,
    await createProductionReconciliationDependencies(requestId, limits),
  )
  if (result.outcome === 'transferring' && !signal.aborted) {
    return dispatchComfyRequest(
      requestId,
      await createProductionDispatcherDependencies(requestId, limits, signal),
    )
  }
  return result
}

export async function scanProductionExpiredPreSubmit() {
  return scanExpiredPreSubmitComfyRequests()
}
