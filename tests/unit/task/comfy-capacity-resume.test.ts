import { beforeEach, describe, expect, it, vi } from 'vitest'

const findUniqueMock = vi.hoisted(() => vi.fn())
const updateManyMock = vi.hoisted(() => vi.fn())
const findComfyRequestMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/prisma', () => ({
  prisma: {
    task: {
      findUnique: findUniqueMock,
      updateMany: updateManyMock,
    },
    comfyGenerationRequest: {
      findFirst: findComfyRequestMock,
    },
  },
}))
vi.mock('@/lib/billing', () => ({ rollbackTaskBilling: vi.fn() }))
vi.mock('@/lib/prisma-retry', () => ({ withPrismaRetry: vi.fn((fn) => fn()) }))

import { tryResumeTaskFromComfyCapacityWait } from '@/lib/task/service'

describe('ComfyUI capacity resume durable lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    updateManyMock.mockResolvedValue({ count: 1 })
  })

  it.each([
    'waiting_capacity', 'blocked_no_compatible_instance', 'leased', 'uploading',
    'submitting', 'submitted', 'running', 'transferring', 'reconciling',
    'completed', 'failed', 'canceled',
  ])('only refreshes ownership heartbeat for an owned request advanced to %s while delayed',
    async (status) => {
      const externalId = 'COMFY:IMAGE:req-2'
      findUniqueMock.mockResolvedValue({
        status: 'processing',
        userId: 'user-1',
        externalId: 'COMFY:IMAGE:req-1',
        payload: { waitingForCapacity: true, externalId },
      })
      findComfyRequestMock.mockResolvedValue({
        id: 'req-2', taskId: 'task-1', userId: 'user-1',
        mediaType: 'image', status,
      })

      await expect(tryResumeTaskFromComfyCapacityWait('task-1', {
        version: 1,
        taskId: 'task-1',
        externalId,
      })).resolves.toBe(true)

      expect(updateManyMock).toHaveBeenCalledWith({
        where: { id: 'task-1', status: 'processing' },
        data: { heartbeatAt: expect.any(Date) },
      })
      expect(findComfyRequestMock).toHaveBeenCalledWith({
        where: { id: 'req-2', userId: 'user-1' },
        select: { id: true, taskId: true, userId: true, mediaType: true, status: true },
      })
      const update = updateManyMock.mock.calls[0]?.[0].data
      expect(update).not.toHaveProperty('attempt')
      expect(update).not.toHaveProperty('startedAt')
      expect(update).not.toHaveProperty('externalId')
    })

  it('uses the current resume heartbeat when the scheduler completes during the delay', async () => {
    vi.useFakeTimers()
    const resumedAt = new Date('2026-07-11T14:00:00.000Z')
    vi.setSystemTime(resumedAt)
    const externalId = 'COMFY:VIDEO:req-completed'
    findUniqueMock.mockResolvedValue({
      status: 'processing', userId: 'user-1',
      payload: { waitingForCapacity: true, externalId },
    })
    findComfyRequestMock.mockResolvedValue({
      id: 'req-completed', taskId: 'task-1', userId: 'user-1',
      mediaType: 'video', status: 'completed',
    })

    await expect(tryResumeTaskFromComfyCapacityWait('task-1', {
      version: 1, taskId: 'task-1', externalId,
    })).resolves.toBe(true)
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 'task-1', status: 'processing' },
      data: { heartbeatAt: resumedAt },
    })
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
      userId: 'user-1',
      payload: { waitingForCapacity: true, externalId: 'COMFY:VIDEO:req-forged' },
    })
    findComfyRequestMock.mockResolvedValue({
      id: 'req-forged', taskId: 'task-other', userId: 'user-1',
      mediaType: 'video', status: 'waiting_capacity',
    })
    await expect(tryResumeTaskFromComfyCapacityWait('task-1', {
      version: 1,
      taskId: 'task-1',
      externalId: 'COMFY:VIDEO:req-forged',
    })).resolves.toBe(false)
    expect(updateManyMock).not.toHaveBeenCalled()
  })

  it.each([
    { waitingForCapacity: false, externalId: 'COMFY:IMAGE:req-2' },
    { waitingForCapacity: true, externalId: 'COMFY:IMAGE:req-other' },
    { externalId: 'COMFY:IMAGE:req-2' },
  ])('rejects a valid owned request when durable task payload does not match: %j', async (payload) => {
    findUniqueMock.mockResolvedValue({ status: 'processing', userId: 'user-1', payload })
    findComfyRequestMock.mockResolvedValue({
      id: 'req-2', taskId: 'task-1', userId: 'user-1',
      mediaType: 'image', status: 'running',
    })
    await expect(tryResumeTaskFromComfyCapacityWait('task-1', {
      version: 1, taskId: 'task-1', externalId: 'COMFY:IMAGE:req-2',
    })).resolves.toBe(false)
    expect(updateManyMock).not.toHaveBeenCalled()
  })

  it.each([
    ['wrong media', 'waiting_capacity', 'task-1', 'video'],
    ['other task request', 'blocked_no_compatible_instance', 'task-other', 'image'],
  ])('rejects %s even when its id and owner match', async (_case, status, requestTaskId, mediaType) => {
    findUniqueMock.mockResolvedValue({
      status: 'processing', userId: 'user-1',
      payload: { waitingForCapacity: true, externalId: 'COMFY:IMAGE:req-2' },
    })
    findComfyRequestMock.mockResolvedValue({
      id: 'req-2', taskId: requestTaskId, userId: 'user-1', mediaType, status,
    })
    await expect(tryResumeTaskFromComfyCapacityWait('task-1', {
      version: 1, taskId: 'task-1', externalId: 'COMFY:IMAGE:req-2',
    })).resolves.toBe(false)
    expect(updateManyMock).not.toHaveBeenCalled()
  })
})
