import { describe, expect, it, vi } from 'vitest'

import { dispatchComfyRequest, type ComfyDispatcherDependencies } from '@/lib/comfyui/dispatcher'
import { ComfyError } from '@/lib/comfyui/errors'
import { prepareComfyMediaUploads } from '@/lib/comfyui/media'
import type { ComfyOutputRef } from '@/lib/comfyui/types'

function context(overrides: Record<string, unknown> = {}) {
  return {
    request: {
      id: 'request-1', taskId: 'task-1', invocationKey: 'invoke-1', userId: 'user-1',
      projectId: 'project-1', mediaType: 'image' as const, workflowId: 'workflow-1',
      workflowVersionId: 'version-1', variableSnapshot: {
        input: { storageKey: '/api/files/source.png', mimeType: 'image/png', filename: 'source.png' },
      }, status: 'leased' as const, connectionId: 'connection-1', leaseId: 'lease-1',
    },
    connection: { id: 'connection-1', userId: 'user-1', enabled: true },
    version: {
      id: 'version-1', workflowId: 'workflow-1',
      graph: { '1': { class_type: 'LoadImage', inputs: { image: '' } } },
      variableDefinitions: [{ name: 'input', type: 'image_ref' as const, required: true }],
      bindings: [{ nodeId: '1', inputPath: 'image', variable: 'input', valueType: 'image_ref' as const, transform: 'filename' as const }],
      outputs: [
        { name: 'primary', nodeId: '2', fieldPath: 'images', mediaType: 'image' as const, primary: true },
        { name: 'preview', nodeId: '3', fieldPath: 'images', mediaType: 'image' as const, primary: false },
      ],
    },
    ...overrides,
  }
}

function output(name: string, primary: boolean): ComfyOutputRef {
  return { name, nodeId: primary ? '2' : '3', mediaType: 'image', primary,
    filename: `${name}.png`, subfolder: '', type: 'output' }
}

function dependencies(overrides: Partial<ComfyDispatcherDependencies> = {}): ComfyDispatcherDependencies {
  const ctx = context()
  return {
    loadContext: vi.fn().mockResolvedValue(ctx),
    recheckClaim: vi.fn().mockResolvedValue(true),
    heartbeat: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(true),
    transition: vi.fn().mockResolvedValue(true),
    persistSubmission: vi.fn().mockResolvedValue(true),
    persistProgress: vi.fn().mockResolvedValue(true),
    persistOutputRefs: vi.fn().mockResolvedValue(true),
    persistCompletedOutputs: vi.fn().mockResolvedValue(true),
    returnToWaiting: vi.fn().mockResolvedValue(true),
    markReconciling: vi.fn().mockResolvedValue(true),
    markFailed: vi.fn().mockResolvedValue(true),
    client: {
      uploadImage: vi.fn().mockResolvedValue({ name: 'uploaded.png', subfolder: 'waoowaoo/user-1/request-1', type: 'input' }),
      submitPrompt: vi.fn().mockResolvedValue({ promptId: 'prompt-1' }),
      watchPrompt: async function* () {
        yield { type: 'progress' as const, promptId: 'prompt-1', nodeId: '2', value: 1, max: 2 }
        yield { type: 'executing' as const, promptId: 'prompt-1', nodeId: null }
      },
      getHistory: vi.fn().mockResolvedValue({ outputs: {
        '2': { images: [{ filename: 'primary.png', subfolder: '', type: 'output' }] },
        '3': { images: [{ filename: 'preview.png', subfolder: '', type: 'output' }] },
      } }),
      getQueue: vi.fn().mockResolvedValue({ running: [], pending: [] }),
      downloadOutput: vi.fn().mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      deleteQueuedPrompt: vi.fn(), interruptPrompt: vi.fn(),
    },
    toFetchableUrl: vi.fn((value: string) => `http://storage.local${value}`),
    fetchInput: vi.fn().mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    uploadObject: vi.fn(async (_bytes, key) => key),
    resolveStoredUrl: vi.fn((key) => `/api/files/${key}`),
    randomId: vi.fn().mockReturnValueOnce('client-1').mockReturnValue('random-1'),
    signal: new AbortController().signal,
    leaseTtlMs: 30_000,
    ...overrides,
  }
}

