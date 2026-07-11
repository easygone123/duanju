import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectionFindMany: vi.fn(),
  connectionGroupBy: vi.fn(),
  requestFindMany: vi.fn(),
  requestGroupBy: vi.fn(),
  requestUpdateMany: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisEval: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    comfyConnection: {
      findMany: mocks.connectionFindMany,
      groupBy: mocks.connectionGroupBy,
    },
    comfyGenerationRequest: {
      findMany: mocks.requestFindMany,
      groupBy: mocks.requestGroupBy,
      updateMany: mocks.requestUpdateMany,
    },
  },
}))

vi.mock('@/lib/redis', () => ({
  redis: { get: mocks.redisGet, set: mocks.redisSet, eval: mocks.redisEval },
}))

import {
  listProductionComfyDispatchOwners,
  listProductionComfyHealthOwners,
  listProductionComfyReconcileRequests,
  reconcileProductionComfyRequest,
  returnProductionBackedOffLease,
} from '@/lib/comfyui/runtime-production'

describe('production ComfyUI runtime keyset pages', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })
  afterEach(() => vi.useRealTimers())

  it('pages health by distinct owner key even when owner A has 10,000 enabled connections', async () => {
    const rows = [
      ...Array.from({ length: 10_000 }, () => ({ userId: 'owner-a' })),
      { userId: 'owner-b' },
    ]
    mocks.connectionGroupBy.mockImplementation(async (input: {
      where: { userId?: { gt: string } }; take: number
    }) => groupedOwners(rows, input.where.userId?.gt, input.take))

    await expect(listProductionComfyHealthOwners({ afterUserId: null, limit: 1 }))
      .resolves.toEqual({ items: [{ userId: 'owner-a' }], nextCursor: 'owner-a' })
    await expect(listProductionComfyHealthOwners({ afterUserId: 'owner-a', limit: 1 }))
      .resolves.toEqual({ items: [{ userId: 'owner-b' }], nextCursor: null })

    expect(mocks.connectionGroupBy).toHaveBeenNthCalledWith(1, {
      by: ['userId'], where: { enabled: true }, orderBy: { userId: 'asc' }, take: 2,
    })
    expect(mocks.connectionGroupBy).toHaveBeenNthCalledWith(2, {
      by: ['userId'], where: { enabled: true, userId: { gt: 'owner-a' } },
      orderBy: { userId: 'asc' }, take: 2,
    })
    expect(mocks.connectionFindMany).not.toHaveBeenCalled()
  })

  it('pages dispatch by distinct owner key even when owner A has 10,000 waiting requests', async () => {
    const rows = [
      ...Array.from({ length: 10_000 }, () => ({ userId: 'owner-a' })),
      { userId: 'owner-b' },
    ]
    mocks.requestGroupBy.mockImplementation(async (input: {
      where: { userId?: { gt: string } }; take: number
    }) => groupedOwners(rows, input.where.userId?.gt, input.take))

    await expect(listProductionComfyDispatchOwners({ afterUserId: null, limit: 1 }))
      .resolves.toEqual({ items: [{ userId: 'owner-a' }], nextCursor: 'owner-a' })
    await expect(listProductionComfyDispatchOwners({ afterUserId: 'owner-a', limit: 1 }))
      .resolves.toEqual({ items: [{ userId: 'owner-b' }], nextCursor: null })

    expect(mocks.requestGroupBy).toHaveBeenNthCalledWith(1, {
      by: ['userId'],
      where: { status: { in: ['waiting_capacity', 'blocked_no_compatible_instance'] } },
      orderBy: { userId: 'asc' }, take: 2,
    })
    expect(mocks.requestGroupBy).toHaveBeenNthCalledWith(2, {
      by: ['userId'],
      where: {
        status: { in: ['waiting_capacity', 'blocked_no_compatible_instance'] },
        userId: { gt: 'owner-a' },
      },
      orderBy: { userId: 'asc' }, take: 2,
    })
    expect(mocks.requestFindMany).not.toHaveBeenCalled()
    expect(mocks.connectionFindMany).not.toHaveBeenCalled()
  })

  it('filters each bounded reconcile page through Redis and still advances past live or failed entries', async () => {
    const now = new Date('2026-07-11T00:00:00.000Z')
    const records = Array.from({ length: 101 }, (_, index) => ({
      id: `request-${String(index + 1).padStart(3, '0')}`,
      mediaType: 'image',
      connectionId: `connection-${index + 1}`,
    }))
    mocks.requestFindMany.mockResolvedValueOnce(records).mockResolvedValueOnce([
      { id: 'request-101', mediaType: 'video', connectionId: 'connection-101' },
    ])
    mocks.redisGet
      .mockRejectedValueOnce(new Error('redis transient failure'))
      .mockResolvedValueOnce('live-owner')
      .mockResolvedValue(null)

    await expect(listProductionComfyReconcileRequests({
      afterId: 'deleted-request-000', limit: 100, now,
    })).resolves.toEqual({
      items: Array.from({ length: 98 }, (_, index) => ({
        requestId: `request-${String(index + 3).padStart(3, '0')}`,
        mediaType: 'image',
      })),
      nextCursor: 'request-100',
    })
    expect(mocks.requestFindMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: { gt: 'deleted-request-000' },
        status: { in: ['submitting', 'submitted', 'running', 'transferring', 'reconciling'] },
        leaseExpiresAt: { lte: now },
        connectionId: { not: null },
        leaseId: { not: null },
      },
      orderBy: { id: 'asc' },
      take: 101,
      select: { id: true, mediaType: true, connectionId: true },
    })
    expect(mocks.redisGet).toHaveBeenCalledTimes(100)

    await expect(listProductionComfyReconcileRequests({
      afterId: 'request-100', limit: 100, now,
    })).resolves.toEqual({
      items: [{ requestId: 'request-101', mediaType: 'video' }],
      nextCursor: null,
    })
  })

  it('returns an exact backed-off lease to waiting and releases only its Redis owner', async () => {
    mocks.requestUpdateMany.mockResolvedValue({ count: 1 })
    mocks.redisEval.mockResolvedValue(1)

    await expect(returnProductionBackedOffLease({
      requestId: 'request-1', userId: 'user-1', connectionId: 'connection-1',
      leaseId: 'lease-1', ttlMs: 30_000,
    })).resolves.toBe('waiting')

    expect(mocks.requestUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'request-1', userId: 'user-1', connectionId: 'connection-1',
        leaseId: 'lease-1', status: 'leased',
      },
      data: {
        status: 'waiting_capacity', connectionId: null, leaseId: null,
        leaseExpiresAt: null,
      },
    })
    expect(mocks.redisEval).toHaveBeenCalledOnce()
  })

  it('marks the exact lease reconciling when the waiting rollback write throws', async () => {
    mocks.requestUpdateMany
      .mockRejectedValueOnce(new Error('rollback failed'))
      .mockResolvedValueOnce({ count: 1 })
    mocks.redisEval.mockResolvedValue(1)

    await expect(returnProductionBackedOffLease({
      requestId: 'request-1', userId: 'user-1', connectionId: 'connection-1',
      leaseId: 'lease-1', ttlMs: 30_000,
    })).resolves.toBe('reconciling')

    expect(mocks.requestUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'request-1', userId: 'user-1', connectionId: 'connection-1',
        leaseId: 'lease-1', status: 'leased',
      },
      data: expect.objectContaining({
        status: 'reconciling', leaseExpiresAt: expect.any(Date),
      }),
    })
    expect(mocks.redisEval).toHaveBeenCalledOnce()
  })

  it('does not hand transfer to a stale runtime after another runtime takes its reconcile claim', async () => {
    let claim: string | null = null
    mocks.redisSet.mockImplementation(async (_key: string, value: string) => {
      if (claim !== null) return null
      claim = value
      return 'OK'
    })
    mocks.redisGet.mockImplementation(async () => claim)
    mocks.redisEval.mockImplementation(async (_script: string, _keys: number, _key: string, value: string) => {
      if (claim !== value) return 0
      claim = null
      return 1
    })
    const dispatch = vi.fn()
    const createDispatcherDependencies = vi.fn()
    let reconciliationFence: (() => Promise<boolean>) | undefined

    await reconcileProductionComfyRequest(
      'request-1', operationLimits(), new AbortController().signal,
      {
        reclaimRequest: vi.fn().mockResolvedValue(recoveryOwner()),
        createReconciliationDependencies: vi.fn(async (_requestId, _limits, fence) => {
          reconciliationFence = fence
          return {} as never
        }),
        reconcile: vi.fn(async () => {
          expect(await reconciliationFence?.()).toBe(true)
          claim = 'runtime-2-claim'
          return { outcome: 'transferring' as const, outputs: [] }
        }),
        createDispatcherDependencies,
        dispatch,
      },
    )

    expect(dispatch).not.toHaveBeenCalled()
    expect(createDispatcherDependencies).not.toHaveBeenCalled()
    expect(claim).toBe('runtime-2-claim')
  })

  it('keeps both non-overlapping heartbeats alive for a transfer longer than two TTLs', async () => {
    vi.useFakeTimers()
    let claim: string | null = null
    mocks.redisSet.mockImplementation(async (_key: string, value: string) => {
      claim = value
      return 'OK'
    })
    mocks.redisGet.mockImplementation(async () => claim)
    let claimActive = 0
    let claimMaxActive = 0
    mocks.redisEval.mockImplementation(async (...args: unknown[]) => {
      const value = args[3]
      if (claim !== value) return 0
      if (args.length === 5) {
        claimActive += 1
        claimMaxActive = Math.max(claimMaxActive, claimActive)
        await Promise.resolve()
        claimActive -= 1
        return 1
      }
      claim = null
      return 1
    })
    const transfer = Promise.withResolvers<void>()
    const receipt = vi.fn()
    let durableExpiry = 0
    let requestActive = 0
    let requestMaxActive = 0
    const heartbeatRequest = vi.fn(async (owner: { ttlMs: number }) => {
      requestActive += 1
      requestMaxActive = Math.max(requestMaxActive, requestActive)
      await Promise.resolve()
      durableExpiry = Date.now() + owner.ttlMs
      requestActive -= 1
      return { owned: true as const, leaseExpiresAt: new Date(durableExpiry) }
    })
    let dispatchFence: (() => Promise<boolean>) | undefined
    let requestHeartbeatFence: (() => Promise<boolean>) | undefined
    const running = reconcileProductionComfyRequest(
      'request-1', { ...operationLimits(), leaseTtlMs: 3_000 },
      new AbortController().signal,
      {
        reclaimRequest: vi.fn().mockResolvedValue(recoveryOwner()),
        heartbeatRequest,
        createReconciliationDependencies: vi.fn().mockResolvedValue({} as never),
        reconcile: vi.fn().mockResolvedValue({ outcome: 'transferring', outputs: [] }),
        createDispatcherDependencies: vi.fn(async (
          _requestId, _limits, _signal, fence, heartbeatFence,
        ) => {
          dispatchFence = fence
          requestHeartbeatFence = heartbeatFence
          return {} as never
        }),
        dispatch: vi.fn(async () => {
          await transfer.promise
          const requestOwned = requestHeartbeatFence
            ? await requestHeartbeatFence() : true
          if (await dispatchFence?.() && requestOwned) receipt()
          return { outcome: 'reconciling' as const, promptId: 'prompt-1' }
        }),
      },
    )
    for (let index = 0; index < 10 && !dispatchFence; index += 1) await Promise.resolve()
    expect(claim).not.toBeNull()
    expect(await dispatchFence?.()).toBe(true)

    await vi.advanceTimersByTimeAsync(7_000)
    const claimRenewals = mocks.redisEval.mock.calls
      .filter((call) => call.length === 5)
    expect(claimRenewals.length).toBeGreaterThanOrEqual(6)
    expect(heartbeatRequest.mock.calls.length).toBeGreaterThanOrEqual(6)
    expect(claimMaxActive).toBe(1)
    expect(requestMaxActive).toBe(1)
    expect(durableExpiry).toBeGreaterThanOrEqual(9_000)
    expect(await dispatchFence?.()).toBe(true)
    expect(await requestHeartbeatFence?.()).toBe(true)

    transfer.resolve()
    await running
    expect(receipt).toHaveBeenCalledOnce()
    expect(claim).toBeNull()
  })

  it.each(['request', 'claim'] as const)(
    'fails closed when the %s lease heartbeat is lost during transfer',
    async (lostFence) => {
      vi.useFakeTimers()
      let claim: string | null = null
      let claimBeats = 0
      mocks.redisSet.mockImplementation(async (_key: string, value: string) => {
        claim = value
        return 'OK'
      })
      mocks.redisGet.mockImplementation(async () => claim)
      mocks.redisEval.mockImplementation(async (...args: unknown[]) => {
        if (args.length === 5) {
          claimBeats += 1
          if (lostFence === 'claim' && claimBeats >= 1) {
            claim = 'runtime-2-claim'
            return 0
          }
          return 1
        }
        if (claim === args[3]) claim = null
        return 1
      })
      let requestBeats = 0
      const heartbeatRequest = vi.fn(async () => {
        requestBeats += 1
        return lostFence === 'request' && requestBeats >= 2
          ? { owned: false as const, reason: 'redis_lost' as const }
          : { owned: true as const, leaseExpiresAt: new Date(Date.now() + 3_000) }
      })
      const transfer = Promise.withResolvers<void>()
      const externalEffect = vi.fn()
      const releaseRequestLease = vi.fn()
      let dispatchFence: (() => Promise<boolean>) | undefined
      let requestHeartbeatFence: (() => Promise<boolean>) | undefined
      const running = reconcileProductionComfyRequest(
        'request-1', { ...operationLimits(), leaseTtlMs: 3_000 },
        new AbortController().signal,
        {
          reclaimRequest: vi.fn().mockResolvedValue(recoveryOwner()),
          heartbeatRequest,
          createReconciliationDependencies: vi.fn().mockResolvedValue({} as never),
          reconcile: vi.fn().mockResolvedValue({ outcome: 'transferring', outputs: [] }),
          createDispatcherDependencies: vi.fn(async (
            _requestId, _limits, _signal, fence, heartbeatFence,
          ) => {
            dispatchFence = fence
            requestHeartbeatFence = heartbeatFence
            return {} as never
          }),
          dispatch: vi.fn(async () => {
            await transfer.promise
            const requestOwned = requestHeartbeatFence
              ? await requestHeartbeatFence() : true
            if (await dispatchFence?.() && requestOwned) {
              externalEffect()
              releaseRequestLease()
            }
            return { outcome: 'reconciling' as const, promptId: 'prompt-1' }
          }),
        },
      )
      for (let index = 0; index < 10 && !dispatchFence; index += 1) await Promise.resolve()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(claimBeats).toBeGreaterThanOrEqual(1)
      if (lostFence === 'claim') {
        expect(claim).toBe('runtime-2-claim')
        expect(await dispatchFence?.()).toBe(false)
      }
      transfer.resolve()
      await running

      expect(externalEffect).not.toHaveBeenCalled()
      expect(releaseRequestLease).not.toHaveBeenCalled()
    },
  )
})

function recoveryOwner() {
  return {
    requestId: 'request-1', userId: 'user-1', connectionId: 'connection-1',
    leaseId: 'new-request-lease', ttlMs: 3_000,
  }
}

function operationLimits() {
  return {
    leaseTtlMs: 30_000,
    workflowMaxBytes: 2_097_152,
    inputMaxBytes: 26_214_400,
    outputMaxBytes: 536_870_912,
    executionTimeoutMs: 300_000,
    networkPolicy: { mode: 'allowlist' as const, allowedHosts: [], allowedCidrs: [] },
  }
}

function groupedOwners(rows: Array<{ userId: string }>, after: string | undefined, take: number) {
  return [...new Set(rows.map((row) => row.userId))]
    .filter((userId) => after === undefined || userId > after)
    .sort()
    .slice(0, take)
    .map((userId) => ({ userId }))
}
