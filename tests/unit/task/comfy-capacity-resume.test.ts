import { beforeEach, describe, expect, it, vi } from 'vitest'

const findUniqueMock = vi.hoisted(() => vi.fn())
const updateManyMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/prisma', () => ({
  prisma: {
    task: {
      findUnique: findUniqueMock,
      updateMany: updateManyMock,
    },
  },
}))
vi.mock('@/lib/billing', () => ({ rollbackTaskBilling: vi.fn() }))
vi.mock('@/lib/prisma-retry', () => ({ withPrismaRetry: vi.fn((fn) => fn()) }))

import { tryResumeTaskFromComfyCapacityWait } from '@/lib/task/service'

describe('ComfyUI capacity resume durable lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    updateManyMock.mockResolvedValue({ count: 1 })
  })

  it('only refreshes ownership heartbeat for a durable owned waiting request', async () => {
    const externalId = 'COMFY:IMAGE:req-1'
    findUniqueMock.mockResolvedValue({
      status: 'processing',
      externalId,
      payload: { waitingForCapacity: true, externalId },
    })

    await expect(tryResumeTaskFromComfyCapacityWait('task-1', {
      version: 1,
      taskId: 'task-1',
      externalId,
    })).resolves.toBe(true)

    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 'task-1', status: 'processing', externalId },
      data: { heartbeatAt: expect.any(Date) },
    })
    const update = updateManyMock.mock.calls[0]?.[0].data
    expect(update).not.toHaveProperty('attempt')
    expect(update).not.toHaveProperty('startedAt')
    expect(update).not.toHaveProperty('externalId')
  })

  it.each([
    ['cloud external id', 'FAL:IMAGE:req-1', null],
    ['wrong task marker', 'COMFY:IMAGE:req-1', 'task-other'],
  ])('rejects %s before touching durable task state', async (_case, externalId, markerTaskId) => {
    await expect(tryResumeTaskFromComfyCapacityWait('task-1', {
      version: 1,
      taskId: markerTaskId || 'task-1',
      externalId,
    })).resolves.toBe(false)
    expect(findUniqueMock).not.toHaveBeenCalled()
    expect(updateManyMock).not.toHaveBeenCalled()
  })

  it('rejects a forged marker unless durable progress confirms the same waiting request', async () => {
    findUniqueMock.mockResolvedValue({
      status: 'processing',
      externalId: 'COMFY:VIDEO:req-real',
      payload: { waitingForCapacity: true, externalId: 'COMFY:VIDEO:req-real' },
    })
    await expect(tryResumeTaskFromComfyCapacityWait('task-1', {
      version: 1,
      taskId: 'task-1',
      externalId: 'COMFY:VIDEO:req-forged',
    })).resolves.toBe(false)
    expect(updateManyMock).not.toHaveBeenCalled()
  })
})
