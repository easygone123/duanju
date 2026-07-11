import { beforeEach, describe, expect, it, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  task: { findMany: vi.fn() },
  comfyGenerationRequest: { findMany: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

import { queryTaskTargetStates } from '@/lib/task/state-service'

describe('task state ComfyUI diagnostics query', () => {
  beforeEach(() => vi.clearAllMocks())

  it('loads an owner-scoped safe request projection and attaches it to the running task', async () => {
    prismaMock.task.findMany.mockResolvedValue([{
      id: 'task-1', type: 'image_panel', status: 'processing', progress: 20, payload: {},
      errorCode: null, errorMessage: null, targetType: 'NovelPromotionPanel', targetId: 'panel-1',
      externalId: 'COMFY:IMAGE:request-1', updatedAt: new Date('2026-07-12T00:00:20Z'),
    }])
    prismaMock.comfyGenerationRequest.findMany.mockResolvedValue([{
      id: 'request-1', taskId: 'task-1', status: 'waiting_capacity', connectionId: null,
      workflowId: 'workflow-1', workflowVersionId: 'version-1', promptId: null,
      queuedAt: new Date('2026-07-12T00:00:00Z'), leasedAt: null, runningAt: null,
      transferringAt: null, completedAt: null, updatedAt: new Date('2026-07-12T00:00:20Z'),
    }])
    const [state] = await queryTaskTargetStates({
      projectId: 'project-1', userId: 'user-1', targets: [{ targetType: 'NovelPromotionPanel', targetId: 'panel-1' }],
    })
    expect(prismaMock.comfyGenerationRequest.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['request-1'] }, userId: 'user-1', projectId: 'project-1' },
      select: expect.not.objectContaining({ variableSnapshot: true, leaseId: true, clientId: true, nodeErrors: true }),
    })
    expect(state.comfyDiagnostics).toMatchObject({
      stage: 'waiting_capacity', waitingForCapacity: true, capacityWaitMs: 20_000,
      workflowId: 'workflow-1', workflowVersionId: 'version-1', promptId: null,
    })
  })

  it('does not query ComfyUI requests for a malformed external id', async () => {
    prismaMock.task.findMany.mockResolvedValue([{
      id: 'task-1', type: 'image_panel', status: 'processing', progress: 20, payload: {},
      errorCode: null, errorMessage: null, targetType: 'NovelPromotionPanel', targetId: 'panel-1',
      externalId: 'COMFY:IMAGE:request-1\n', updatedAt: new Date(),
    }])
    const [state] = await queryTaskTargetStates({
      projectId: 'project-1', userId: 'user-1', targets: [{ targetType: 'NovelPromotionPanel', targetId: 'panel-1' }],
    })
    expect(prismaMock.comfyGenerationRequest.findMany).not.toHaveBeenCalled()
    expect(state.comfyDiagnostics).toBeNull()
  })

  it('does not let hundreds of superseded active rows displace the displayed running task diagnostics', async () => {
    const older = Array.from({ length: 500 }, (_, index) => ({
      id: `old-${index}`, type: 'image_panel', status: 'processing', progress: 10, payload: {},
      errorCode: null, errorMessage: null, targetType: 'NovelPromotionPanel', targetId: 'panel-1',
      externalId: `COMFY:IMAGE:old-request-${index}`, updatedAt: new Date(index),
    }))
    prismaMock.task.findMany.mockResolvedValue([...older, {
      id: 'task-current', type: 'image_panel', status: 'processing', progress: 80, payload: {},
      errorCode: null, errorMessage: null, targetType: 'NovelPromotionPanel', targetId: 'panel-1',
      externalId: 'COMFY:IMAGE:request-current', updatedAt: new Date('2026-07-12T00:00:00Z'),
    }])
    prismaMock.comfyGenerationRequest.findMany.mockResolvedValue([])
    await queryTaskTargetStates({
      projectId: 'project-1', userId: 'user-1', targets: [{ targetType: 'NovelPromotionPanel', targetId: 'panel-1' }],
    })
    expect(prismaMock.comfyGenerationRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['request-current'] }, userId: 'user-1', projectId: 'project-1' },
    }))
  })
})
