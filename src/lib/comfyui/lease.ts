import { randomUUID } from 'node:crypto'

import {
  comfyLeaseKey,
  releaseComfyLease,
  renewComfyLease,
  tryAcquireComfyLease,
  type ComfyLeaseStore,
} from './test-lease'

export type ComfyLeaseRedis = ComfyLeaseStore

export interface ComfyRequestLeaseOwner {
  connectionId: string
  requestId: string
  leaseId: string
  ttlMs: number
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
