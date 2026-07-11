import { describe, expect, it, vi } from 'vitest'

import { createProductionComfyRuntimeDeps } from '@/lib/comfyui/runtime-deps'
import type { ComfyRuntimeConfig } from '@/lib/comfyui/runtime'

const config = {
  enabled: true,
  networkPolicy: { mode: 'allowlist' as const, allowedHosts: [], allowedCidrs: [] },
  healthIntervalMs: 1000, dispatchIntervalMs: 500, reconcileIntervalMs: 2000,
  leaseTtlMs: 30000, imageTimeoutMs: 300000, videoTimeoutMs: 1200000,
  workflowMaxBytes: 2097152, inputMaxBytes: 26214400, outputMaxBytes: 536870912,
  dispatchConcurrency: 8, pageSize: 100,
  failureBackoffBaseMs: 1000, failureBackoffMaxMs: 60000,
} satisfies ComfyRuntimeConfig

describe('production ComfyUI runtime dependency composition', () => {
  it('probes every enabled owner and reports idle capacity', async () => {
    const services = fixture()
    services.listHealthOwners.mockResolvedValue({
      items: [{ id: 'c1', userId: 'u1' }, { id: 'c2', userId: 'u2' }],
      nextCursor: null,
    })
    services.probeOwnerHealth
      .mockResolvedValueOnce([{ state: 'offline' }])
      .mockResolvedValueOnce([{ state: 'online_idle' }])
    const deps = createProductionComfyRuntimeDeps(services)

    await expect(deps.healthTick(new AbortController().signal, config))
      .resolves.toEqual({ idle: true })
    expect(services.probeOwnerHealth).toHaveBeenCalledTimes(2)
    expect(services.probeOwnerHealth).toHaveBeenCalledWith('u1', config)
  })

  it('schedules then dispatches each leased request with runtime limits', async () => {
    const services = fixture()
    services.listDispatchOwners.mockResolvedValue({
      items: [{ id: 'c1', userId: 'u1' }, { id: 'c2', userId: 'u2' }],
      nextCursor: null,
    })
    services.scheduleNext.mockResolvedValueOnce({
      outcome: 'leased', requestId: 'r1', connectionId: 'c1', leaseId: 'l1', mediaType: 'image',
    }).mockResolvedValueOnce({ outcome: 'empty' })
    const deps = createProductionComfyRuntimeDeps(services)

    await deps.dispatchTick(new AbortController().signal, config)

    expect(services.dispatch).toHaveBeenCalledWith('r1', expect.objectContaining({
      leaseTtlMs: config.leaseTtlMs,
      workflowMaxBytes: config.workflowMaxBytes,
      inputMaxBytes: config.inputMaxBytes,
      outputMaxBytes: config.outputMaxBytes,
      executionTimeoutMs: config.imageTimeoutMs,
    }), expect.any(AbortSignal))
    expect(services.scheduleNext).toHaveBeenCalledTimes(2)
  })

  it('bounds one dispatch cycle per owner and stops on abort', async () => {
    const services = fixture()
    services.listDispatchOwners.mockResolvedValue({
      items: [{ id: 'c1', userId: 'u1' }], nextCursor: null,
    })
    services.scheduleNext.mockResolvedValue({
      outcome: 'leased', requestId: 'r1', connectionId: 'c1', leaseId: 'l1', mediaType: 'image',
    })
    const controller = new AbortController()
    services.dispatch.mockImplementationOnce(async () => controller.abort())

    await createProductionComfyRuntimeDeps(services).dispatchTick(controller.signal, config)

    expect(services.scheduleNext).toHaveBeenCalledOnce()
    expect(services.dispatch).toHaveBeenCalledOnce()
  })

  it('uses multiple idle connections without waiting for the first execution to finish', async () => {
    const services = fixture()
    const first = Promise.withResolvers<void>()
    services.listDispatchOwners.mockResolvedValue({
      items: [{ id: 'c1', userId: 'u1' }, { id: 'c2', userId: 'u2' }],
      nextCursor: null,
    })
    services.scheduleNext
      .mockResolvedValueOnce({
        outcome: 'leased', requestId: 'r1', connectionId: 'c1', leaseId: 'l1', mediaType: 'image',
      })
      .mockResolvedValueOnce({
        outcome: 'leased', requestId: 'r2', connectionId: 'c2', leaseId: 'l2', mediaType: 'video',
      })
    services.dispatch.mockReturnValueOnce(first.promise).mockResolvedValueOnce(undefined)

    const tick = createProductionComfyRuntimeDeps(services)
      .dispatchTick(new AbortController().signal, config)
    await vi.waitFor(() => expect(services.dispatch).toHaveBeenCalledTimes(2))
    expect(services.dispatch).toHaveBeenNthCalledWith(
      2, 'r2', expect.objectContaining({ executionTimeoutMs: config.videoTimeoutMs }),
      expect.any(AbortSignal),
    )
    first.resolve()
    await tick
  })

  it('reconciles active requests and delegates the Task 8 recovery scan', async () => {
    const services = fixture()
    services.listReconcileRequests.mockResolvedValue({
      items: [
        { requestId: 'image-r', mediaType: 'image' },
        { requestId: 'video-r', mediaType: 'video' },
      ],
      nextCursor: null,
    })
    const deps = createProductionComfyRuntimeDeps(services)
    const signal = new AbortController().signal

    await deps.reconcileTick(signal, config)
    await deps.preSubmitRecoveryTick(signal, config)

    expect(services.reconcile).toHaveBeenNthCalledWith(1, 'image-r', expect.objectContaining({
      executionTimeoutMs: config.imageTimeoutMs,
    }), signal)
    expect(services.reconcile).toHaveBeenNthCalledWith(2, 'video-r', expect.objectContaining({
      executionTimeoutMs: config.videoTimeoutMs,
    }), signal)
    expect(services.scanExpiredPreSubmit).toHaveBeenCalledOnce()
  })

  it('advances stable connection pages across ticks, wraps at EOF, and de-duplicates owners', async () => {
    const services = fixture()
    services.listHealthOwners
      .mockResolvedValueOnce({
        items: Array.from({ length: 100 }, (_, index) => ({
          id: `c${String(index + 1).padStart(3, '0')}`,
          userId: index < 2 ? 'duplicate-owner' : `u${index}`,
        })),
        nextCursor: 'c100',
      })
      .mockResolvedValueOnce({
        items: [{ id: 'c100a', userId: 'u1' }, { id: 'c101', userId: 'u101' }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({ items: [{ id: 'c001', userId: 'duplicate-owner' }], nextCursor: 'c001' })
    const deps = createProductionComfyRuntimeDeps(services)
    const signal = new AbortController().signal

    await deps.healthTick(signal, config)
    expect(services.probeOwnerHealth).toHaveBeenCalledTimes(99)
    await deps.healthTick(signal, config)
    expect(services.probeOwnerHealth).toHaveBeenCalledWith('u101', config)
    await deps.healthTick(signal, config)

    expect(services.listHealthOwners).toHaveBeenNthCalledWith(1, { afterId: null, limit: 100 })
    expect(services.listHealthOwners).toHaveBeenNthCalledWith(2, { afterId: 'c100', limit: 100 })
    expect(services.listHealthOwners).toHaveBeenNthCalledWith(3, { afterId: null, limit: 100 })
  })

  it('round-robins dispatch owners by stable connection page and wraps after EOF', async () => {
    const services = fixture()
    services.listDispatchOwners
      .mockResolvedValueOnce({
        items: [{ id: 'c1', userId: 'u1' }, { id: 'c2', userId: 'u1' }, { id: 'c3', userId: 'u2' }],
        nextCursor: 'c3',
      })
      .mockResolvedValueOnce({
        items: [{ id: 'c100a', userId: 'u1' }, { id: 'c101', userId: 'u101' }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({ items: [{ id: 'c1', userId: 'u1' }], nextCursor: 'c1' })
    const deps = createProductionComfyRuntimeDeps(services)
    const signal = new AbortController().signal

    await deps.dispatchTick(signal, config)
    expect(services.scheduleNext.mock.calls.map(([owner]) => owner)).toEqual(['u1', 'u2'])
    await deps.dispatchTick(signal, config)
    expect(services.scheduleNext.mock.calls.map(([owner]) => owner))
      .toEqual(['u1', 'u2', 'u101'])
    await deps.dispatchTick(signal, config)

    expect(services.listDispatchOwners).toHaveBeenNthCalledWith(2, { afterId: 'c3', limit: 100 })
    expect(services.listDispatchOwners).toHaveBeenNthCalledWith(3, { afterId: null, limit: 100 })
  })

  it('advances reconciliation pages even when a page has no recoverable Redis candidates', async () => {
    const services = fixture()
    services.listReconcileRequests
      .mockResolvedValueOnce({ items: [], nextCursor: 'r100' })
      .mockResolvedValueOnce({
        items: [{ requestId: 'r101', mediaType: 'image' }], nextCursor: null,
      })
      .mockResolvedValueOnce({
        items: [{ requestId: 'r001', mediaType: 'video' }], nextCursor: 'r001',
      })
    const deps = createProductionComfyRuntimeDeps(services)
    const signal = new AbortController().signal

    await deps.reconcileTick(signal, config)
    expect(services.reconcile).not.toHaveBeenCalled()
    await deps.reconcileTick(signal, config)
    expect(services.reconcile).toHaveBeenCalledWith(
      'r101', expect.any(Object), signal,
    )
    await deps.reconcileTick(signal, config)

    expect(services.listReconcileRequests).toHaveBeenNthCalledWith(1, {
      afterId: null, limit: 100, now: expect.any(Date),
    })
    expect(services.listReconcileRequests).toHaveBeenNthCalledWith(2, {
      afterId: 'r100', limit: 100, now: expect.any(Date),
    })
    expect(services.listReconcileRequests).toHaveBeenNthCalledWith(3, {
      afterId: null, limit: 100, now: expect.any(Date),
    })
  })

  it('continues reconciliation after the first candidate fails', async () => {
    const services = fixture()
    services.listReconcileRequests.mockResolvedValue({
      items: [
        { requestId: 'r1', mediaType: 'image' },
        { requestId: 'r2', mediaType: 'video' },
      ],
      nextCursor: null,
    })
    services.reconcile.mockRejectedValueOnce(new Error('first failed')).mockResolvedValueOnce(undefined)

    await createProductionComfyRuntimeDeps(services)
      .reconcileTick(new AbortController().signal, config)

    expect(services.reconcile).toHaveBeenCalledTimes(2)
    expect(services.reconcile).toHaveBeenLastCalledWith(
      'r2', expect.objectContaining({ executionTimeoutMs: config.videoTimeoutMs }),
      expect.any(AbortSignal),
    )
  })

  it('keeps cursor state isolated per runtime dependency instance', async () => {
    const firstServices = fixture()
    const secondServices = fixture()
    firstServices.listDispatchOwners.mockResolvedValue({ items: [], nextCursor: 'c100' })
    secondServices.listDispatchOwners.mockResolvedValue({ items: [], nextCursor: 'c200' })
    const signal = new AbortController().signal

    await createProductionComfyRuntimeDeps(firstServices).dispatchTick(signal, config)
    await createProductionComfyRuntimeDeps(secondServices).dispatchTick(signal, config)

    expect(firstServices.listDispatchOwners).toHaveBeenCalledWith({ afterId: null, limit: 100 })
    expect(secondServices.listDispatchOwners).toHaveBeenCalledWith({ afterId: null, limit: 100 })
  })

  it('retains unvisited owners from a page when dispatch concurrency fills', async () => {
    const services = fixture()
    services.listDispatchOwners.mockResolvedValue({
      items: Array.from({ length: 10 }, (_, index) => ({
        id: `c${index + 1}`, userId: `u${index + 1}`,
      })),
      nextCursor: 'c10',
    })
    services.scheduleNext.mockImplementation(async (userId: string) => ({
      outcome: 'leased' as const,
      requestId: `request-${userId}`,
      connectionId: `connection-${userId}`,
      leaseId: `lease-${userId}`,
      mediaType: 'image' as const,
    }))
    const deps = createProductionComfyRuntimeDeps(services)
    const signal = new AbortController().signal

    await deps.dispatchTick(signal, config)
    expect(services.scheduleNext).toHaveBeenCalledTimes(8)
    await deps.dispatchTick(signal, config)

    expect(services.scheduleNext).toHaveBeenCalledTimes(10)
    expect(services.scheduleNext).toHaveBeenLastCalledWith('u10', config)
    expect(services.listDispatchOwners).toHaveBeenCalledOnce()
  })

  it('compensates a newly leased backed-off request and continues with another owner', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const services = fixture()
    services.listDispatchOwners.mockResolvedValue({
      items: [{ id: 'request-1', userId: 'u1' }, { id: 'request-2', userId: 'u2' }],
      nextCursor: null,
    })
    services.scheduleNext
      .mockResolvedValueOnce({
        outcome: 'leased', requestId: 'r1', connectionId: 'c1', leaseId: 'l1', mediaType: 'image',
      })
      .mockResolvedValueOnce({ outcome: 'empty' })
      .mockResolvedValueOnce({
        outcome: 'leased', requestId: 'r1', connectionId: 'c1', leaseId: 'l2', mediaType: 'image',
      })
      .mockResolvedValueOnce({
        outcome: 'leased', requestId: 'r2', connectionId: 'c2', leaseId: 'l3', mediaType: 'video',
      })
    services.dispatch.mockRejectedValueOnce(new Error('r1 failed')).mockResolvedValueOnce(undefined)
    const deps = createProductionComfyRuntimeDeps(services)
    const signal = new AbortController().signal

    await deps.dispatchTick(signal, config)
    await deps.dispatchTick(signal, config)

    expect(services.returnBackedOffLease).toHaveBeenNthCalledWith(1, {
      requestId: 'r1', userId: 'u1', connectionId: 'c1', leaseId: 'l1', ttlMs: config.leaseTtlMs,
    })
    expect(services.returnBackedOffLease).toHaveBeenNthCalledWith(2, {
      requestId: 'r1', userId: 'u1', connectionId: 'c1', leaseId: 'l2', ttlMs: config.leaseTtlMs,
    })
    expect(services.dispatch.mock.calls.map(([requestId]) => requestId)).toEqual(['r1', 'r2'])
  })
})

function fixture() {
  return {
    listHealthOwners: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    probeOwnerHealth: vi.fn().mockResolvedValue([]),
    listDispatchOwners: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    scheduleNext: vi.fn().mockResolvedValue({ outcome: 'empty' as const }),
    dispatch: vi.fn().mockResolvedValue(undefined),
    returnBackedOffLease: vi.fn().mockResolvedValue('waiting' as const),
    listReconcileRequests: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    reconcile: vi.fn().mockResolvedValue(undefined),
    scanExpiredPreSubmit: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
  }
}
