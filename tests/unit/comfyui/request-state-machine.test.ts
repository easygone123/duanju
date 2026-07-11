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
      uploading: ['submitted', 'waiting_capacity', 'reconciling', 'failed', 'canceled'],
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
      patch: { connectionId: 'connection-1', leaseId: 'lease-1' },
      now: new Date('2026-07-11T01:00:00.000Z'),
    }, { updateMany })

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'request-1', userId: 'user-1', status: 'waiting_capacity' },
      data: expect.objectContaining({ status: 'leased', leasedAt: new Date('2026-07-11T01:00:00.000Z') }),
    })
    updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(transitionComfyGenerationRequest({
      requestId: 'request-1', userId: 'user-1', from: 'waiting_capacity', to: 'leased',
    }, { updateMany })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(transitionComfyGenerationRequest({
      requestId: 'request-1', userId: 'user-1', from: 'completed', to: 'running',
    }, { updateMany })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
