import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'

import { prisma } from '@/lib/prisma'

import {
  comfyLeaseKey,
  releaseComfyLease,
  renewComfyLease,
  tryAcquireComfyLease,
  type ComfyLeaseStore,
} from './test-lease'
import { COMFY_ACTIVE_REQUEST_STATUSES } from './types'

export type ComfyLeaseRedis = ComfyLeaseStore

export interface ComfyRequestLeaseOwner {
  connectionId: string
  requestId: string
  leaseId: string
  ttlMs: number
}

export interface ComfyDurableLeaseStore {
  updateMany(input: Prisma.ComfyGenerationRequestUpdateManyArgs): Promise<{ count: number }>
}

const defaultDurableLeaseStore: ComfyDurableLeaseStore = {
  updateMany: (input) => prisma.comfyGenerationRequest.updateMany(input),
}

export function newComfyLeaseId() {
  return randomUUID()
}

export async function acquireComfyRequestLease(
  owner: ComfyRequestLeaseOwner,
  store?: ComfyLeaseRedis,
) {
  const result = await tryAcquireComfyLease(
    owner.connectionId,
    comfyRequestLeaseValue(owner),
    owner.ttlMs,
    store,
  )
  return result.acquired
}

export async function heartbeatComfyRequestLease(
  owner: ComfyRequestLeaseOwner,
  store?: ComfyLeaseRedis,
) {
  try {
    await renewComfyLease(
      comfyLeaseKey(owner.connectionId),
      comfyRequestLeaseValue(owner),
      owner.ttlMs,
      store,
    )
    return true
  } catch {
    return false
  }
}

export async function heartbeatDurableComfyRequestLease(
  owner: ComfyRequestLeaseOwner,
  durableStore: ComfyDurableLeaseStore = defaultDurableLeaseStore,
  redisStore?: ComfyLeaseRedis,
  now = new Date(),
) {
  if (!await heartbeatComfyRequestLease(owner, redisStore)) {
    return { owned: false as const, reason: 'redis_lost' as const }
  }
  const leaseExpiresAt = new Date(now.getTime() + owner.ttlMs)
  try {
    const result = await durableStore.updateMany({
      where: {
        id: owner.requestId,
        connectionId: owner.connectionId,
        leaseId: owner.leaseId,
        status: { in: [...COMFY_ACTIVE_REQUEST_STATUSES] },
      },
      data: { leaseExpiresAt },
    })
    if (result.count === 1) return { owned: true as const, leaseExpiresAt }
  } catch (error) {
    await releaseComfyRequestLease(owner, redisStore).catch(() => false)
    throw error
  }
  await releaseComfyRequestLease(owner, redisStore).catch(() => false)
  return { owned: false as const, reason: 'db_lost' as const }
}

export async function releaseComfyRequestLease(
  owner: ComfyRequestLeaseOwner,
  store?: ComfyLeaseRedis,
) {
  const result = await releaseComfyLease(
    comfyLeaseKey(owner.connectionId),
    comfyRequestLeaseValue(owner),
    store,
  )
  return result === 1
}

export function comfyRequestLeaseValue(
  owner: Pick<ComfyRequestLeaseOwner, 'requestId' | 'leaseId'>,
) {
  return JSON.stringify({ type: 'request', requestId: owner.requestId, leaseId: owner.leaseId })
}
