import { Prisma } from '@prisma/client'

import { ApiError } from '@/lib/api-errors'
import { prisma } from '@/lib/prisma'

import { acquireComfyRequestLease, releaseComfyRequestLease } from './lease'
import { COMFY_ERROR_CODE } from './errors'
import type { ComfyOutputRef, ComfyStoredOutputRef } from './types'

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

export interface ComfyAttemptAbsencePolicy {
  minChecks: number
  minAgeMs: number
  deadlineMs: number
}

interface AttemptAbsenceStore {
  transaction<T>(operation: (client: {
    findAttempt(input: Record<string, unknown>): Promise<Record<string, unknown> | null>
    recordCheck(input: Record<string, unknown>): Promise<{ count: number }>
    finishRequest(input: Record<string, unknown>): Promise<{ count: number }>
  }) => Promise<T>): Promise<T>
}

const defaultAttemptAbsenceStore: AttemptAbsenceStore = {
  transaction: (operation) => prisma.$transaction((tx) => operation({
    findAttempt: (input) => tx.comfySubmissionAttempt.findFirst(
      input as Prisma.ComfySubmissionAttemptFindFirstArgs,
    ) as Promise<Record<string, unknown> | null>,
    recordCheck: (input) => tx.comfySubmissionAttempt.updateMany(
      input as Prisma.ComfySubmissionAttemptUpdateManyArgs,
    ),
    finishRequest: (input) => tx.comfyGenerationRequest.updateMany(
      input as Prisma.ComfyGenerationRequestUpdateManyArgs,
    ),
  }), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
}

export async function recordComfyAttemptAbsenceWithStore(
  input: ComfyOwnerInput & {
    attemptId: string
    clientId: string
    now: Date
    policy: ComfyAttemptAbsencePolicy
  },
  store: AttemptAbsenceStore = defaultAttemptAbsenceStore,
) {
  validateAbsencePolicy(input.policy)
  return store.transaction(async (client) => {
    const attempt = await client.findAttempt({
      where: {
        id: input.attemptId, requestId: input.requestId, userId: input.userId,
        connectionId: input.connectionId, clientId: input.clientId,
        promptId: null, status: { in: ['fenced', 'checking_absence'] },
      },
      include: { request: { select: { leaseId: true, status: true, cancelRequestedAt: true } } },
    })
    if (!attempt || !isRecord(attempt.request)
      || attempt.request.leaseId !== input.leaseId) throw new ApiError('CONFLICT')
    const createdAt = asDate(attempt.createdAt)
    const firstCheckedAt = attempt.firstCheckedAt == null
      ? input.now
      : asDate(attempt.firstCheckedAt)
    const previousCount = nonnegativeInteger(attempt.checkCount)
    const checkCount = previousCount + 1
    const deadlineAt = attempt.reconcileDeadlineAt == null
      ? new Date(createdAt.getTime() + input.policy.deadlineMs)
      : asDate(attempt.reconcileDeadlineAt)
    const oldEnough = input.now.getTime() - createdAt.getTime() >= input.policy.minAgeMs
    const deadlineReached = input.now.getTime() >= deadlineAt.getTime()
    const conclusive = (checkCount >= input.policy.minChecks && oldEnough) || deadlineReached
    const terminal = attempt.request.cancelRequestedAt ? 'canceled' as const : 'failed' as const
    const recorded = await client.recordCheck({
      where: {
        id: input.attemptId, checkCount: previousCount, promptId: null,
        status: { in: ['fenced', 'checking_absence'] },
      },
      data: {
        firstCheckedAt, lastCheckedAt: input.now, checkCount, reconcileDeadlineAt: deadlineAt,
        status: conclusive ? 'not_accepted' : 'checking_absence',
      },
    })
    if (recorded.count !== 1) throw new ApiError('CONFLICT')
    if (!conclusive) return { outcome: 'reconciling' as const, checkCount }
    const finished = await client.finishRequest({
      where: {
        id: input.requestId, userId: input.userId, connectionId: input.connectionId,
        leaseId: input.leaseId, promptId: null,
        status: { in: ['submitting', 'reconciling'] },
      },
      data: terminal === 'canceled'
        ? { status: 'canceled', canceledAt: input.now }
        : {
            status: 'failed', failedAt: input.now,
            errorCode: COMFY_ERROR_CODE.RECONCILIATION_REQUIRED,
            errorMessage: 'ComfyUI submission was not accepted',
          },
    })
    if (finished.count !== 1) throw new ApiError('CONFLICT')
    return { outcome: terminal, checkCount }
  })
}

function validateAbsencePolicy(policy: ComfyAttemptAbsencePolicy) {
  if (!Number.isInteger(policy.minChecks) || policy.minChecks < 2 || policy.minChecks > 1_000
    || !Number.isInteger(policy.minAgeMs) || policy.minAgeMs < 1_000
    || !Number.isInteger(policy.deadlineMs) || policy.deadlineMs < policy.minAgeMs
    || policy.deadlineMs > 30 * 24 * 60 * 60 * 1_000) throw new ApiError('INVALID_PARAMS')
}

function asDate(value: unknown) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new ApiError('CONFLICT')
  return value
}

