import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectionFindMany: vi.fn(),
  requestFindMany: vi.fn(),
  redisGet: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    comfyConnection: { findMany: mocks.connectionFindMany },
    comfyGenerationRequest: { findMany: mocks.requestFindMany },
  },
}))

vi.mock('@/lib/redis', () => ({
  redis: { get: mocks.redisGet },
}))

import {
  listProductionComfyDispatchOwners,
  listProductionComfyHealthOwners,
  listProductionComfyReconcileRequests,
} from '@/lib/comfyui/runtime-production'

describe('production ComfyUI runtime keyset pages', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each([
    ['health', listProductionComfyHealthOwners],
    ['dispatch', listProductionComfyDispatchOwners],
  ])('queries an enabled connection page for %s owners without requiring the cursor row', async (_name, list) => {
    mocks.connectionFindMany.mockResolvedValue([
      { id: 'connection-101', userId: 'user-1' },
      { id: 'connection-102', userId: 'user-2' },
      { id: 'connection-103', userId: 'user-3' },
    ])

    await expect(list({ afterId: 'deleted-connection-100', limit: 2 })).resolves.toEqual({
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
})
