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
  now: Date | (() => Date) = () => new Date(),
) {
  if (!await heartbeatComfyRequestLease(owner, redisStore)) {
    return { owned: false as const, reason: 'redis_lost' as const }
  }
  const clock = typeof now === 'function' ? now : () => now
  const conservativeExpiry = clock()
  try {
    const result = await durableStore.updateMany({
      where: {
        id: owner.requestId,
        connectionId: owner.connectionId,
        leaseId: owner.leaseId,
        status: { in: [...COMFY_ACTIVE_REQUEST_STATUSES] },
      },
      data: { leaseExpiresAt: conservativeExpiry },
    })
    if (result.count !== 1) {
      await releaseComfyRequestLease(owner, redisStore).catch(() => false)
      return { owned: false as const, reason: 'db_lost' as const }
    }
  } catch (error) {
    await releaseComfyRequestLease(owner, redisStore).catch(() => false)
    throw error
  }
  if (!await heartbeatComfyRequestLease(owner, redisStore)) {
    await expireDurableLease(owner, durableStore, clock())
    return { owned: false as const, reason: 'redis_lost' as const }
  }
  const completedAt = clock()
  const leaseExpiresAt = new Date(completedAt.getTime() + owner.ttlMs)
  let finalized: { count: number }
  try {
    finalized = await durableStore.updateMany({
      where: {
        id: owner.requestId,
        connectionId: owner.connectionId,
        leaseId: owner.leaseId,
        status: { in: [...COMFY_ACTIVE_REQUEST_STATUSES] },
      },
      data: { leaseExpiresAt },
    })
  } catch (error) {
    await releaseComfyRequestLease(owner, redisStore).catch(() => false)
    throw error
  }
  if (finalized.count !== 1) {
    await releaseComfyRequestLease(owner, redisStore).catch(() => false)
    return { owned: false as const, reason: 'db_lost' as const }
  }
  if (!await heartbeatComfyRequestLease(owner, redisStore)) {
    await expireDurableLease(owner, durableStore, clock())
    return { owned: false as const, reason: 'redis_lost' as const }
  }
  return { owned: true as const, leaseExpiresAt }
}

async function expireDurableLease(
  owner: ComfyRequestLeaseOwner,
  durableStore: ComfyDurableLeaseStore,
  expiredAt: Date,
) {
  await durableStore.updateMany({
    where: {
      id: owner.requestId,
      connectionId: owner.connectionId,
      leaseId: owner.leaseId,
      status: { in: [...COMFY_ACTIVE_REQUEST_STATUSES] },
    },
    data: { leaseExpiresAt: expiredAt },
  }).catch(() => ({ count: 0 }))
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