function nonnegativeInteger(value: unknown) {
  if (!Number.isInteger(value) || (value as number) < 0) throw new ApiError('CONFLICT')
  return value as number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface OutputReceiptStore {
  transaction<T>(operation: (client: {
    findRequest(input: Record<string, unknown>): Promise<Record<string, unknown> | null>
    updateRequest(input: Record<string, unknown>): Promise<{ count: number }>
  }) => Promise<T>): Promise<T>
}

const defaultOutputReceiptStore: OutputReceiptStore = {
  transaction: (operation) => prisma.$transaction((tx) => operation({
    findRequest: (input) => tx.comfyGenerationRequest.findFirst(
      input as Prisma.ComfyGenerationRequestFindFirstArgs,
    ) as Promise<Record<string, unknown> | null>,
    updateRequest: (input) => tx.comfyGenerationRequest.updateMany(
      input as Prisma.ComfyGenerationRequestUpdateManyArgs,
    ),
  }), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
}

export async function persistComfyOutputReceiptWithStore(
  input: ComfyOwnerInput & { promptId: string; output: ComfyStoredOutputRef },
  store: OutputReceiptStore = defaultOutputReceiptStore,
) {
  if (!isOutputRef(input.output) || !isStoredOutput(input.output)) throw new ApiError('CONFLICT')
  return store.transaction(async (client) => {
    const request = await client.findRequest({
      where: {
        id: input.requestId, userId: input.userId, connectionId: input.connectionId,
        leaseId: input.leaseId, promptId: input.promptId,
        status: { in: ['transferring', 'reconciling'] },
      },
      select: { outputRefs: true },
    })
    if (!request || !Array.isArray(request.outputRefs) || request.outputRefs.length > 64) {
      throw new ApiError('CONFLICT')
    }
    const refs = request.outputRefs.filter(isOutputRef).slice(0, 64)
    const existingIndex = refs.findIndex((ref) => sameOutputIdentity(ref, input.output))
    if (existingIndex >= 0 && isStoredOutput(refs[existingIndex])
      && refs[existingIndex].storageKey === input.output.storageKey) return true
    if (existingIndex >= 0) refs[existingIndex] = input.output
    else if (refs.length < 64) refs.push(input.output)
    else throw new ApiError('CONFLICT')
    const updated = await client.updateRequest({
      where: {
        id: input.requestId, userId: input.userId, connectionId: input.connectionId,
        leaseId: input.leaseId, promptId: input.promptId,
        status: { in: ['transferring', 'reconciling'] },
      },
      data: { outputRefs: refs },
    })
    return updated.count === 1
  })
}

function isOutputRef(value: unknown): value is ComfyOutputRef | ComfyStoredOutputRef {
  return isRecord(value) && typeof value.name === 'string' && typeof value.nodeId === 'string'
    && (value.mediaType === 'image' || value.mediaType === 'video')
    && typeof value.primary === 'boolean' && typeof value.filename === 'string'
    && typeof value.subfolder === 'string' && typeof value.type === 'string'
}

function isStoredOutput(value: ComfyOutputRef | ComfyStoredOutputRef): value is ComfyStoredOutputRef {
  return 'storageKey' in value && typeof value.storageKey === 'string'
    && 'url' in value && typeof value.url === 'string'
    && 'byteSize' in value && Number.isSafeInteger(value.byteSize) && value.byteSize > 0
}

function sameOutputIdentity(left: ComfyOutputRef, right: ComfyOutputRef) {
  return left.name === right.name && left.nodeId === right.nodeId
    && left.filename === right.filename && left.subfolder === right.subfolder && left.type === right.type
}
