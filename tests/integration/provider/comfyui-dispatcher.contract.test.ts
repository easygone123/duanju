import { describe, expect, it, vi } from 'vitest'

import { dispatchComfyRequest, type ComfyDispatcherDependencies } from '@/lib/comfyui/dispatcher'
import { ComfyError } from '@/lib/comfyui/errors'
import { createComfyObservability } from '@/lib/comfyui/observability'
import { prepareComfyMediaUploads, transferComfyOutputs } from '@/lib/comfyui/media'
import type { ComfyOutputRef, ComfyStoredOutputRef } from '@/lib/comfyui/types'

function context(overrides: Record<string, unknown> = {}) {
  return {
    request: {
      id: 'request-1', taskId: 'task-1', invocationKey: 'invoke-1', userId: 'user-1',
      projectId: 'project-1', mediaType: 'image' as const, workflowId: 'workflow-1',
      workflowVersionId: 'version-1', variableSnapshot: {
        input: { storageKey: 'users/user-1/source.png', mimeType: 'image/png', filename: 'source.png' },
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
    recordNumericDiagnostics: vi.fn().mockResolvedValue(true),
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
    preSubmitGate: vi.fn().mockResolvedValue('ready'),
    blockIncompatible: vi.fn().mockResolvedValue(true),
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
      deleteQueuedPrompt: vi.fn(),
    },
    readOwnedObject: vi.fn().mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    resolveOwnedMedia: vi.fn().mockResolvedValue(true),
    uploadObject: vi.fn(async (_bytes, key) => key),
    objectExists: vi.fn().mockResolvedValue(false),
    resolveStoredUrl: vi.fn((key) => `/api/files/${key}`),
    randomId: vi.fn().mockReturnValueOnce('client-1').mockReturnValue('random-1'),
    signal: new AbortController().signal,
    leaseTtlMs: 30_000,
    ...overrides,
  }
}

function frameDurationContext() {
  return context({
    request: {
      ...context().request,
      variableSnapshot: { duration: 5 },
    },
    version: {
      ...context().version,
      graph: {
        '1': { class_type: 'VideoNode', inputs: { length: 81 } },
        '2': { class_type: 'PreviewImage', inputs: { images: ['1', 0] } },
      },
      variableDefinitions: [
        { name: 'duration', type: 'number' as const, required: true },
        { name: 'fps', type: 'number' as const, required: false, defaultValue: 16 },
      ],
      bindings: [{
        nodeId: '1', inputPath: 'length', variable: 'duration', valueType: 'number' as const,
        numericTransform: {
          sourceUnit: 'seconds' as const, targetUnit: 'frames' as const, output: 'number' as const,
          fps: { source: 'runtime_then_fallback' as const, variable: 'fps' as const, fallback: 16 },
          rounding: 'round' as const, frameOffset: 1 as const,
        },
      }],
      outputs: [{
        name: 'primary', nodeId: '2', fieldPath: 'images', mediaType: 'image' as const, primary: true,
      }],
    },
  })
}

describe('ComfyUI dispatcher contract', () => {
  it('persists duration conversion before prompt submission', async () => {
    const recordNumericDiagnostics = vi.fn().mockResolvedValue(true)
    const deps = dependencies({
      loadContext: vi.fn().mockResolvedValue(frameDurationContext()),
      recordNumericDiagnostics,
    })

    await dispatchComfyRequest('request-1', deps)

    expect(recordNumericDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-1', userId: 'user-1', projectId: 'project-1',
        connectionId: 'connection-1', leaseId: 'lease-1',
      }),
      [expect.objectContaining({
        variable: 'duration', sourceValue: 5, effectiveFps: 16, targetValue: 81,
      })],
    )
    const persistOrder = recordNumericDiagnostics.mock.invocationCallOrder[0]!
    const submitOrder = (deps.client.submitPrompt as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
    expect(persistOrder).toBeLessThan(submitOrder)
  })

  it('does not submit when numeric diagnostics persistence loses ownership', async () => {
    const deps = dependencies({
      loadContext: vi.fn().mockResolvedValue(frameDurationContext()),
      recordNumericDiagnostics: vi.fn().mockResolvedValue(false),
      returnToWaiting: vi.fn().mockResolvedValue(false),
    })

    await expect(dispatchComfyRequest('request-1', deps)).resolves.toMatchObject({
      outcome: 'reconciling', promptId: '',
    })
    expect(deps.client.submitPrompt).not.toHaveBeenCalled()
    expect(deps.claimSubmissionFence).not.toHaveBeenCalled()
    expect(deps.release).not.toHaveBeenCalled()
  })

  it('keeps an accepted running cancellation reconciling without releasing its durable lease', async () => {
    const deps = dependencies({ cancelIfRequested: vi.fn().mockResolvedValue('reconciling') })
    await expect(dispatchComfyRequest('request-1', deps)).resolves.toEqual({
      outcome: 'reconciling', promptId: 'prompt-1',
    })
    expect(deps.persistOutputRefs).not.toHaveBeenCalled()
    expect(deps.release).not.toHaveBeenCalled()
  })

  it('uploads then renders, persists prompt immediately, tracks progress and transfers every output', async () => {
    const deps = dependencies()
    const result = await dispatchComfyRequest('request-1', deps)

    const uploadOrder = (deps.client.uploadImage as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    const submitOrder = (deps.client.submitPrompt as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    expect(uploadOrder).toBeLessThan(submitOrder)
    const graph = (deps.client.submitPrompt as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(graph['1'].inputs.image).toBe('uploaded.png')
    const submittedClientId = (deps.client.submitPrompt as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(deps.claimSubmissionFence).toHaveBeenCalledWith(expect.objectContaining({
      clientId: submittedClientId,
    }))
    expect(deps.recordAcceptedPrompt).toHaveBeenCalledWith(expect.objectContaining({
      promptId: 'prompt-1', clientId: submittedClientId, attemptId: 'attempt-1',
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
    const pre = dependencies({
      client: { ...dependencies().client, uploadImage: vi.fn().mockRejectedValue(new Error('offline')) },
    })
    await expect(dispatchComfyRequest('request-1', pre)).resolves.toMatchObject({ outcome: 'waiting_capacity' })
    expect(pre.returnToWaiting).toHaveBeenCalled()
    expect(pre.release).toHaveBeenCalled()

    const uncertainSubmit = dependencies({
      client: { ...dependencies().client, submitPrompt: vi.fn().mockRejectedValue(new Error('response lost')) },
    })
    await expect(dispatchComfyRequest('request-1', uncertainSubmit)).resolves.toMatchObject({
      outcome: 'reconciling', promptId: '',
    })
    expect(uncertainSubmit.returnToWaiting).not.toHaveBeenCalled()
    expect(uncertainSubmit.release).not.toHaveBeenCalled()

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

  it('never submits when cancellation wins the atomic submission fence', async () => {
    const deps = dependencies({
      claimSubmissionFence: vi.fn().mockResolvedValue({ outcome: 'canceled' }),
    })
    await expect(dispatchComfyRequest('request-1', deps)).resolves.toMatchObject({ outcome: 'canceled' })
    expect(deps.client.submitPrompt).not.toHaveBeenCalled()
    expect(deps.returnToWaiting).not.toHaveBeenCalled()
  })

  it('does not submit when fresh pre-submit queue state becomes externally busy', async () => {
    const deps = dependencies({
      preSubmitGate: vi.fn().mockResolvedValue('external_busy'),
    })

    await expect(dispatchComfyRequest('request-1', deps)).resolves.toMatchObject({
      outcome: 'waiting_capacity',
    })
    expect(deps.client.submitPrompt).not.toHaveBeenCalled()
    expect(deps.claimSubmissionFence).not.toHaveBeenCalled()
    expect(deps.returnToWaiting).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'request-1', connectionId: 'connection-1', leaseId: 'lease-1',
    }))
    expect(deps.release).toHaveBeenCalledOnce()
  })

  it('returns safely to capacity without POST when the connection is disabled pre-submit', async () => {
    const deps = dependencies({ preSubmitGate: vi.fn().mockResolvedValue('disabled') })
    await expect(dispatchComfyRequest('request-1', deps)).resolves.toMatchObject({
      outcome: 'waiting_capacity',
    })
    expect(deps.client.submitPrompt).not.toHaveBeenCalled()
    expect(deps.claimSubmissionFence).not.toHaveBeenCalled()
    expect(deps.returnToWaiting).toHaveBeenCalledOnce()
    expect(deps.release).toHaveBeenCalledOnce()
  })

  it('lets already-fenced output transfer finish after future assignments are disabled', async () => {
    const refs = [output('primary', true)]
    const deps = dependencies({
      loadContext: vi.fn().mockResolvedValue(context({
        connection: { id: 'connection-1', userId: 'user-1', enabled: false },
        request: {
          ...context().request, status: 'transferring', promptId: 'prompt-1',
          clientId: 'client-1', outputRefs: refs,
        },
      })),
    })
    await expect(dispatchComfyRequest('request-1', deps)).resolves.toMatchObject({ outcome: 'completed' })
    expect(deps.client.submitPrompt).not.toHaveBeenCalled()
    expect(deps.persistCompletedOutputs).toHaveBeenCalledOnce()
  })

  it('does not submit when fresh capability state makes the pinned workflow incompatible', async () => {
    const deps = dependencies({
      preSubmitGate: vi.fn().mockResolvedValue('incompatible'),
    })

    await expect(dispatchComfyRequest('request-1', deps)).resolves.toMatchObject({
      outcome: 'blocked_no_compatible_instance',
    })
    expect(deps.client.submitPrompt).not.toHaveBeenCalled()
    expect(deps.claimSubmissionFence).not.toHaveBeenCalled()
    expect(deps.blockIncompatible).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'request-1', connectionId: 'connection-1', leaseId: 'lease-1',
    }))
    expect(deps.release).toHaveBeenCalledOnce()
  })

  it('returns to capacity with a stable auth code when the fresh gate cannot authenticate', async () => {
    const deps = dependencies({
      preSubmitGate: vi.fn().mockRejectedValue(new ComfyError(
        'COMFY_AUTH_FAILED', 'Authentication failed', { retryable: false },
      )),
    })

    await expect(dispatchComfyRequest('request-1', deps)).resolves.toMatchObject({
      outcome: 'waiting_capacity',
    })
    expect(deps.client.submitPrompt).not.toHaveBeenCalled()
    expect(deps.returnToWaiting).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'COMFY_AUTH_FAILED',
    }))
    expect(deps.release).toHaveBeenCalledOnce()
  })

  it('keeps an accepted prompt recoverable when request ownership changes after POST', async () => {
    const deps = dependencies({
      recordAcceptedPrompt: vi.fn().mockResolvedValue({ outcome: 'attempt_recorded' }),
    })
    await expect(dispatchComfyRequest('request-1', deps)).resolves.toMatchObject({ outcome: 'reconciling' })
    expect(deps.markReconciling).not.toHaveBeenCalled()
    expect(deps.returnToWaiting).not.toHaveBeenCalled()
    expect(deps.release).not.toHaveBeenCalled()
  })

  it('fails deterministic pre-submit errors instead of retrying another instance', async () => {
    const deps = dependencies({
      readOwnedObject: vi.fn().mockRejectedValue(new ComfyError(
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

  it('captures a rejected heartbeat and propagates it without an unhandled rejection', async () => {
    const failure = new Error('heartbeat transport failed')
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const deps = dependencies({ heartbeat: vi.fn().mockRejectedValue(failure) })
    try {
      await expect(dispatchComfyRequest('request-1', deps)).resolves.toMatchObject({
        outcome: 'waiting_capacity',
      })
      await new Promise((resolve) => setImmediate(resolve))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('clamps an oversized heartbeat tick below TTL while staying non-reentrant', async () => {
    const heartbeat = vi.fn().mockResolvedValue(true)
    const deps = dependencies({
      heartbeat, leaseTtlMs: 60, heartbeatTickMs: 10_000,
      client: { ...dependencies().client, watchPrompt: async function* () {
        await new Promise((resolve) => setTimeout(resolve, 55))
        yield { type: 'executing' as const, promptId: 'prompt-1', nodeId: null }
      } },
    })
    await dispatchComfyRequest('request-1', deps)
    expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(heartbeat.mock.calls.length).toBeLessThan(8)
  })

  it('falls back to history when WebSocket ends without a terminal event', async () => {
    const deps = dependencies({
      client: { ...dependencies().client, watchPrompt: async function* () {} },
    })
    await expect(dispatchComfyRequest('request-1', deps)).resolves.toMatchObject({ outcome: 'completed' })
    expect(deps.client.getHistory).toHaveBeenCalledWith('prompt-1')
  })

  it('collects history immediately after the execution_success terminal event', async () => {
    const deps = dependencies({
      client: { ...dependencies().client, watchPrompt: async function* () {
        yield { type: 'execution_success' as const, promptId: 'prompt-1' }
      } },
    })

    await expect(dispatchComfyRequest('request-1', deps)).resolves.toMatchObject({ outcome: 'completed' })
    expect(deps.client.getHistory).toHaveBeenCalledWith('prompt-1')
    expect(deps.persistCompletedOutputs).toHaveBeenCalledOnce()
  })

  it('recovers completed history when WebSocket missed the terminal event but stays open', async () => {
    let releaseSocket!: () => void
    const socketGate = new Promise<void>((resolve) => { releaseSocket = resolve })
    const deps = dependencies({
      client: { ...dependencies().client, watchPrompt: async function* () {
        yield { type: 'status' as const, queueRemaining: 0 }
        await socketGate
      } },
    })
    const pending = dispatchComfyRequest('request-1', deps)

    try {
      await vi.waitFor(() => expect(deps.client.getHistory).toHaveBeenCalledWith('prompt-1'), {
        timeout: 100,
      })
    } finally {
      releaseSocket()
    }

    await expect(pending).resolves.toMatchObject({ outcome: 'completed' })
    expect(deps.persistCompletedOutputs).toHaveBeenCalledOnce()
    expect(deps.release).toHaveBeenCalledOnce()
  })

  it('actively polls completed history when a fast prompt finishes before any WebSocket event', async () => {
    vi.useFakeTimers()
    let socketAborted = false
    const deps = dependencies({
      client: { ...dependencies().client, watchPrompt: async function* (
        _promptId: string,
        _clientId: string,
        signal: AbortSignal,
      ) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            socketAborted = true
            resolve()
          }
          if (signal.aborted) finish()
          else signal.addEventListener('abort', finish, { once: true })
        })
      } },
    })

    try {
      const pending = dispatchComfyRequest('request-1', deps)
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(pending).resolves.toMatchObject({ outcome: 'completed' })
      expect(deps.client.getHistory).toHaveBeenCalledWith('prompt-1')
      expect(socketAborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps watching an accepted prompt when an opportunistic history probe fails', async () => {
    const getHistory = vi.fn()
      .mockRejectedValueOnce(new ComfyError(
        'COMFY_AUTH_FAILED', 'probe authentication failed', { retryable: false },
      ))
      .mockResolvedValueOnce({ outputs: {
        '2': { images: [{ filename: 'primary.png', subfolder: '', type: 'output' }] },
        '3': { images: [{ filename: 'preview.png', subfolder: '', type: 'output' }] },
      } })
    const deps = dependencies({
      client: { ...dependencies().client, getHistory, watchPrompt: async function* () {
        yield { type: 'status' as const, queueRemaining: 1 }
        yield { type: 'executing' as const, promptId: 'prompt-1', nodeId: null }
      } },
    })

    await expect(dispatchComfyRequest('request-1', deps)).resolves.toMatchObject({
      outcome: 'completed',
    })
    expect(getHistory).toHaveBeenCalledTimes(2)
    expect(deps.markFailed).not.toHaveBeenCalled()
    expect(deps.release).toHaveBeenCalledOnce()
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

  it('persists a stable terminal timeout and releases without interrupting ComfyUI', async () => {
    const controller = new AbortController()
    controller.abort()
    const dispose = vi.fn()
    const deps = dependencies({
      startExecutionTimeout: vi.fn(() => ({ signal: controller.signal, dispose })),
    })

    await expect(dispatchComfyRequest('request-1', deps)).resolves.toMatchObject({
      outcome: 'failed', code: 'COMFY_EXECUTION_TIMEOUT',
    })
    expect(deps.markFailed).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'COMFY_EXECUTION_TIMEOUT', promptId: 'prompt-1',
    }))
    expect(deps.release).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
    expect(deps.client).not.toHaveProperty('interruptPrompt')
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
      userId: 'user-1', projectId: 'project-1', requestId: 'request-1',
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

  it('applies runtime input and output byte limits inside dispatcher media transfer', async () => {
    const inputLimited = dependencies({ maxInputBytes: 4 })
    await expect(dispatchComfyRequest('request-1', inputLimited)).resolves.toMatchObject({
      outcome: 'failed', code: 'COMFY_INPUT_UPLOAD_FAILED',
    })
    expect(inputLimited.client.uploadImage).not.toHaveBeenCalled()

    const outputLimited = dependencies({ maxOutputBytes: 4 })
    await expect(dispatchComfyRequest('request-1', outputLimited)).resolves.toMatchObject({
      outcome: 'reconciling', promptId: 'prompt-1',
    })
    expect(outputLimited.persistCompletedOutputs).not.toHaveBeenCalled()
  })

  it('records execution duration and lease contention without sensitive labels', async () => {
    const metrics = { increment: vi.fn(), observe: vi.fn(), gauge: vi.fn() }
    const observation = createComfyObservability({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, metrics,
      context: { requestId: 'request-1', connectionId: 'connection-1' },
    })
    await dispatchComfyRequest('request-1', dependencies({ observation }))
    expect(metrics.observe).toHaveBeenCalledWith(
      'comfy.execution_duration_ms', expect.any(Number), { mediaType: 'image' },
    )

    const contended = dependencies({ observation, recheckClaim: vi.fn().mockResolvedValue(false) })
    await dispatchComfyRequest('request-1', contended)
    expect(metrics.increment).toHaveBeenCalledWith(
      'comfy.lease_contention', 1, { outcome: 'claim_recheck' },
    )
  })

  it('cancels transferring work without downloading or uploading outputs', async () => {
    const refs = [output('primary', true)]
    const deps = dependencies({
      loadContext: vi.fn().mockResolvedValue(context({ request: {
        ...context().request, status: 'transferring', promptId: 'prompt-1', clientId: 'client-1',
        outputRefs: refs, cancelRequestedAt: new Date(1),
      } })),
      cancelBeforeTransfer: vi.fn().mockResolvedValue(true),
    })
    await expect(dispatchComfyRequest('request-1', deps)).resolves.toMatchObject({ outcome: 'canceled' })
    expect(deps.cancelBeforeTransfer).toHaveBeenCalledWith(expect.objectContaining({
      promptId: 'prompt-1', outputs: refs,
    }))
    expect(deps.client.downloadOutput).not.toHaveBeenCalled()
    expect(deps.uploadObject).not.toHaveBeenCalled()
  })

  it('rejects URL-like media refs before any storage or network read', async () => {
    for (const storageKey of [
      'http://169.254.169.254/latest/meta-data', 'https://127.0.0.1/secret',
      'data:image/png;base64,AAAA', 'file:///etc/passwd', 'http://10.0.0.1/private',
      'http://192.168.1.2/private', 'http://[::1]/secret', 'http://[fc00::1]/private',
      '//metadata.google.internal/computeMetadata/v1',
    ]) {
      const deps = dependencies()
      await expect(prepareComfyMediaUploads({
        userId: 'user-1', projectId: 'project-1', requestId: 'request-1',
        variables: { input: { storageKey } },
        definitions: [{ name: 'input', type: 'image_ref', required: true }],
        client: deps.client, dependencies: deps,
      })).rejects.toMatchObject({ code: 'COMFY_INPUT_UPLOAD_FAILED' })
      expect(deps.resolveOwnedMedia).not.toHaveBeenCalled()
      expect(deps.readOwnedObject).not.toHaveBeenCalled()
      expect(deps.client.uploadImage).not.toHaveBeenCalled()
    }
  })

  it('resolves opaque legacy media ownership and type before storage reads', async () => {
    const owned = dependencies()
    await expect(prepareComfyMediaUploads({
      userId: 'user-1', projectId: 'project-1', requestId: 'request-1',
      variables: { input: { storageKey: 'images/owned.png' } },
      definitions: [{ name: 'input', type: 'image_ref', required: true }],
      client: owned.client, dependencies: owned,
    })).resolves.toMatchObject({ input: { name: 'uploaded.png' } })
    expect(owned.resolveOwnedMedia).toHaveBeenCalledWith({
      userId: 'user-1', projectId: 'project-1', storageKey: 'images/owned.png',
      mediaType: 'image',
    })

    for (const storageKey of ['images/cross-user.png', 'images/cross-project.png', 'images/unregistered.png']) {
      const rejected = dependencies({ resolveOwnedMedia: vi.fn().mockResolvedValue(false) })
      await expect(prepareComfyMediaUploads({
        userId: 'user-1', projectId: 'project-1', requestId: 'request-1',
        variables: { input: { storageKey } },
        definitions: [{ name: 'input', type: 'image_ref', required: true }],
        client: rejected.client, dependencies: rejected,
      })).rejects.toMatchObject({ code: 'COMFY_INPUT_UPLOAD_FAILED' })
      expect(rejected.readOwnedObject).not.toHaveBeenCalled()
      expect(rejected.client.uploadImage).not.toHaveBeenCalled()
    }
  })

  it('uploads Director audio lists with detected audio MIME and project ownership checks', async () => {
    const wav = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
      0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
    ])
    const deps = dependencies({ readOwnedObject: vi.fn().mockResolvedValue(wav) })
    await expect(prepareComfyMediaUploads({
      userId: 'user-1', projectId: 'project-1', requestId: 'request-1',
      variables: { directorAudios: [{ storageKey: 'novel-promotion/director/user-1/project-1/voice.wav' }] },
      definitions: [{
        name: 'directorAudios', type: 'audio_ref_list', required: false, defaultValue: [], maxItems: 8,
      }],
      client: deps.client,
      dependencies: deps,
    })).resolves.toMatchObject({ directorAudios: [{ name: 'uploaded.png' }] })
    expect(deps.resolveOwnedMedia).toHaveBeenCalledWith(expect.objectContaining({ mediaType: 'audio' }))
    expect(deps.client.uploadImage).toHaveBeenCalledWith(expect.objectContaining({
      contentType: 'audio/wav',
      filename: expect.stringMatching(/\.wav$/),
    }))
  })

  it('does not release when a terminal or failover DB write is not durable', async () => {
    const terminal = dependencies({
      readOwnedObject: vi.fn().mockRejectedValue(new ComfyError(
        'COMFY_INPUT_UPLOAD_FAILED', 'invalid input', { retryable: false },
      )),
      markFailed: vi.fn().mockResolvedValue(false),
    })
    await expect(dispatchComfyRequest('request-1', terminal)).resolves.toMatchObject({ outcome: 'reconciling' })
    expect(terminal.release).not.toHaveBeenCalled()

    const failover = dependencies({
      client: { ...dependencies().client, uploadImage: vi.fn().mockRejectedValue(new Error('offline')) },
      returnToWaiting: vi.fn().mockResolvedValue(false),
    })
    await expect(dispatchComfyRequest('request-1', failover)).resolves.toMatchObject({ outcome: 'reconciling' })
    expect(failover.release).not.toHaveBeenCalled()
  })

  it('bounds output count and cumulative bytes with stable transfer errors', async () => {
    const deps = dependencies()
    await expect(transferComfyOutputs({
      userId: 'user-1', projectId: 'project-1', requestId: 'request-1',
      outputs: Array.from({ length: 65 }, (_, index) => output(`out-${index}`, index === 0)),
      client: deps.client, dependencies: deps,
    })).rejects.toMatchObject({ code: 'COMFY_OUTPUT_TRANSFER_FAILED' })
    expect(deps.client.downloadOutput).not.toHaveBeenCalled()

    await expect(transferComfyOutputs({
      userId: 'user-1', projectId: 'project-1', requestId: 'request-1',
      outputs: [output('primary', true), output('second', false)],
      client: deps.client, dependencies: deps, maxTotalOutputBytes: 12,
    })).rejects.toMatchObject({ code: 'COMFY_OUTPUT_TRANSFER_FAILED' })
  })

  it('uses deterministic content-safe keys and skips durable output receipts on retry', async () => {
    const deps = dependencies()
    const first = await transferComfyOutputs({
      userId: 'user-1', projectId: 'project-1', requestId: 'request-1',
      outputs: [output('primary', true)], client: deps.client, dependencies: deps,
    })
    const key = first[0].storageKey
    expect(key).toMatch(/comfyui\/user-1\/project-1\/request-1\/[a-f0-9]{64}-primary\.png$/)
    expect(first[0].byteSize).toBe(8)

    const retry = dependencies()
    const repeated = await transferComfyOutputs({
      userId: 'user-1', projectId: 'project-1', requestId: 'request-1',
      outputs: [output('primary', true)], existingStored: first,
      client: retry.client, dependencies: retry,
    })
    expect(repeated).toEqual(first)
    expect(retry.client.downloadOutput).not.toHaveBeenCalled()
    expect(retry.uploadObject).not.toHaveBeenCalled()
  })

  it('counts durable receipt bytes before uploading new outputs', async () => {
    const downloaded = Buffer.alloc(200 * 1024 * 1024)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(downloaded)
    const deps = dependencies({
      client: {
        ...dependencies().client,
        downloadOutput: vi.fn().mockResolvedValue(downloaded),
      },
    })
    const existingStored = [{
      ...output('primary', true),
      storageKey: 'comfyui/user-1/project-1/request-1/primary.png',
      url: '/api/files/primary.png',
      byteSize: 400 * 1024 * 1024,
    }]

    await expect(transferComfyOutputs({
      userId: 'user-1', projectId: 'project-1', requestId: 'request-1',
      outputs: [output('primary', true), output('second', false)], existingStored,
      client: deps.client, dependencies: deps, maxOutputBytes: 500 * 1024 * 1024,
    })).rejects.toMatchObject({ code: 'COMFY_OUTPUT_TRANSFER_FAILED' })
    expect(deps.uploadObject).not.toHaveBeenCalled()
    expect(deps.objectExists).not.toHaveBeenCalled()
  })

  it('redownloads legacy stored outputs whose receipt has no trustworthy byte size', async () => {
    const deps = dependencies()
    const legacyStored = [{
      ...output('primary', true),
      storageKey: 'comfyui/user-1/project-1/request-1/primary.png',
      url: '/api/files/primary.png',
    }]

    const result = await transferComfyOutputs({
      userId: 'user-1', projectId: 'project-1', requestId: 'request-1',
      outputs: [output('primary', true)],
      existingStored: legacyStored as unknown as ComfyStoredOutputRef[],
      client: deps.client, dependencies: deps,
    })
    expect(deps.client.downloadOutput).toHaveBeenCalledOnce()
    expect(result[0].byteSize).toBe(8)
  })
})
