import { Prisma } from '@prisma/client'

import { prisma } from '@/lib/prisma'
import { redis } from '@/lib/redis'
import { TASK_STATUS } from '@/lib/task/types'

import { comfyHealthKey } from './health'
import {
  acquireComfyRequestLease,
  newComfyLeaseId,
  releaseComfyRequestLease,
  type ComfyRequestLeaseOwner,
} from './lease'
import {
  COMFY_ACTIVE_REQUEST_STATUSES,
  type ComfyHealthState,
  type ComfyRequestStatus,
} from './types'
import { COMFY_ERROR_CODE } from './errors'

const SCHEDULABLE_STATUSES = ['waiting_capacity', 'blocked_no_compatible_instance'] as const
const ACTIVE_PARENT_TASK_STATUSES = [TASK_STATUS.QUEUED, TASK_STATUS.PROCESSING] as const

export interface ComfySchedulableRequest {
  id: string
  userId: string
  workflowVersionId: string
  status: Extract<ComfyRequestStatus, 'waiting_capacity' | 'blocked_no_compatible_instance'>
  queuedAt: Date
  priority: number
}

export interface ComfySchedulableConnection {
  id: string
  userId: string
  enabled: boolean
  lastAssignedAt: Date | null
}

export interface ComfySchedulerDependencies {
  listSchedulableRequests(userId: string): Promise<ComfySchedulableRequest[]>
  listOwnedEnabledConnections(userId: string): Promise<ComfySchedulableConnection[]>
  readCachedHealth(connectionId: string): Promise<{ state: ComfyHealthState; capabilityFingerprint?: string } | null>
  checkCachedCompatibility(
    connectionId: string,
    workflowVersionId: string,
    capabilityFingerprint?: string,
  ): Promise<boolean | null>
  acquireLease(owner: ComfyRequestLeaseOwner): Promise<boolean>
  releaseLease(owner: ComfyRequestLeaseOwner): Promise<boolean>
  makeWaitingIfBlocked(
    requestId: string,
    userId: string,
    status: ComfySchedulableRequest['status'],
  ): Promise<boolean>
  assignIfEligible(input: {
    requestId: string
    userId: string
    connectionId: string
    leaseId: string
    leaseExpiresAt: Date
    assignedAt: Date
  }): Promise<ComfyAssignmentOutcome>
  markBlockedIfEligible(requestId: string, userId: string): Promise<boolean>
  failIncompatibleIfEligible(requestId: string, userId: string): Promise<boolean>
}

export type ComfyAssignmentOutcome = 'assigned' | 'request_lost' | 'connection_busy'

export interface ComfySchedulerOptions {
  leaseTtlMs?: number
  now?: () => Date
  newLeaseId?: () => string
}

interface ComfyAssignmentInput {
  requestId: string
  userId: string
  connectionId: string
  leaseId: string
  leaseExpiresAt: Date
  assignedAt: Date
}

interface ComfyAssignmentStore {
  transaction<T>(operation: (client: {
    updateConnection(input: Prisma.ComfyConnectionUpdateManyArgs): Promise<{ count: number }>
    updateRequest(input: Prisma.ComfyGenerationRequestUpdateManyArgs): Promise<{ count: number }>
    countActiveRequests(input: Prisma.ComfyGenerationRequestCountArgs): Promise<number>
  }) => Promise<T>): Promise<T>
}

export type ComfyScheduleResult =
  | { outcome: 'empty' }
  | { outcome: 'waiting_capacity'; requestId: string }
  | { outcome: 'blocked_no_compatible_instance'; requestId: string }
  | { outcome: 'failed_incompatible'; requestId: string }
  | { outcome: 'lost_race'; requestId: string }
  | { outcome: 'leased'; requestId: string; connectionId: string; leaseId: string }

