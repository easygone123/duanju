import { describe, expect, it, vi } from 'vitest'

import type { ComfyDispatcherDependencies } from '@/lib/comfyui/dispatcher'

const findInvocation = vi.hoisted(() => vi.fn().mockResolvedValue(null))
const createRequest = vi.hoisted(() => vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
  id: 'request-1',
  ...data,
})))

const workflowVersion = {
  id: 'version-1',
  workflowId: 'workflow-1',
  publishedAt: new Date('2026-07-19T00:00:00.000Z'),
  variableDefinitions: [
    { name: 'prompt', type: 'string', required: true },
    { name: 'seconds', type: 'number', required: true },
  ],
}

const findWorkflow = vi.hoisted(() => vi.fn())

vi.mock('@/lib/prisma', () => {
  const transactionClient = {
    comfyGenerationRequest: { findFirst: findInvocation, create: createRequest },
    comfyWorkflow: { findFirst: findWorkflow },
    comfyWorkflowVersion: { findFirst: vi.fn() },
    mediaObject: { findFirst: vi.fn() },
  }
  return {
    prisma: {
      comfyGenerationRequest: { findFirst: findInvocation, create: createRequest },
      comfyWorkflow: { findFirst: findWorkflow },
      comfyWorkflowVersion: { findFirst: vi.fn() },
      $transaction: vi.fn(async (operation: (client: typeof transactionClient) => Promise<unknown>) => (
        operation(transactionClient)
      )),
    },
  }
})

import { dispatchComfyRequest } from '@/lib/comfyui/dispatcher'
import { submitComfyVideoGeneration } from '@/lib/comfyui/provider'

function dispatcherDependencies(
  request: Record<string, unknown>,
  submitPrompt: ReturnType<typeof vi.fn>,
): ComfyDispatcherDependencies {
  return {
    loadContext: vi.fn().mockResolvedValue({
      request: {
        ...request,
        status: 'leased',
        connectionId: 'connection-1',
        leaseId: 'lease-1',
      },
      connection: { id: 'connection-1', userId: 'user-1', enabled: true },
      version: {
        id: 'version-1',
        workflowId: 'workflow-1',
        graph: {
          '1': { class_type: 'VideoNode', inputs: { seconds: 1 } },
          '2': { class_type: 'VHS_VideoCombine', inputs: { images: ['1', 0] } },
        },
        variableDefinitions: workflowVersion.variableDefinitions,
        bindings: [{
          nodeId: '1', inputPath: 'seconds', variable: 'seconds', valueType: 'number',
        }],
        outputs: [{
          name: 'video', nodeId: '2', fieldPath: 'gifs', mediaType: 'video', primary: true,
        }],
      },
    }),
    recheckClaim: vi.fn().mockResolvedValue(true),
    heartbeat: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(true),
    transition: vi.fn().mockResolvedValue(true),
    recordNumericDiagnostics: vi.fn().mockResolvedValue(true),
    preSubmitGate: vi.fn().mockResolvedValue('ready'),
    blockIncompatible: vi.fn().mockResolvedValue(true),
    claimSubmissionFence: vi.fn().mockResolvedValue({
      outcome: 'claimed', attemptId: 'attempt-1', clientId: 'client-1',
    }),
    recordAcceptedPrompt: vi.fn().mockResolvedValue({ outcome: 'request_recorded' }),
    cancelIfRequested: vi.fn().mockResolvedValue('continue'),
    cancelBeforeTransfer: vi.fn().mockResolvedValue(false),
    persistProgress: vi.fn().mockResolvedValue(true),
    persistOutputRefs: vi.fn().mockResolvedValue(true),
    persistCompletedOutputs: vi.fn().mockResolvedValue(true),
    persistStoredOutputReceipt: vi.fn().mockResolvedValue(true),
    returnToWaiting: vi.fn().mockResolvedValue(true),
    markReconciling: vi.fn().mockResolvedValue(true),
    markFailed: vi.fn().mockResolvedValue(true),
    client: {
      uploadImage: vi.fn(),
      submitPrompt,
      watchPrompt: async function* () {
        yield { type: 'executing' as const, promptId: 'prompt-1', nodeId: null }
      },
      getHistory: vi.fn().mockResolvedValue({
        outputs: {
          '2': {
            gifs: [{ filename: 'video.mp4', subfolder: '', type: 'output' }],
          },
        },
      }),
      getQueue: vi.fn().mockResolvedValue({ running: [], pending: [] }),
      downloadOutput: vi.fn().mockResolvedValue(Buffer.from([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
      ])),
      deleteQueuedPrompt: vi.fn(),
    },
    readOwnedObject: vi.fn(),
    resolveOwnedMedia: vi.fn().mockResolvedValue(true),
    uploadObject: vi.fn(async (_bytes, key) => key),
    objectExists: vi.fn().mockResolvedValue(false),
    resolveStoredUrl: vi.fn((key) => `/api/files/${key}`),
    randomId: vi.fn().mockReturnValueOnce('client-1').mockReturnValue('attempt-1'),
    signal: new AbortController().signal,
    leaseTtlMs: 30_000,
  }
}

describe('ComfyUI provider request snapshot contract', () => {
  it('maps the system duration into a required seconds alias before dispatch', async () => {
    findWorkflow.mockResolvedValue({
      id: 'workflow-1',
      userId: 'user-1',
      mediaType: 'video',
      status: 'published',
      currentVersionId: 'version-1',
      currentVersion: workflowVersion,
    })
    await expect(submitComfyVideoGeneration({
      userId: 'user-1',
      workflowId: 'workflow-1',
      prompt: 'move',
      context: {
        projectId: 'project-1',
        taskId: 'task-1',
        invocationKey: 'task-1:video:0',
      },
      variables: { duration_seconds: 5 },
    })).resolves.toEqual({
      success: true,
      async: true,
      externalId: 'COMFY:VIDEO:request-1',
    })

    const request = createRequest.mock.results[0]?.value
    await expect(request).resolves.toMatchObject({
      variableSnapshot: { prompt: 'move', seconds: 5 },
    })
    const createdRequest = await request
    const submitPrompt = vi.fn().mockResolvedValue({ promptId: 'prompt-1' })

    await expect(dispatchComfyRequest(
      'request-1', dispatcherDependencies(createdRequest, submitPrompt),
    )).resolves.toMatchObject({ outcome: 'completed' })
    expect(submitPrompt).toHaveBeenCalledWith(expect.objectContaining({
      '1': expect.objectContaining({ inputs: { seconds: 5 } }),
    }), 'client-1')
  })
})
