import { describe, expect, it, vi } from 'vitest'

import {
  cancelComfyRequest,
  claimComfySubmissionFenceWithStore,
  claimExpiredComfyRequestWithStore,
  findComfyPromptByClientId,
  reconcileComfyRequest,
  reclaimComfyRecoveryLease,
  recordComfyAttemptAbsenceWithStore,
  recordComfyAcceptedPromptWithStore,
  type ComfyCancellationDependencies,
  type ComfyReconciliationDependencies,
} from '@/lib/comfyui/dispatcher'

function reconciliationSafetyDefaults() {
  return {
    recordAttemptAbsence: vi.fn().mockResolvedValue({ outcome: 'reconciling', checkCount: 1 }),
    deleteQueuedPrompt: vi.fn(), interruptPrompt: vi.fn(),
    persistRecoveredCancellation: vi.fn().mockResolvedValue(true),
    persistRecoveredDiagnostics: vi.fn().mockResolvedValue(true),
    releaseLease: vi.fn().mockResolvedValue(true),
  }
}

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
      ...reconciliationSafetyDefaults(),
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

  it('persists unknown-submit absence checks across restart and fails only at the configured threshold', async () => {
    const attempt = {
      id: 'attempt-1', requestId: 'request-1', userId: 'user-1', connectionId: 'connection-1',
      clientId: 'client-1', createdAt: new Date(0), firstCheckedAt: null as Date | null,
      lastCheckedAt: null as Date | null, checkCount: 0, status: 'fenced',
      reconcileDeadlineAt: null as Date | null,
      request: { leaseId: 'lease-1', status: 'reconciling', cancelRequestedAt: null as Date | null },
    }
    const finishRequest = vi.fn(async () => ({ count: 1 }))
    const store: NonNullable<Parameters<typeof recordComfyAttemptAbsenceWithStore>[1]> = {
      transaction: async (operation) => operation({
        findAttempt: vi.fn(async () => ({ ...attempt, request: { ...attempt.request } })),
        recordCheck: vi.fn(async (value) => {
          const input = value as { where: { checkCount: number }; data: Record<string, unknown> }
          if (input.where.checkCount !== attempt.checkCount) return { count: 0 }
          Object.assign(attempt, input.data)
          return { count: 1 }
        }),
        finishRequest,
      }),
    }
    const input = {
      requestId: 'request-1', userId: 'user-1', connectionId: 'connection-1',
      leaseId: 'lease-1', attemptId: 'attempt-1', clientId: 'client-1',
      policy: { minChecks: 3, minAgeMs: 30_000, deadlineMs: 120_000 },
    }
    await expect(recordComfyAttemptAbsenceWithStore({ ...input, now: new Date(10_000) }, store))
      .resolves.toEqual({ outcome: 'reconciling', checkCount: 1 })
    await expect(recordComfyAttemptAbsenceWithStore({ ...input, now: new Date(20_000) }, store))
      .resolves.toEqual({ outcome: 'reconciling', checkCount: 2 })
    expect(finishRequest).not.toHaveBeenCalled()
    await expect(recordComfyAttemptAbsenceWithStore({ ...input, now: new Date(31_000) }, store))
      .resolves.toEqual({ outcome: 'failed', checkCount: 3 })
    expect(attempt.firstCheckedAt).toEqual(new Date(10_000))
    expect(attempt.reconcileDeadlineAt).toEqual(new Date(120_000))
    expect(attempt.checkCount).toBe(3)
    expect(finishRequest).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'failed', errorCode: 'COMFY_RECONCILIATION_REQUIRED' }),
    }))
  })

  it('recovers a cancellation after response loss by interrupting only the discovered owned prompt', async () => {
    const interruptPrompt = vi.fn()
    const persistRecoveredCancellation = vi.fn().mockResolvedValue(true)
    const releaseLease = vi.fn().mockResolvedValue(true)
    const verifyLeaseOwner = vi.fn().mockResolvedValue(true)
    const deps = {
      ...reconciliationSafetyDefaults(),
      loadContext: vi.fn().mockResolvedValue({
        request: {
          id: 'request-1', userId: 'user-1', status: 'reconciling',
          connectionId: 'connection-1', leaseId: 'recovery-lease', cancelRequestedAt: new Date(100),
          submissionAttempt: { id: 'attempt-1', clientId: 'client-1' },
        }, version: { outputs: [] },
      }),
      verifyLeaseOwner,
      findPromptByClientId: vi.fn().mockResolvedValue('prompt-1'),
      persistDiscoveredPrompt: vi.fn().mockResolvedValue(true),
      getHistory: vi.fn().mockResolvedValue({}),
      getQueue: vi.fn().mockResolvedValue({ running: [[0, 'prompt-1']], pending: [[0, 'manual']] }),
      persistRecoveredState: vi.fn(), interruptPrompt,
      deleteQueuedPrompt: vi.fn(), persistRecoveredCancellation, releaseLease,
    } satisfies ComfyReconciliationDependencies
    await expect(reconcileComfyRequest('request-1', deps)).resolves.toMatchObject({ outcome: 'canceled' })
    expect(interruptPrompt).toHaveBeenCalledWith('prompt-1')
    expect(verifyLeaseOwner).toHaveBeenCalledTimes(2)
    expect(persistRecoveredCancellation).toHaveBeenCalledWith(expect.objectContaining({
      promptId: 'prompt-1', leaseId: 'recovery-lease',
    }))
    expect(releaseLease).toHaveBeenCalled()
  })

  it('terminalizes an unknown canceled submission as canceled after the durable threshold', async () => {
    const finishRequest = vi.fn().mockResolvedValue({ count: 1 })
    const store: NonNullable<Parameters<typeof recordComfyAttemptAbsenceWithStore>[1]> = {
      transaction: async (operation) => operation({
        findAttempt: vi.fn().mockResolvedValue({
          id: 'attempt-1', requestId: 'request-1', userId: 'user-1',
          connectionId: 'connection-1', clientId: 'client-1', createdAt: new Date(0),
          firstCheckedAt: new Date(10_000), lastCheckedAt: new Date(20_000),
          reconcileDeadlineAt: new Date(120_000), checkCount: 2, status: 'checking_absence',
          request: { leaseId: 'lease-1', status: 'reconciling', cancelRequestedAt: new Date(5_000) },
        }),
        recordCheck: vi.fn().mockResolvedValue({ count: 1 }), finishRequest,
      }),
    }
    await expect(recordComfyAttemptAbsenceWithStore({
      requestId: 'request-1', userId: 'user-1', connectionId: 'connection-1',
      leaseId: 'lease-1', attemptId: 'attempt-1', clientId: 'client-1', now: new Date(31_000),
      policy: { minChecks: 3, minAgeMs: 30_000, deadlineMs: 120_000 },
    }, store)).resolves.toEqual({ outcome: 'canceled', checkCount: 3 })
    expect(finishRequest).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'canceled', canceledAt: new Date(31_000) }),
    }))
  })

  it('hard-stops at the durable deadline after a low-frequency restart even below minChecks', async () => {
    const finishRequest = vi.fn().mockResolvedValue({ count: 1 })
    const store: NonNullable<Parameters<typeof recordComfyAttemptAbsenceWithStore>[1]> = {
      transaction: async (operation) => operation({
        findAttempt: vi.fn().mockResolvedValue({
          id: 'attempt-1', requestId: 'request-1', userId: 'user-1', connectionId: 'connection-1',
          clientId: 'client-1', createdAt: new Date(0), firstCheckedAt: null,
          lastCheckedAt: null, reconcileDeadlineAt: new Date(100_000),
          checkCount: 0, status: 'checking_absence',
          request: { leaseId: 'lease-1', status: 'reconciling', cancelRequestedAt: null },
        }),
        recordCheck: vi.fn().mockResolvedValue({ count: 1 }), finishRequest,
      }),
    }
    await expect(recordComfyAttemptAbsenceWithStore({
      requestId: 'request-1', userId: 'user-1', connectionId: 'connection-1',
      leaseId: 'lease-1', attemptId: 'attempt-1', clientId: 'client-1', now: new Date(101_000),
      policy: { minChecks: 10, minAgeMs: 30_000, deadlineMs: 100_000 },
    }, store)).resolves.toEqual({ outcome: 'failed', checkCount: 1 })
    expect(finishRequest).toHaveBeenCalled()
  })

  it('cancels from completed history after queue miss while preserving declared refs only', async () => {
    const outputs = [{ name: 'result', nodeId: '2', fieldPath: 'images', mediaType: 'image' as const, primary: true }]
    const persistRecoveredDiagnostics = vi.fn().mockResolvedValue(true)
    const persistRecoveredCancellation = vi.fn().mockResolvedValue(true)
    const deps = {
      ...reconciliationSafetyDefaults(), persistRecoveredDiagnostics, persistRecoveredCancellation,
      loadContext: vi.fn().mockResolvedValue({ request: {
        id: 'request-1', userId: 'user-1', status: 'reconciling', connectionId: 'connection-1',
        leaseId: 'lease-1', promptId: 'prompt-1', cancelRequestedAt: new Date(1),
      }, version: { outputs } }),
      verifyLeaseOwner: vi.fn().mockResolvedValue(true),
      getQueue: vi.fn().mockResolvedValue({ running: [[0, 'manual']], pending: [] }),
      getHistory: vi.fn().mockResolvedValue({ outputs: {
        '2': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] },
      } }),
      persistRecoveredState: vi.fn(),
    } satisfies ComfyReconciliationDependencies
    await expect(reconcileComfyRequest('request-1', deps)).resolves.toMatchObject({ outcome: 'canceled' })
    expect(persistRecoveredDiagnostics).toHaveBeenCalledWith(expect.objectContaining({
      outputs: [expect.objectContaining({ filename: 'out.png', primary: true })],
    }))
    expect(persistRecoveredCancellation).toHaveBeenCalled()
    expect(deps.deleteQueuedPrompt).not.toHaveBeenCalled()
    expect(deps.interruptPrompt).not.toHaveBeenCalled()
  })

  it('cancels explicit history failure with only a safe diagnostic code', async () => {
    const persistRecoveredDiagnostics = vi.fn().mockResolvedValue(true)
    const deps = {
      ...reconciliationSafetyDefaults(), persistRecoveredDiagnostics,
      loadContext: vi.fn().mockResolvedValue({ request: {
        id: 'request-1', userId: 'user-1', status: 'reconciling', connectionId: 'connection-1',
        leaseId: 'lease-1', promptId: 'prompt-1', cancelRequestedAt: new Date(1),
      }, version: { outputs: [] } }),
      verifyLeaseOwner: vi.fn().mockResolvedValue(true),
      getQueue: vi.fn().mockResolvedValue({ running: [], pending: [] }),
      getHistory: vi.fn().mockResolvedValue({ 'prompt-1': {
        status: { status_str: 'error', messages: [['execution_error', { message: 'secret prompt' }]] },
      } }), persistRecoveredState: vi.fn(),
    } satisfies ComfyReconciliationDependencies
    await expect(reconcileComfyRequest('request-1', deps)).resolves.toMatchObject({ outcome: 'canceled' })
    expect(persistRecoveredDiagnostics).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'COMFY_EXECUTION_FAILED',
    }))
    expect(JSON.stringify(persistRecoveredDiagnostics.mock.calls)).not.toContain('secret prompt')
  })

  it('cancels completed history with missing or malformed declared outputs using only stable codes', async () => {
    const cases = [
      {
        outputs: [{ name: 'result', nodeId: '2', fieldPath: 'images', mediaType: 'image' as const, primary: true }],
        history: { outputs: { '2': { images: [] }, secret: 'raw-history-secret' } },
        code: 'COMFY_OUTPUT_MISSING',
      },
      {
        outputs: [],
        history: { outputs: { '2': { images: [{ filename: 'out.png' }] } }, secret: 'raw-history-secret' },
        code: 'COMFY_WORKFLOW_BINDING_INVALID',
      },
    ]
    for (const testCase of cases) {
      const persistRecoveredDiagnostics = vi.fn().mockResolvedValue(true)
      const persistRecoveredCancellation = vi.fn().mockResolvedValue(true)
      const releaseLease = vi.fn().mockResolvedValue(true)
      const deps = {
        ...reconciliationSafetyDefaults(),
        persistRecoveredDiagnostics, persistRecoveredCancellation, releaseLease,
        loadContext: vi.fn().mockResolvedValue({ request: {
          id: 'request-1', userId: 'user-1', status: 'reconciling', connectionId: 'connection-1',
          leaseId: 'lease-1', promptId: 'prompt-1', cancelRequestedAt: new Date(1),
        }, version: { outputs: testCase.outputs } }),
        verifyLeaseOwner: vi.fn().mockResolvedValue(true),
        getQueue: vi.fn().mockResolvedValue({ running: [], pending: [] }),
        getHistory: vi.fn().mockResolvedValue(testCase.history), persistRecoveredState: vi.fn(),
      } satisfies ComfyReconciliationDependencies
      await expect(reconcileComfyRequest('request-1', deps)).resolves.toMatchObject({ outcome: 'canceled' })
      expect(persistRecoveredDiagnostics).toHaveBeenCalledWith(expect.objectContaining({
        errorCode: testCase.code,
      }))
      expect(JSON.stringify(persistRecoveredDiagnostics.mock.calls)).not.toContain('raw-history-secret')
      expect(persistRecoveredCancellation).toHaveBeenCalled()
      expect(releaseLease).toHaveBeenCalled()
    }
  })

  it('keeps cancellation reconciling on an unknown output extraction exception without leaking it', async () => {
    const persistRecoveredDiagnostics = vi.fn()
    const deps = {
      ...reconciliationSafetyDefaults(), persistRecoveredDiagnostics,
      loadContext: vi.fn().mockResolvedValue({ request: {
        id: 'request-1', userId: 'user-1', status: 'reconciling', connectionId: 'connection-1',
        leaseId: 'lease-1', promptId: 'prompt-1', cancelRequestedAt: new Date(1),
      }, version: { outputs: null } }),
      verifyLeaseOwner: vi.fn().mockResolvedValue(true),
      getQueue: vi.fn().mockResolvedValue({ running: [], pending: [] }),
      getHistory: vi.fn().mockResolvedValue({ outputs: { secret: 'unknown-secret' } }),
      persistRecoveredState: vi.fn(),
    } as unknown as ComfyReconciliationDependencies
    await expect(reconcileComfyRequest('request-1', deps)).resolves.toEqual({ outcome: 'reconciling' })
    expect(persistRecoveredDiagnostics).not.toHaveBeenCalled()
  })

  it('never cancels external work or acts after recovery ownership is lost', async () => {
    for (const [queue, ownerResults] of [
      [{ running: [[0, 'manual']], pending: [] }, [true]],
      [{ running: [[0, 'prompt-1']], pending: [] }, [true, false]],
    ] as const) {
      const interruptPrompt = vi.fn()
      const deps = {
        ...reconciliationSafetyDefaults(),
        loadContext: vi.fn().mockResolvedValue({ request: {
          id: 'request-1', userId: 'user-1', status: 'reconciling', connectionId: 'connection-1',
          leaseId: 'lease-1', promptId: 'prompt-1', cancelRequestedAt: new Date(1),
        }, version: { outputs: [] } }),
        verifyLeaseOwner: vi.fn().mockResolvedValueOnce(ownerResults[0]).mockResolvedValueOnce(ownerResults[1]),
        getHistory: vi.fn().mockResolvedValue({}), getQueue: vi.fn().mockResolvedValue(queue),
        persistRecoveredState: vi.fn(), interruptPrompt, deleteQueuedPrompt: vi.fn(),
        persistRecoveredCancellation: vi.fn(), releaseLease: vi.fn(),
      } satisfies ComfyReconciliationDependencies
      const result = await reconcileComfyRequest('request-1', deps).catch((error) => error)
      expect(interruptPrompt).not.toHaveBeenCalled()
      expect(result).toBeTruthy()
    }
  })

  it('recovers a recorded prompt from history without resubmission', async () => {
    const deps: ComfyReconciliationDependencies = {
      ...reconciliationSafetyDefaults(),
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
        ...reconciliationSafetyDefaults(),
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
      ...reconciliationSafetyDefaults(),
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
      ...reconciliationSafetyDefaults(),
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
