import { beforeEach, describe, expect, it, vi } from 'vitest'

const queueMocks = vi.hoisted(() => {
  const makeQueue = () => ({ getJob: vi.fn(async () => null) })
  return {
    imageQueue: makeQueue(),
    videoQueue: makeQueue(),
    voiceQueue: makeQueue(),
    textQueue: makeQueue(),
    viralReplicationQueue: makeQueue(),
  }
})

vi.mock('@/lib/task/queues', () => queueMocks)

import { isJobAlive } from '@/lib/task/reconcile'

describe('task reconciliation queue catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const queue of Object.values(queueMocks)) queue.getJob.mockResolvedValue(null)
  })

  it.each(['waiting', 'active', 'delayed'])('treats a viral %s job as alive', async (state) => {
    queueMocks.viralReplicationQueue.getJob.mockResolvedValue({
      getState: vi.fn(async () => state),
    } as never)

    await expect(isJobAlive('viral-task')).resolves.toBe(true)
    expect(queueMocks.viralReplicationQueue.getJob).toHaveBeenCalledWith('viral-task')
  })

  it.each(['failed', 'completed'])('treats a viral %s job as terminal', async (state) => {
    queueMocks.viralReplicationQueue.getJob.mockResolvedValue({
      getState: vi.fn(async () => state),
    } as never)

    await expect(isJobAlive('viral-task')).resolves.toBe(false)
  })

  it('treats a job missing from every queue as missing', async () => {
    await expect(isJobAlive('missing-task')).resolves.toBe(false)
    expect(queueMocks.viralReplicationQueue.getJob).toHaveBeenCalledWith('missing-task')
  })
})
