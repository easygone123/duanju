import { describe, expect, it, vi } from 'vitest'

import {
  cancelComfyRequest,
  claimComfySubmissionFenceWithStore,
  claimExpiredComfyRequestWithStore,
  findComfyPromptByClientId,
  reconcileComfyRequest,
  reclaimComfyRecoveryLease,
  recordComfyAcceptedPromptWithStore,
  type ComfyCancellationDependencies,
  type ComfyReconciliationDependencies,
} from '@/lib/comfyui/dispatcher'

describe('ComfyUI recovery and cancellation contract', () => {
  it('atomically fences submission against cancellation and records the attempt before POST', async () => {
    const events: string[] = []
    const store: NonNullable<Parameters<typeof claimComfySubmissionFenceWithStore>[1]> = {
      transaction: async (operation) => operation({
        fenceRequest: vi.fn(async () => { events.push('fence-request'); return { count: 1 } }),
        createAttempt: vi.fn(async () => { events.push('create-attempt'); return {} }),
        findRequest: vi.fn(),
      }),
    }
    const result = await claimComfySubmissionFenceWithStore({
      requestId: 'request-1', userId: 'user-1', connectionId: 'connection-1', leaseId: 'lease-1',
      attemptId: 'attempt-1', clientId: 'client-1',
    }, store)
    expect(result).toEqual({ outcome: 'claimed', attemptId: 'attempt-1', clientId: 'client-1' })
    expect(events).toEqual(['fence-request', 'create-attempt'])
  })

  it('durably records accepted prompt on the attempt even if request owner CAS is lost', async () => {
    const events: string[] = []
    const updateAttempt = vi.fn(async () => { events.push('attempt'); return { count: 1 } })
    const updateRequest = vi.fn(async () => { events.push('request'); return { count: 0 } })
    const result = await recordComfyAcceptedPromptWithStore({
      requestId: 'request-1', userId: 'user-1', connectionId: 'connection-1', leaseId: 'lease-1',
      attemptId: 'attempt-1', clientId: 'client-1', promptId: 'prompt-1',
    }, { transaction: async (operation) => operation({ updateAttempt, updateRequest, findAttempt: vi.fn() }) })
    expect(result).toEqual({ outcome: 'attempt_recorded' })
    expect(events).toEqual(['attempt', 'request'])
  })

  it('reclaims an expired recorded submission on the same connection and never submits', async () => {
    const acquireLease = vi.fn().mockResolvedValue(true)
    const claimExpiredRequest = vi.fn().mockResolvedValue(true)
    const result = await reclaimComfyRecoveryLease({
      requestId: 'request-1', userId: 'user-1', connectionId: 'connection-1',
      previousLeaseId: 'expired-lease', newLeaseId: 'recovery-lease', ttlMs: 30_000,
      leaseExpiredAt: new Date(0), now: new Date(1000), hasSubmissionAttempt: true,
    }, { acquireLease, claimExpiredRequest, releaseLease: vi.fn() })
    expect(result).toMatchObject({ outcome: 'reclaimed', leaseId: 'recovery-lease' })
    expect(acquireLease).toHaveBeenCalled()
    expect(claimExpiredRequest).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: 'connection-1', previousLeaseId: 'expired-lease',
    }))
  })

  it('fails closed when another active request already owns the recovery connection', async () => {
    const claimRequest = vi.fn()
    const claimed = await claimExpiredComfyRequestWithStore({
      requestId: 'request-1', userId: 'user-1', connectionId: 'connection-1',
      previousLeaseId: 'expired-lease', newLeaseId: 'recovery-lease', ttlMs: 30_000,
      leaseExpiredAt: new Date(0), leaseExpiresAt: new Date(31_000),
      now: new Date(1000), hasSubmissionAttempt: true,
    }, { transaction: async (operation) => operation({
      countCompeting: vi.fn().mockResolvedValue(1), claimRequest,
    }) })
    expect(claimed).toBe(false)
    expect(claimRequest).not.toHaveBeenCalled()
  })

  it('discovers a running accepted prompt by durable client correlation and reconciles only', async () => {
    expect(findComfyPromptByClientId({
      running: [[0, 'prompt-1', {}, { client_id: 'client-1' }, []]], pending: [],
    }, {}, 'client-1')).toBe('prompt-1')
    const persistDiscoveredPrompt = vi.fn().mockResolvedValue(true)
    const deps = {
      loadContext: vi.fn().mockResolvedValue({
        request: {
          id: 'request-1', userId: 'user-1', status: 'reconciling',
          connectionId: 'connection-1', leaseId: 'recovery-lease',
          submissionAttempt: { id: 'attempt-1', clientId: 'client-1' },
        },
        version: { outputs: [] },
      }),
      verifyLeaseOwner: vi.fn().mockResolvedValue(true),
      findPromptByClientId: vi.fn().mockResolvedValue('prompt-1'),
      persistDiscoveredPrompt,
      getQueue: vi.fn().mockResolvedValue({
        running: [[0, 'prompt-1', {}, { client_id: 'client-1' }, []]], pending: [],
      }),
      getHistory: vi.fn().mockResolvedValue({}),
      persistRecoveredState: vi.fn().mockResolvedValue(true),
    } satisfies ComfyReconciliationDependencies
    await expect(reconcileComfyRequest('request-1', deps)).resolves.toMatchObject({ outcome: 'running' })
    expect(persistDiscoveredPrompt).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 'attempt-1', promptId: 'prompt-1', leaseId: 'recovery-lease',
    }))
  })

  it('recovers a recorded prompt from history without resubmission', async () => {
    const deps: ComfyReconciliationDependencies = {
      loadContext: vi.fn().mockResolvedValue({
        request: { id: 'request-1', userId: 'user-1', status: 'reconciling', connectionId: 'connection-1', leaseId: 'lease-1', promptId: 'prompt-1' },
        version: { outputs: [{ name: 'result', nodeId: '2', fieldPath: 'images', mediaType: 'image', primary: true }] },
      }),
      verifyLeaseOwner: vi.fn().mockResolvedValue(true),
      getQueue: vi.fn().mockResolvedValue({ running: [], pending: [] }),
      getHistory: vi.fn().mockResolvedValue({ outputs: { '2': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } }),
      persistRecoveredState: vi.fn().mockResolvedValue(true),
    }
    const result = await reconcileComfyRequest('request-1', deps)
    expect(result).toMatchObject({ outcome: 'transferring' })
    expect(deps.persistRecoveredState).toHaveBeenCalledWith(expect.objectContaining({
      promptId: 'prompt-1', status: 'transferring', outputs: [expect.objectContaining({ filename: 'out.png' })],
    }))
  })

  it('recovers queued and running state by matching the recorded prompt only', async () => {
    for (const [queue, status] of [
      [{ running: [], pending: [[0, 'prompt-1', {}, {}, []]] }, 'submitted'],
      [{ running: [[0, 'prompt-1', {}, {}, []]], pending: [['x', 'manual-prompt']] }, 'running'],
    ] as const) {
      const persistRecoveredState = vi.fn().mockResolvedValue(true)
      const deps = {
        loadContext: vi.fn().mockResolvedValue({ request: { id: 'request-1', userId: 'user-1', status: 'reconciling', connectionId: 'connection-1', leaseId: 'lease-1', promptId: 'prompt-1' }, version: { outputs: [] } }),
        verifyLeaseOwner: vi.fn().mockResolvedValue(true), getQueue: vi.fn().mockResolvedValue(queue),
        getHistory: vi.fn().mockResolvedValue({}), persistRecoveredState,
      } satisfies ComfyReconciliationDependencies
      await expect(reconcileComfyRequest('request-1', deps)).resolves.toMatchObject({ outcome: status })
    }
  })

  it('marks an explicit history execution error failed with a stable code', async () => {
    const persistRecoveredState = vi.fn().mockResolvedValue(true)
    const deps = {
      loadContext: vi.fn().mockResolvedValue({ request: { id: 'request-1', userId: 'user-1', status: 'reconciling', connectionId: 'connection-1', leaseId: 'lease-1', promptId: 'prompt-1' }, version: { outputs: [] } }),
      verifyLeaseOwner: vi.fn().mockResolvedValue(true), getQueue: vi.fn(),
      getHistory: vi.fn().mockResolvedValue({ 'prompt-1': { status: { status_str: 'error' } } }),
      persistRecoveredState,
    } satisfies ComfyReconciliationDependencies
    await expect(reconcileComfyRequest('request-1', deps)).resolves.toMatchObject({ outcome: 'failed' })
    expect(persistRecoveredState).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed', errorCode: 'COMFY_EXECUTION_FAILED',
    }))
  })

  it('does not declare a missing prompt failed until absence is conclusive', async () => {
    const persistRecoveredState = vi.fn().mockResolvedValue(true)
    const base = {
      loadContext: vi.fn().mockResolvedValue({ request: { id: 'request-1', userId: 'user-1', status: 'reconciling', connectionId: 'connection-1', leaseId: 'lease-1', promptId: 'prompt-1' }, version: { outputs: [] } }),
      verifyLeaseOwner: vi.fn().mockResolvedValue(true),
      getQueue: vi.fn().mockResolvedValue({ running: [], pending: [] }),
      getHistory: vi.fn().mockResolvedValue({}), persistRecoveredState,
    }
    await expect(reconcileComfyRequest('request-1', base)).resolves.toMatchObject({ outcome: 'reconciling' })
    expect(persistRecoveredState).not.toHaveBeenCalled()

    await expect(reconcileComfyRequest('request-1', {
      ...base, isAbsenceConclusive: vi.fn().mockResolvedValue(true),
    })).resolves.toMatchObject({ outcome: 'failed' })
  })

  function cancellation(
    status: string,
    queue: { running: unknown[]; pending: unknown[] } = { running: [], pending: [] },
  ) {
    return {
      loadOwnedRequest: vi.fn().mockResolvedValue({ id: 'request-1', userId: 'user-1', status, connectionId: 'connection-1', leaseId: 'lease-1', promptId: status === 'submitted' || status === 'running' ? 'prompt-1' : undefined }),
      cancelLocal: vi.fn().mockResolvedValue(true), verifyLeaseOwner: vi.fn().mockResolvedValue(true),
      requestCancellation: vi.fn().mockResolvedValue(
        status === 'leased' || status === 'uploading' ? 'canceled' : 'requested',
      ),
      getQueue: vi.fn().mockResolvedValue(queue), deleteQueuedPrompt: vi.fn().mockResolvedValue(undefined),
      interruptPrompt: vi.fn().mockResolvedValue(undefined), release: vi.fn().mockResolvedValue(true),
      markCanceledOwned: vi.fn().mockResolvedValue(true),
    } satisfies ComfyCancellationDependencies
  }

  it('cancels waiting requests locally', async () => {
    const deps = cancellation('waiting_capacity')
    await cancelComfyRequest('request-1', 'user-1', deps)
    expect(deps.cancelLocal).toHaveBeenCalled()
    expect(deps.getQueue).not.toHaveBeenCalled()
  })

  it('cancels an uploading request before submission and owner-releases it', async () => {
    const deps = cancellation('uploading')
    await cancelComfyRequest('request-1', 'user-1', deps)
    expect(deps.getQueue).not.toHaveBeenCalled()
    expect(deps.requestCancellation).toHaveBeenCalledWith(expect.objectContaining({
      leaseId: 'lease-1', observedStatus: 'uploading',
    }))
    expect(deps.markCanceledOwned).not.toHaveBeenCalled()
    expect(deps.release).toHaveBeenCalled()
  })

  it('deletes only its queued prompt and interrupts only its running prompt', async () => {
    const queued = cancellation('submitted', { running: [['x', 'manual']], pending: [[0, 'prompt-1']] })
    await cancelComfyRequest('request-1', 'user-1', queued)
    expect(queued.deleteQueuedPrompt).toHaveBeenCalledWith('prompt-1')
    expect(queued.interruptPrompt).not.toHaveBeenCalled()

    const running = cancellation('running', { running: [[0, 'prompt-1']], pending: [[0, 'manual']] })
    await cancelComfyRequest('request-1', 'user-1', running)
    expect(running.interruptPrompt).toHaveBeenCalledWith('prompt-1')
    expect(running.deleteQueuedPrompt).not.toHaveBeenCalled()
  })

  it('never interrupts or deletes external work when prompt or lease ownership differs', async () => {
    const external = cancellation('running', { running: [[0, 'manual-prompt']], pending: [] })
    await cancelComfyRequest('request-1', 'user-1', external)
    expect(external.interruptPrompt).not.toHaveBeenCalled()
    expect(external.deleteQueuedPrompt).not.toHaveBeenCalled()

    const lost = cancellation('running', { running: [[0, 'prompt-1']], pending: [] })
    lost.verifyLeaseOwner.mockResolvedValue(false)
    await expect(cancelComfyRequest('request-1', 'user-1', lost)).rejects.toThrow()
    expect(lost.interruptPrompt).not.toHaveBeenCalled()
  })
})
