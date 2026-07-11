import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectionFindMany: vi.fn(),
  requestFindMany: vi.fn(),
  requestUpdateMany: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisEval: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    comfyConnection: { findMany: mocks.connectionFindMany },
    comfyGenerationRequest: {
      findMany: mocks.requestFindMany,
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

  it('queries an enabled connection page for health owners without requiring the cursor row', async () => {
    mocks.connectionFindMany.mockResolvedValue([
      { id: 'connection-101', userId: 'user-1' },
      { id: 'connection-102', userId: 'user-2' },
      { id: 'connection-103', userId: 'user-3' },
    ])

    await expect(listProductionComfyHealthOwners({
      afterId: 'deleted-connection-100', limit: 2,
    })).resolves.toEqual({
      items: [
        { id: 'connection-101', userId: 'user-1' },
        { id: 'connection-102', userId: 'user-2' },
      ],
      nextCursor: 'connection-102',
    })
    expect(mocks.connectionFindMany).toHaveBeenCalledWith({
      where: { enabled: true, id: { gt: 'deleted-connection-100' } },
      orderBy: { id: 'asc' },
      take: 3,
      select: { id: true, userId: true },
    })
  })

  it('queries dispatch owners from waiting requests, including users without enabled connections', async () => {
    mocks.requestFindMany.mockResolvedValue([
      { id: 'request-101', userId: 'user-without-node' },
      { id: 'request-102', userId: 'user-with-node' },
      { id: 'request-103', userId: 'next-page' },
    ])

    await expect(listProductionComfyDispatchOwners({
      afterId: 'deleted-request-100', limit: 2,
    })).resolves.toEqual({
      items: [
        { id: 'request-101', userId: 'user-without-node' },
        { id: 'request-102', userId: 'user-with-node' },
      ],
      nextCursor: 'request-102',
    })
    expect(mocks.requestFindMany).toHaveBeenCalledWith({
      where: {
        id: { gt: 'deleted-request-100' },
        status: { in: ['waiting_capacity', 'blocked_no_compatible_instance'] },
      },
      orderBy: { id: 'asc' },
      take: 3,
      select: { id: true, userId: true },
    })
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
        reclaimRequest: vi.fn().mockResolvedValue(true),
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

  it('keeps the reconcile claim heartbeat through transfer and passes its live fence to dispatch', async () => {
    vi.useFakeTimers()
    let claim: string | null = null
    mocks.redisSet.mockImplementation(async (_key: string, value: string) => {
      claim = value
      return 'OK'
    })
    mocks.redisGet.mockImplementation(async () => claim)
    mocks.redisEval.mockImplementation(async (...args: unknown[]) => {
      const value = args[3]
      if (claim !== value) return 0
      if (args.length === 5) return 1
      claim = null
      return 1
    })
    const transfer = Promise.withResolvers<{ outcome: 'reconciling'; promptId: string }>()
    let dispatchFence: (() => Promise<boolean>) | undefined
    const running = reconcileProductionComfyRequest(
      'request-1', { ...operationLimits(), leaseTtlMs: 3_000 },
      new AbortController().signal,
      {
        reclaimRequest: vi.fn().mockResolvedValue(true),
        createReconciliationDependencies: vi.fn().mockResolvedValue({} as never),
        reconcile: vi.fn().mockResolvedValue({ outcome: 'transferring', outputs: [] }),
        createDispatcherDependencies: vi.fn(async (_requestId, _limits, _signal, fence) => {
          dispatchFence = fence
          return {} as never
        }),
        dispatch: vi.fn(() => transfer.promise),
      },
    )
    for (let index = 0; index < 10 && !dispatchFence; index += 1) await Promise.resolve()
    expect(claim).not.toBeNull()
    expect(await dispatchFence?.()).toBe(true)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.redisEval).toHaveBeenCalledWith(
      expect.any(String), 1, 'comfy:reconcile:request-1', expect.any(String), 3_000,
    )
    claim = 'runtime-2-claim'
    expect(await dispatchFence?.()).toBe(false)

    transfer.resolve({ outcome: 'reconciling', promptId: 'prompt-1' })
    await running
    expect(claim).toBe('runtime-2-claim')
  })
})

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
