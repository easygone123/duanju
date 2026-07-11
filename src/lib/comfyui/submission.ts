import { Prisma } from '@prisma/client'

import { ApiError } from '@/lib/api-errors'
import { prisma } from '@/lib/prisma'

import { acquireComfyRequestLease, releaseComfyRequestLease } from './lease'

export interface ComfyOwnerInput {
  requestId: string
  userId: string
  connectionId: string
  leaseId: string
}

export type ComfySubmissionFenceResult =
  | { outcome: 'claimed'; attemptId: string; clientId: string }
  | { outcome: 'canceled' | 'lost' }

export type ComfyAcceptedPromptResult =
  | { outcome: 'request_recorded' }
  | { outcome: 'attempt_recorded' }

interface SubmissionFenceOperations {
  fenceRequest(input: Record<string, unknown>): Promise<{ count: number }>
  createAttempt(data: Record<string, unknown>): Promise<unknown>
  findRequest(requestId: string, userId: string): Promise<Record<string, unknown> | null>
}

interface SubmissionFenceStore {
  transaction<T>(operation: (client: SubmissionFenceOperations) => Promise<T>): Promise<T>
}

const defaultSubmissionFenceStore: SubmissionFenceStore = {
  transaction: (operation) => prisma.$transaction((tx) => operation({
    fenceRequest: (input) => tx.comfyGenerationRequest.updateMany(
      input as Prisma.ComfyGenerationRequestUpdateManyArgs,
    ),
    createAttempt: (data) => tx.comfySubmissionAttempt.create({
      data: data as Prisma.ComfySubmissionAttemptUncheckedCreateInput,
    }),
    findRequest: (requestId, userId) => tx.comfyGenerationRequest.findFirst({
      where: { id: requestId, userId },
    }),
  }), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
}

export async function claimComfySubmissionFenceWithStore(
  input: ComfyOwnerInput & { attemptId: string; clientId: string },
  store: SubmissionFenceStore = defaultSubmissionFenceStore,
): Promise<ComfySubmissionFenceResult> {
  return store.transaction(async (client) => {
    const fenced = await client.fenceRequest({
      where: {
        id: input.requestId, userId: input.userId, connectionId: input.connectionId,
        leaseId: input.leaseId, status: 'uploading', promptId: null,
        cancelRequestedAt: null,
      },
      data: { status: 'submitting', clientId: input.clientId, submittingAt: new Date() },
    })
    if (fenced.count !== 1) {
      const current = await client.findRequest(input.requestId, input.userId)
      return current?.status === 'canceled' || current?.cancelRequestedAt
        ? { outcome: 'canceled' }
        : { outcome: 'lost' }
    }
    await client.createAttempt({
      id: input.attemptId, requestId: input.requestId, userId: input.userId,
      connectionId: input.connectionId, leaseId: input.leaseId,
      clientId: input.clientId, status: 'fenced',
    })
    return { outcome: 'claimed', attemptId: input.attemptId, clientId: input.clientId }
  })
}

interface AcceptedPromptOperations {
  updateAttempt(input: Record<string, unknown>): Promise<{ count: number }>
  updateRequest(input: Record<string, unknown>): Promise<{ count: number }>
  findAttempt(attemptId: string): Promise<Record<string, unknown> | null>
}

interface AcceptedPromptStore {
  transaction<T>(operation: (client: AcceptedPromptOperations) => Promise<T>): Promise<T>
}

const defaultAcceptedPromptStore: AcceptedPromptStore = {
  transaction: (operation) => prisma.$transaction((tx) => operation({
    updateAttempt: (input) => tx.comfySubmissionAttempt.updateMany(
      input as Prisma.ComfySubmissionAttemptUpdateManyArgs,
    ),
    updateRequest: (input) => tx.comfyGenerationRequest.updateMany(
      input as Prisma.ComfyGenerationRequestUpdateManyArgs,
    ),
    findAttempt: (attemptId) => tx.comfySubmissionAttempt.findUnique({ where: { id: attemptId } }),
  }), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
}

export async function recordComfyAcceptedPromptWithStore(
  input: ComfyOwnerInput & { attemptId: string; clientId: string; promptId: string },
  store: AcceptedPromptStore = defaultAcceptedPromptStore,
): Promise<ComfyAcceptedPromptResult> {
  return store.transaction(async (client) => {
    const acceptedAt = new Date()
    const attempt = await client.updateAttempt({
      where: {
        id: input.attemptId, requestId: input.requestId, userId: input.userId,
        connectionId: input.connectionId, clientId: input.clientId,
        promptId: null, status: 'fenced',
      },
      data: { promptId: input.promptId, status: 'accepted', acceptedAt },
    })
    if (attempt.count !== 1) {
      const existing = await client.findAttempt(input.attemptId)
      if (existing?.promptId !== input.promptId || existing.clientId !== input.clientId) {
        throw new ApiError('CONFLICT')
      }
    }
    const request = await client.updateRequest({
      where: {
        id: input.requestId, userId: input.userId, connectionId: input.connectionId,
        leaseId: input.leaseId, clientId: input.clientId,
        status: 'submitting', promptId: null,
      },
      data: { status: 'submitted', promptId: input.promptId, submittedAt: acceptedAt },
    })
    return request.count === 1
      ? { outcome: 'request_recorded' }
      : { outcome: 'attempt_recorded' }
  })
}

export interface ReclaimComfyRecoveryLeaseInput {
  requestId: string
  userId: string
  connectionId: string
  previousLeaseId: string
  newLeaseId: string
  ttlMs: number
  leaseExpiredAt: Date
  now: Date
  hasSubmissionAttempt: boolean
}

export interface ReclaimComfyRecoveryLeaseDependencies {
  acquireLease(owner: ComfyOwnerInput & { ttlMs: number }): Promise<boolean>
  claimExpiredRequest(input: ReclaimComfyRecoveryLeaseInput & { leaseExpiresAt: Date }): Promise<boolean>
  releaseLease(owner: ComfyOwnerInput & { ttlMs: number }): Promise<boolean>
}

interface RecoveryClaimStore {
  transaction<T>(operation: (client: {
    countCompeting(connectionId: string, requestId: string): Promise<number>
    claimRequest(input: Record<string, unknown>): Promise<{ count: number }>
  }) => Promise<T>): Promise<T>
}

const defaultRecoveryClaimStore: RecoveryClaimStore = {
  transaction: (operation) => prisma.$transaction((tx) => operation({
    countCompeting: (connectionId, requestId) => tx.comfyGenerationRequest.count({
      where: {
        connectionId, id: { not: requestId },
        status: { in: ['leased', 'uploading', 'submitting', 'submitted', 'running', 'transferring', 'reconciling'] },
      },
    }),
    claimRequest: (input) => tx.comfyGenerationRequest.updateMany(
      input as Prisma.ComfyGenerationRequestUpdateManyArgs,
    ),
  }), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
}

export async function claimExpiredComfyRequestWithStore(
  input: ReclaimComfyRecoveryLeaseInput & { leaseExpiresAt: Date },
  store: RecoveryClaimStore = defaultRecoveryClaimStore,
) {
  return store.transaction(async (client) => {
    if (await client.countCompeting(input.connectionId, input.requestId) > 0) return false
    const result = await client.claimRequest({
      where: {
        id: input.requestId, userId: input.userId, connectionId: input.connectionId,
        leaseId: input.previousLeaseId, leaseExpiresAt: { lte: input.now },
        status: { in: ['submitting', 'submitted', 'running', 'transferring', 'reconciling'] },
        submissionAttempts: { some: {} },
      },
      data: {
        leaseId: input.newLeaseId, leaseExpiresAt: input.leaseExpiresAt,
        status: 'reconciling', reconcilingAt: input.now,
      },
    })
    return result.count === 1
  })
}

export async function reclaimComfyRecoveryLease(
  input: ReclaimComfyRecoveryLeaseInput,
  dependencies: ReclaimComfyRecoveryLeaseDependencies = {
    acquireLease: (owner) => acquireComfyRequestLease(owner),
    claimExpiredRequest: (claim) => claimExpiredComfyRequestWithStore(claim),
    releaseLease: (owner) => releaseComfyRequestLease(owner),
  },
) {
  if (!input.hasSubmissionAttempt || input.leaseExpiredAt.getTime() > input.now.getTime()) {
    return { outcome: 'not_recoverable' as const }
  }
  const owner = {
    requestId: input.requestId, userId: input.userId, connectionId: input.connectionId,
    leaseId: input.newLeaseId, ttlMs: input.ttlMs,
  }
  if (!await dependencies.acquireLease(owner)) return { outcome: 'contended' as const }
  const claimed = await dependencies.claimExpiredRequest({
    ...input, leaseExpiresAt: new Date(input.now.getTime() + input.ttlMs),
  })
  if (!claimed) {
    await dependencies.releaseLease(owner).catch(() => false)
    return { outcome: 'lost' as const }
  }
  return { outcome: 'reclaimed' as const, leaseId: input.newLeaseId }
}