export async function scheduleNextComfyRequest(
  userId: string,
  dependencies: ComfySchedulerDependencies,
  options: ComfySchedulerOptions = {},
): Promise<ComfyScheduleResult> {
  const requests = await dependencies.listSchedulableRequests(userId)
  const request = [...requests].sort(compareRequests)[0]
  if (!request) return { outcome: 'empty' }

  const connections = (await dependencies.listOwnedEnabledConnections(userId))
    .filter((connection) => connection.enabled && connection.userId === userId)
    .sort(compareConnections)
  if (connections.length === 0) {
    if (request.status === 'waiting_capacity'
      && !await dependencies.markBlockedIfEligible(request.id, userId)) {
      return { outcome: 'lost_race', requestId: request.id }
    }
    return { outcome: 'blocked_no_compatible_instance', requestId: request.id }
  }
  const idle: ComfySchedulableConnection[] = []
  for (const connection of connections) {
    const health = await dependencies.readCachedHealth(connection.id)
    if (health?.state === 'online_idle') idle.push(connection)
  }
  if (idle.length === 0) return { outcome: 'waiting_capacity', requestId: request.id }
  const compatible: ComfySchedulableConnection[] = []
  let compatibilityUnknown = false
  for (const connection of idle) {
    const health = await dependencies.readCachedHealth(connection.id)
    const result = await dependencies.checkCachedCompatibility(
      connection.id, request.workflowVersionId, health?.capabilityFingerprint,
    )
    if (result === true) compatible.push(connection)
    else if (result === null) compatibilityUnknown = true
  }
  if (compatible.length === 0) {
    if (compatibilityUnknown) {
      return { outcome: 'waiting_capacity', requestId: request.id }
    }
    if (!await dependencies.failIncompatibleIfEligible(request.id, userId)) {
      return { outcome: 'lost_race', requestId: request.id }
    }
    return { outcome: 'failed_incompatible', requestId: request.id }
  }

  if (!await dependencies.makeWaitingIfBlocked(request.id, userId, request.status)) {
    return { outcome: 'lost_race', requestId: request.id }
  }

  const now = options.now?.() ?? new Date()
  const ttlMs = options.leaseTtlMs ?? 30_000
  for (const connection of compatible) {
    const owner = {
      connectionId: connection.id,
      requestId: request.id,
      leaseId: options.newLeaseId?.() ?? newComfyLeaseId(),
      ttlMs,
    }
    if (!await dependencies.acquireLease(owner)) continue
    let assignment: ComfyAssignmentOutcome
    try {
      assignment = await dependencies.assignIfEligible({
        requestId: request.id,
        userId,
        connectionId: connection.id,
        leaseId: owner.leaseId,
        leaseExpiresAt: new Date(now.getTime() + ttlMs),
        assignedAt: now,
      })
    } catch (error) {
      try {
        await dependencies.releaseLease(owner)
      } catch {
        // Preserve the assignment error; the lease still has a bounded TTL.
      }
      throw error
    }
    if (assignment === 'assigned') {
      return {
        outcome: 'leased', requestId: request.id,
        connectionId: connection.id, leaseId: owner.leaseId,
      }
    }
    await bestEffortRelease(dependencies, owner)
    if (assignment === 'request_lost') {
      return { outcome: 'lost_race', requestId: request.id }
    }
  }
  return { outcome: 'lost_race', requestId: request.id }
}

export function createDefaultComfySchedulerDependencies(
  checkCachedCompatibility: ComfySchedulerDependencies['checkCachedCompatibility'],
): ComfySchedulerDependencies {
  return {
    listSchedulableRequests: async (userId) => {
      const records = await prisma.comfyGenerationRequest.findMany({
        where: {
          userId,
          status: { in: [...SCHEDULABLE_STATUSES] },
          task: { status: { in: [...ACTIVE_PARENT_TASK_STATUSES] } },
        },
        include: { task: { select: { priority: true } } },
        orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }],
      })
      return records.map((record) => ({
        id: record.id, userId: record.userId,
        workflowVersionId: record.workflowVersionId,
        status: record.status as ComfySchedulableRequest['status'],
        queuedAt: record.queuedAt, priority: record.task.priority,
      }))
    },
    listOwnedEnabledConnections: (userId) => prisma.comfyConnection.findMany({
      where: { userId, enabled: true },
      select: { id: true, userId: true, enabled: true, lastAssignedAt: true },
    }),
    readCachedHealth: async (connectionId) => {
      const value = await redis.get(comfyHealthKey(connectionId))
      if (!value) return null
      try {
        const parsed = JSON.parse(value) as unknown
        if (!isRecord(parsed) || !isHealthState(parsed.state)) return null
        return {
          state: parsed.state,
          ...(typeof parsed.capabilityFingerprint === 'string'
            ? { capabilityFingerprint: parsed.capabilityFingerprint } : {}),
        }
      } catch {
        return null
      }
    },
    checkCachedCompatibility,
    acquireLease: (owner) => acquireComfyRequestLease(owner),
    releaseLease: (owner) => releaseComfyRequestLease(owner),
    makeWaitingIfBlocked: async (requestId, userId, status) => {
      if (status === 'waiting_capacity') return true
      const result = await prisma.comfyGenerationRequest.updateMany({
        where: { id: requestId, userId, status: 'blocked_no_compatible_instance' },
        data: { status: 'waiting_capacity' },
      })
      return result.count === 1
    },
    assignIfEligible: (input) => assignComfyRequestWithStore(input, {
      transaction: (operation) => prisma.$transaction((tx) => operation({
        updateConnection: (data) => tx.comfyConnection.updateMany(data),
        updateRequest: (data) => tx.comfyGenerationRequest.updateMany(data),
        countActiveRequests: (data) => tx.comfyGenerationRequest.count(data),
      }), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
    }),
    markBlockedIfEligible: async (requestId, userId) => {
      const result = await prisma.comfyGenerationRequest.updateMany({
        where: { id: requestId, userId, status: 'waiting_capacity' },
        data: { status: 'blocked_no_compatible_instance' },
      })
      return result.count === 1
    },
    failIncompatibleIfEligible: async (requestId, userId) => {
      const result = await prisma.comfyGenerationRequest.updateMany({
        where: {
          id: requestId,
          userId,
          status: { in: [...SCHEDULABLE_STATUSES] },
          task: { status: { in: [...ACTIVE_PARENT_TASK_STATUSES] } },
        },
        data: {
          status: 'failed',
          failedAt: new Date(),
          connectionId: null,
          leaseId: null,
          leaseExpiresAt: null,
          errorCode: COMFY_ERROR_CODE.NO_COMPATIBLE_INSTANCE,
          errorMessage: 'No online ComfyUI instance is compatible with this workflow',
        },
      })
      return result.count === 1
    },
  }
}

