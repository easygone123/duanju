import { Prisma } from '@prisma/client'

import { prisma } from '@/lib/prisma'
import { redis } from '@/lib/redis'

import { releaseComfyRequestLease } from './lease'
import { comfyLeaseKey } from './test-lease'
import { COMFY_ACTIVE_REQUEST_STATUSES } from './types'

const PRE_SUBMIT_STATUSES = ['leased', 'uploading', 'submitting'] as const

export interface ExpiredPreSubmitCandidate {
  id: string
  userId: string
  connectionId: string
  leaseId: string
  leaseExpiresAt: Date
  status: (typeof PRE_SUBMIT_STATUSES)[number]
}

export interface ComfyPreSubmitRecoveryScanDependencies {
  listExpiredCandidates(input: { now: Date; limit: number }): Promise<ExpiredPreSubmitCandidate[]>
  readLeaseValue(connectionId: string): Promise<string | null>
  recoverCandidate(candidate: ExpiredPreSubmitCandidate, now: Date): Promise<boolean>
  releaseLease(candidate: ExpiredPreSubmitCandidate): Promise<boolean>
}

interface PreSubmitRecoveryStore {
  transaction<T>(operation: (client: {
    countCompeting(connectionId: string, requestId: string): Promise<number>
    updateRequest(input: Record<string, unknown>): Promise<{ count: number }>
  }) => Promise<T>): Promise<T>
}

const defaultRecoveryStore: PreSubmitRecoveryStore = {
  transaction: (operation) => prisma.$transaction((tx) => operation({
    countCompeting: (connectionId, requestId) => tx.comfyGenerationRequest.count({
      where: {
        connectionId, id: { not: requestId },
        status: { in: [...COMFY_ACTIVE_REQUEST_STATUSES] },
      },
    }),
    updateRequest: (input) => tx.comfyGenerationRequest.updateMany(
      input as Prisma.ComfyGenerationRequestUpdateManyArgs,
    ),
  }), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
}

export async function recoverExpiredPreSubmitCandidateWithStore(
  candidate: ExpiredPreSubmitCandidate,
  now: Date,
  store: PreSubmitRecoveryStore = defaultRecoveryStore,
) {
  if (candidate.leaseExpiresAt.getTime() > now.getTime()) return false
  return store.transaction(async (client) => {
    if (await client.countCompeting(candidate.connectionId, candidate.id) > 0) return false
    const result = await client.updateRequest({
      where: {
        id: candidate.id, userId: candidate.userId, connectionId: candidate.connectionId,
        leaseId: candidate.leaseId, leaseExpiresAt: { lte: candidate.leaseExpiresAt },
        status: candidate.status, promptId: null, submissionAttempts: { none: {} },
      },
      data: {
        status: 'waiting_capacity', connectionId: null, leaseId: null, leaseExpiresAt: null,
      },
    })
    return result.count === 1
  })
}

export async function scanExpiredPreSubmitComfyRequests(
  options: { now?: Date; limit?: number } = {},
  dependencies: ComfyPreSubmitRecoveryScanDependencies = defaultScanDependencies,
) {
  const now = options.now ?? new Date()
  const limit = options.limit ?? 100
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000
    || !Number.isFinite(now.getTime())) throw new Error('Invalid ComfyUI recovery scan options')
  const candidates = await dependencies.listExpiredCandidates({ now, limit })
  const result = { scanned: candidates.length, recovered: 0, contended: 0, lost: 0 }
  for (const candidate of candidates) {
    let redisOwner: string | null
    try {
      redisOwner = await dependencies.readLeaseValue(candidate.connectionId)
    } catch {
      result.contended += 1
      continue
    }
    if (redisOwner !== null) {
      result.contended += 1
      continue
    }
    if (!await dependencies.recoverCandidate(candidate, now)) {
      result.lost += 1
      continue
    }
    result.recovered += 1
    await dependencies.releaseLease(candidate).catch(() => false)
  }
  return result
}

const defaultScanDependencies: ComfyPreSubmitRecoveryScanDependencies = {
  listExpiredCandidates: async ({ now, limit }) => {
    const records = await prisma.comfyGenerationRequest.findMany({
      where: {
        status: { in: [...PRE_SUBMIT_STATUSES] }, leaseExpiresAt: { lte: now },
        connectionId: { not: null }, leaseId: { not: null }, promptId: null,
        submissionAttempts: { none: {} },
      },
      orderBy: [{ leaseExpiresAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true, userId: true, connectionId: true, leaseId: true,
        leaseExpiresAt: true, status: true,
      },
    })
    return records.filter((record): record is typeof record & {
      connectionId: string; leaseId: string; leaseExpiresAt: Date
      status: ExpiredPreSubmitCandidate['status']
    } => !!record.connectionId && !!record.leaseId && !!record.leaseExpiresAt
      && PRE_SUBMIT_STATUSES.includes(record.status as ExpiredPreSubmitCandidate['status']))
  },
  readLeaseValue: (connectionId) => redis.get(comfyLeaseKey(connectionId)),
  recoverCandidate: (candidate, now) => recoverExpiredPreSubmitCandidateWithStore(candidate, now),
  releaseLease: (candidate) => releaseComfyRequestLease({
    connectionId: candidate.connectionId, requestId: candidate.id,
    leaseId: candidate.leaseId, ttlMs: 1,
  }),
}
