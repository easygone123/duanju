import { beforeEach, describe, expect, it, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  viralReplication: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  task: {
    findMany: vi.fn(),
  },
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

import {
  failOwnedViralAnalysisExecution,
  reconcileFailedViralAnalysisExecutions,
} from '@/lib/viral-replication/reconcile'

describe('viral analysis Task ownership reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.viralReplication.updateMany.mockResolvedValue({ count: 1 })
  })

  it('fails and releases only the analyzing execution owned by the failed Task', async () => {
    await expect(failOwnedViralAnalysisExecution('task-failed', 'heartbeat timed out'))
      .resolves.toBe(true)

    expect(prismaMock.viralReplication.updateMany).toHaveBeenCalledWith({
      where: {
        status: 'analyzing',
        analysisExecutionTaskId: 'task-failed',
      },
      data: {
        status: 'failed',
        errorMessage: 'heartbeat timed out',
        analysisExecutionTaskId: null,
        analysisExecutionToken: null,
        analysisExecutionExpiresAt: null,
      },
    })
  })

  it('reports no release when a newer Task has already taken ownership', async () => {
    prismaMock.viralReplication.updateMany.mockResolvedValue({ count: 0 })

    await expect(failOwnedViralAnalysisExecution('task-old', 'orphaned'))
      .resolves.toBe(false)
  })

  it('repairs analyzing executions whose owning Tasks are already failed', async () => {
    prismaMock.viralReplication.findMany.mockResolvedValue([
      { analysisExecutionTaskId: 'task-failed' },
      { analysisExecutionTaskId: 'task-active' },
      { analysisExecutionTaskId: 'task-failed' },
    ])
    prismaMock.task.findMany.mockResolvedValue([
      { id: 'task-failed', errorMessage: 'queue job missing' },
    ])

    await expect(reconcileFailedViralAnalysisExecutions())
      .resolves.toEqual(['task-failed'])

    expect(prismaMock.task.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['task-failed', 'task-active'] },
        status: 'failed',
      },
      select: { id: true, errorMessage: true },
    })
    expect(prismaMock.viralReplication.updateMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.viralReplication.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        status: 'analyzing',
        analysisExecutionTaskId: 'task-failed',
      },
    }))
  })
})