describe('ComfyUI dispatcher contract', () => {
  it('uploads then renders, persists prompt immediately, tracks progress and transfers every output', async () => {
    const deps = dependencies()
    const result = await dispatchComfyRequest('request-1', deps)

    const uploadOrder = (deps.client.uploadImage as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    const submitOrder = (deps.client.submitPrompt as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    expect(uploadOrder).toBeLessThan(submitOrder)
    const graph = (deps.client.submitPrompt as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(graph['1'].inputs.image).toBe('uploaded.png')
    const submittedClientId = (deps.client.submitPrompt as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(deps.persistSubmission).toHaveBeenCalledWith(expect.objectContaining({
      promptId: 'prompt-1', clientId: submittedClientId,
    }))
    expect(deps.persistProgress).toHaveBeenCalledWith(expect.objectContaining({ value: 1, max: 2 }))
    expect(deps.persistOutputRefs).toHaveBeenCalledWith(expect.objectContaining({
      outputs: [output('primary', true), output('preview', false)],
    }))
    expect(deps.persistCompletedOutputs).toHaveBeenCalledWith(expect.objectContaining({
      outputs: [expect.objectContaining({ name: 'primary' }), expect.objectContaining({ name: 'preview' })],
    }))
    expect(result.outcome).toBe('completed')
    if (result.outcome !== 'completed') throw new Error('expected completion')
    expect(result.primary.name).toBe('primary')
  })

  it('retries storage transfer from persisted Comfy refs without resubmitting', async () => {
    const refs = [output('primary', true), output('preview', false)]
    const deps = dependencies({
      loadContext: vi.fn().mockResolvedValue(context({ request: {
        ...context().request, status: 'transferring', promptId: 'prompt-1', clientId: 'client-1', outputRefs: refs,
      } })),
    })
    await dispatchComfyRequest('request-1', deps)
    expect(deps.client.submitPrompt).not.toHaveBeenCalled()
    expect(deps.client.downloadOutput).toHaveBeenCalledTimes(2)
  })

  it('returns to capacity on pre-submit failure but pins a persisted prompt for reconciliation', async () => {
    const pre = dependencies({ client: { ...dependencies().client, submitPrompt: vi.fn().mockRejectedValue(new Error('offline')) } })
    await expect(dispatchComfyRequest('request-1', pre)).resolves.toMatchObject({ outcome: 'waiting_capacity' })
    expect(pre.returnToWaiting).toHaveBeenCalled()
    expect(pre.release).toHaveBeenCalled()

    const post = dependencies({
      client: {
        ...dependencies().client,
        watchPrompt: async function* () { throw new Error('socket lost') },
        getHistory: vi.fn().mockRejectedValue(new Error('history unavailable')),
      },
    })
    await expect(dispatchComfyRequest('request-1', post)).resolves.toMatchObject({ outcome: 'reconciling' })
    expect(post.markReconciling).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: 'connection-1', promptId: 'prompt-1', leaseId: 'lease-1',
    }))
    expect(post.returnToWaiting).not.toHaveBeenCalled()
    expect(post.release).not.toHaveBeenCalled()
  })

  it('fails deterministic pre-submit errors instead of retrying another instance', async () => {
    const deps = dependencies({
      fetchInput: vi.fn().mockRejectedValue(new ComfyError(
        'COMFY_INPUT_UPLOAD_FAILED', 'invalid input', { retryable: false },
      )),
    })
    await expect(dispatchComfyRequest('request-1', deps)).resolves.toMatchObject({
      outcome: 'failed', code: 'COMFY_INPUT_UPLOAD_FAILED',
    })
    expect(deps.markFailed).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'COMFY_INPUT_UPLOAD_FAILED', errorMessage: 'ComfyUI operation failed',
    }))
    expect(deps.returnToWaiting).not.toHaveBeenCalled()
  })

  it('throttles non-reentrant heartbeats to TTL/3 and releases only terminal outcomes', async () => {
    let resolveHeartbeat!: (value: boolean) => void
    const heartbeat = vi.fn().mockImplementation(() => new Promise<boolean>((resolve) => { resolveHeartbeat = resolve }))
    const deps = dependencies({ heartbeat, leaseTtlMs: 90, heartbeatTickMs: 5 })
    const pending = dispatchComfyRequest('request-1', deps)
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(heartbeat).toHaveBeenCalledTimes(1)
    resolveHeartbeat(true)
    await pending
    expect(deps.release).toHaveBeenCalledTimes(1)
  })

  it('falls back to history when WebSocket ends without a terminal event', async () => {
    const deps = dependencies({
      client: { ...dependencies().client, watchPrompt: async function* () {} },
    })
    await expect(dispatchComfyRequest('request-1', deps)).resolves.toMatchObject({ outcome: 'completed' })
    expect(deps.client.getHistory).toHaveBeenCalledWith('prompt-1')
  })

  it('falls back to history after a WebSocket transport failure', async () => {
    const deps = dependencies({
      client: { ...dependencies().client, watchPrompt: async function* () { throw new Error('socket lost') } },
    })
    await expect(dispatchComfyRequest('request-1', deps)).resolves.toMatchObject({ outcome: 'completed' })
    expect(deps.markReconciling).not.toHaveBeenCalled()
  })

  it('marks an explicit Comfy execution error terminal instead of reconciling forever', async () => {
    const deps = dependencies({
      client: { ...dependencies().client, watchPrompt: async function* () {
        yield { type: 'execution_error' as const, promptId: 'prompt-1', message: 'safe failure' }
      } },
    })
    await expect(dispatchComfyRequest('request-1', deps)).resolves.toMatchObject({
      outcome: 'failed', code: 'COMFY_EXECUTION_FAILED',
    })
    expect(deps.markFailed).toHaveBeenCalledWith(expect.objectContaining({
      promptId: 'prompt-1', errorCode: 'COMFY_EXECUTION_FAILED',
    }))
    expect(deps.markReconciling).not.toHaveBeenCalled()
    expect(deps.release).toHaveBeenCalled()
  })

  it('reconciles when WebSocket completes before history becomes visible', async () => {
    const deps = dependencies({
      client: { ...dependencies().client, getHistory: vi.fn().mockResolvedValue({}) },
    })
    await expect(dispatchComfyRequest('request-1', deps)).resolves.toMatchObject({ outcome: 'reconciling' })
    expect(deps.markFailed).not.toHaveBeenCalled()
  })

  it('uses detected MIME and extension and rejects oversized inputs before upload', async () => {
    const deps = dependencies()
    await expect(prepareComfyMediaUploads({
      userId: 'user-1', requestId: 'request-1',
      variables: { input: { storageKey: 'source' } },
      definitions: [{ name: 'input', type: 'image_ref', required: true }],
      client: deps.client, dependencies: deps,
      maxInputBytes: 4,
    })).rejects.toMatchObject({ code: 'COMFY_INPUT_UPLOAD_FAILED' })
    expect(deps.client.uploadImage).not.toHaveBeenCalled()

    await dispatchComfyRequest('request-1', dependencies())
    expect(deps.uploadObject).not.toHaveBeenCalled()
    const completed = dependencies()
    await dispatchComfyRequest('request-1', completed)
    expect(completed.uploadObject).toHaveBeenCalledWith(
      expect.any(Buffer), expect.stringMatching(/\.png$/), 1, 'image/png',
    )
    const outputKeys = (completed.uploadObject as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1])
    expect(new Set(outputKeys).size).toBe(2)
  })
})
