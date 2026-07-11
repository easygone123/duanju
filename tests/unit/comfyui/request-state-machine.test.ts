import { describe, expect, it, vi } from 'vitest'

import {
  ALLOWED_COMFY_REQUEST_TRANSITIONS,
  createComfyGenerationRequest,
  transitionComfyGenerationRequest,
} from '@/lib/comfyui/request-service'
import { COMFY_REQUEST_STATUS } from '@/lib/comfyui/types'

const version = {
  id: 'version-1',
  workflowId: 'workflow-1',
  apiFormatJson: { '1': { class_type: 'KSampler', inputs: {} } },
  variableDefinitions: [{ name: 'prompt', type: 'string', required: true }],
  bindingSpec: [{ nodeId: '1', inputPath: 'text', variable: 'prompt', valueType: 'string' }],
  outputSpec: [{ name: 'image', nodeId: '1', fieldPath: 'images', mediaType: 'image', primary: true }],
  requirements: { nodeClasses: ['KSampler'], candidateLoaderInputs: [] },
  contentHash: 'workflow-hash',
  publishedAt: new Date('2026-07-11T00:00:00.000Z'),
}

describe('ComfyUI request state machine', () => {
  it('declares exactly the approved state transitions', () => {
    expect(ALLOWED_COMFY_REQUEST_TRANSITIONS).toEqual({
      waiting_capacity: ['blocked_no_compatible_instance', 'leased', 'canceled'],
      blocked_no_compatible_instance: ['waiting_capacity', 'canceled'],
      leased: ['uploading', 'waiting_capacity', 'reconciling', 'failed', 'canceled'],
      uploading: ['submitting', 'waiting_capacity', 'reconciling', 'failed', 'canceled'],
      submitting: ['submitted', 'reconciling', 'failed', 'canceled'],
      submitted: ['running', 'transferring', 'reconciling', 'failed', 'canceled'],
      running: ['transferring', 'reconciling', 'failed', 'canceled'],
      transferring: ['completed', 'reconciling', 'failed', 'canceled'],
      reconciling: ['submitted', 'running', 'transferring', 'completed', 'failed', 'canceled'],
      completed: [], failed: [], canceled: [],
    })
  })

  it('pins the published workflow version and returns the same request on duplicate invocation', async () => {
    const existing = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'request-1', invocationKey: 'invoke-1', userId: 'user-1', workflowVersionId: version.id,
      variableSnapshot: { prompt: 'first' }, status: 'waiting_capacity',
    })
    const create = vi.fn().mockResolvedValue({
      id: 'request-1', invocationKey: 'invoke-1', userId: 'user-1', workflowVersionId: version.id,
      variableSnapshot: { prompt: 'first' }, status: 'waiting_capacity',
    })
    const dependencies = {
      findInvocation: existing,
      findPublishedWorkflow: vi.fn().mockResolvedValue({
        id: 'workflow-1', userId: 'user-1', mediaType: 'image', status: 'published',
        currentVersionId: version.id, currentVersion: version,
      }),
      create,
      transaction: async <T>(operation: (value: never) => Promise<T>) => operation(dependencies as never),
    }
    const input = {
      invocationKey: 'invoke-1', userId: 'user-1', projectId: 'project-1', taskId: 'task-1',
      mediaType: 'image' as const, workflowId: 'workflow-1', variables: { prompt: 'first' },
    }

    const first = await createComfyGenerationRequest(input, dependencies)
    const duplicate = await createComfyGenerationRequest(input, dependencies)

    expect(first).toEqual(duplicate)
    expect(create).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: 'workflow-1', workflowVersionId: 'version-1',
      variableSnapshot: { prompt: 'first' }, status: 'waiting_capacity',
    }))
  })

  it('uses compare-and-set and refuses stale or illegal transitions', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 })
    await transitionComfyGenerationRequest({
      requestId: 'request-1', userId: 'user-1',
      from: COMFY_REQUEST_STATUS.WAITING_CAPACITY, to: COMFY_REQUEST_STATUS.LEASED,
      expectedLeaseId: 'lease-1',
      patch: {
        connectionId: 'connection-1', leaseId: 'lease-1',
        leaseExpiresAt: new Date('2026-07-11T01:01:00.000Z'),
      },
      now: new Date('2026-07-11T01:00:00.000Z'),
    }, { updateMany, findCurrent: vi.fn() })

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'request-1', userId: 'user-1', status: 'waiting_capacity' },
      data: expect.objectContaining({ status: 'leased', leasedAt: new Date('2026-07-11T01:00:00.000Z') }),
    })
    updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(transitionComfyGenerationRequest({
      requestId: 'request-1', userId: 'user-1', from: 'waiting_capacity', to: 'leased',
    }, { updateMany, findCurrent: vi.fn().mockResolvedValue(null) })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    await expect(transitionComfyGenerationRequest({
      requestId: 'request-1', userId: 'user-1', from: 'completed', to: 'running',
    }, { updateMany, findCurrent: vi.fn() })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('accepts an exact same-target retry but rejects a different stale lease', async () => {
    const leasedAt = new Date('2026-07-11T01:00:00.000Z')
    const updateMany = vi.fn().mockResolvedValue({ count: 0 })
    const findCurrent = vi.fn().mockResolvedValue({
      id: 'request-1', userId: 'user-1', status: 'leased',
      connectionId: 'connection-1', leaseId: 'lease-1',
      leaseExpiresAt: new Date('2026-07-11T01:01:00.000Z'), leasedAt,
    })
    const base = {
      requestId: 'request-1', userId: 'user-1',
      from: COMFY_REQUEST_STATUS.WAITING_CAPACITY, to: COMFY_REQUEST_STATUS.LEASED,
      expectedLeaseId: 'lease-1',
      patch: {
        connectionId: 'connection-1', leaseId: 'lease-1',
        leaseExpiresAt: new Date('2026-07-11T01:01:00.000Z'),
      },
      now: new Date('2026-07-11T01:00:00.000Z'),
    }

    await expect(transitionComfyGenerationRequest(base, {
      updateMany, findCurrent,
    })).resolves.toBeUndefined()
    await expect(transitionComfyGenerationRequest({
      ...base, patch: { ...base.patch, leaseId: 'different-lease' },
    }, { updateMany, findCurrent })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    await expect(transitionComfyGenerationRequest({
      ...base, expectedLeaseId: 'different-lease',
      patch: { ...base.patch, leaseId: 'different-lease' },
    }, { updateMany, findCurrent })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('requires a matching lease owner for transitions from an assigned phase', async () => {
    await expect(transitionComfyGenerationRequest({
      requestId: 'request-1', userId: 'user-1', from: 'leased', to: 'uploading',
    }, { updateMany: vi.fn(), findCurrent: vi.fn() })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    })
  })

  it('requires a complete and internally consistent owner when entering leased', async () => {
    const dependencies = { updateMany: vi.fn(), findCurrent: vi.fn() }
    await expect(transitionComfyGenerationRequest({
      requestId: 'request-1', userId: 'user-1', from: 'waiting_capacity', to: 'leased',
      expectedLeaseId: 'lease-1', patch: { connectionId: 'connection-1', leaseId: 'lease-1' },
    }, dependencies)).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    await expect(transitionComfyGenerationRequest({
      requestId: 'request-1', userId: 'user-1', from: 'waiting_capacity', to: 'leased',
      expectedLeaseId: 'other-lease', patch: {
        connectionId: 'connection-1', leaseId: 'lease-1', leaseExpiresAt: new Date(),
      },
    }, dependencies)).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
  })

  it('treats an exact leased-to-waiting retry as idempotent after the lease was cleared', async () => {
    const patch = { connectionId: null, leaseId: null, leaseExpiresAt: null }
    await expect(transitionComfyGenerationRequest({
      requestId: 'request-1', userId: 'user-1', from: 'leased', to: 'waiting_capacity',
      expectedLeaseId: 'old-lease', patch,
    }, {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findCurrent: vi.fn().mockResolvedValue({
        id: 'request-1', userId: 'user-1', status: 'waiting_capacity',
        lastTransitionToken: 'old-lease', ...patch,
      }),
    })).resolves.toBeUndefined()
    await expect(transitionComfyGenerationRequest({
      requestId: 'request-1', userId: 'user-1', from: 'leased', to: 'waiting_capacity',
      expectedLeaseId: 'other-lease', patch,
    }, {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findCurrent: vi.fn().mockResolvedValue({
        id: 'request-1', userId: 'user-1', status: 'waiting_capacity',
        lastTransitionToken: 'old-lease', ...patch,
      }),
    })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('rejects immutable and phase-inappropriate transition patch fields at runtime', async () => {
    const dependencies = { updateMany: vi.fn(), findCurrent: vi.fn() }
    for (const patch of [
      { workflowVersionId: 'evil-version' },
      { userId: 'other-user' },
      { variableSnapshot: { prompt: 'changed' } },
      { promptId: 'too-early' },
    ]) {
      await expect(transitionComfyGenerationRequest({
        requestId: 'request-1', userId: 'user-1',
        from: 'waiting_capacity', to: 'leased', patch,
      }, dependencies)).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    }
    expect(dependencies.updateMany).not.toHaveBeenCalled()
  })

  it.each([
    ['missing required', {}],
    ['wrong type', { prompt: 42 }],
    ['nonfinite number', { prompt: 'ok', steps: Number.POSITIVE_INFINITY }],
    ['extra variable', { prompt: 'ok', secret: 'nope' }],
    ['oversized snapshot', { prompt: 'x'.repeat(300_000) }],
  ])('rejects an invalid pinned variable snapshot: %s', async (_case, variables) => {
    const dependencies = requestDependenciesWithDefinitions([
      { name: 'prompt', type: 'string', required: true },
      { name: 'steps', type: 'number', required: false },
    ])
    await expect(createComfyGenerationRequest({
      invocationKey: `invoke-${_case}`, userId: 'user-1', projectId: 'project-1',
      taskId: 'task-1', mediaType: 'image', workflowId: 'workflow-1', variables,
    }, dependencies)).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    expect(dependencies.create).not.toHaveBeenCalled()
  })
})

function requestDependenciesWithDefinitions(variableDefinitions: unknown[]) {
  const dependencies = {
    findInvocation: vi.fn().mockResolvedValue(null),
    findPublishedWorkflow: vi.fn().mockResolvedValue({
      id: 'workflow-1', userId: 'user-1', mediaType: 'image', status: 'published',
      currentVersionId: version.id,
      currentVersion: { ...version, variableDefinitions },
    }),
    create: vi.fn(),
    transaction: async <T>(operation: (value: never) => Promise<T>) => operation(dependencies as never),
  }
  return dependencies
}