const CONNECTION_BUSY = Symbol('COMFY_CONNECTION_BUSY')
const REQUEST_LOST = Symbol('COMFY_REQUEST_LOST')

export async function assignComfyRequestWithStore(
  input: ComfyAssignmentInput,
  store: ComfyAssignmentStore,
) {
  try {
    return await store.transaction(async (client) => {
      const activeRequests = await client.countActiveRequests({
        where: {
          connectionId: input.connectionId,
          id: { not: input.requestId },
          status: { in: [...COMFY_ACTIVE_REQUEST_STATUSES] },
          task: { status: { in: [...ACTIVE_PARENT_TASK_STATUSES] } },
        },
      })
      if (activeRequests > 0) throw CONNECTION_BUSY
      const connection = await client.updateConnection({
        where: { id: input.connectionId, userId: input.userId, enabled: true },
        data: { lastAssignedAt: input.assignedAt },
      })
      if (connection.count !== 1) throw CONNECTION_BUSY
      const request = await client.updateRequest({
        where: {
          id: input.requestId, userId: input.userId,
          status: { in: [...SCHEDULABLE_STATUSES] },
          connectionId: null, leaseId: null,
          task: { status: { in: [...ACTIVE_PARENT_TASK_STATUSES] } },
        },
        data: {
          status: 'leased', connectionId: input.connectionId, leaseId: input.leaseId,
          leaseExpiresAt: input.leaseExpiresAt, leasedAt: input.assignedAt,
        },
      })
      if (request.count !== 1) throw REQUEST_LOST
      return 'assigned' as const
    })
  } catch (error) {
    if (error === CONNECTION_BUSY) return 'connection_busy'
    if (error === REQUEST_LOST) return 'request_lost'
    throw error
  }
}

async function bestEffortRelease(
  dependencies: Pick<ComfySchedulerDependencies, 'releaseLease'>,
  owner: ComfyRequestLeaseOwner,
) {
  try {
    await dependencies.releaseLease(owner)
  } catch {
    // The lease has a bounded TTL; a release transport error is not a new assignment result.
  }
}

function compareRequests(left: ComfySchedulableRequest, right: ComfySchedulableRequest) {
  return right.priority - left.priority
    || left.queuedAt.getTime() - right.queuedAt.getTime()
    || left.id.localeCompare(right.id)
}

function compareConnections(left: ComfySchedulableConnection, right: ComfySchedulableConnection) {
  if (left.lastAssignedAt === null && right.lastAssignedAt !== null) return -1
  if (left.lastAssignedAt !== null && right.lastAssignedAt === null) return 1
  return (left.lastAssignedAt?.getTime() ?? 0) - (right.lastAssignedAt?.getTime() ?? 0)
    || left.id.localeCompare(right.id)
}

function isHealthState(value: unknown): value is ComfyHealthState {
  return ['online_idle', 'online_busy_owned', 'online_busy_external', 'offline',
    'auth_failed', 'workflow_incompatible'].includes(String(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
