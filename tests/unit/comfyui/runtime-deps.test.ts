import { describe, expect, it, vi } from 'vitest'

import { createProductionComfyRuntimeDeps } from '@/lib/comfyui/runtime-deps'
import type { ComfyRuntimeConfig } from '@/lib/comfyui/runtime'

const config = {
  enabled: true,
  networkPolicy: { mode: 'allowlist' as const, allowedHosts: [], allowedCidrs: [] },
  healthIntervalMs: 1000, dispatchIntervalMs: 500, reconcileIntervalMs: 2000,
  leaseTtlMs: 30000, imageTimeoutMs: 300000, videoTimeoutMs: 1200000,
  workflowMaxBytes: 2097152, inputMaxBytes: 26214400, outputMaxBytes: 536870912,
} satisfies ComfyRuntimeConfig

describe('production ComfyUI runtime dependency composition', () => {
  it('probes every enabled owner and reports idle capacity', async () => {
    const services = fixture()
    services.listHealthOwners.mockResolvedValue(['u1', 'u2'])
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
    services.listDispatchOwners.mockResolvedValue(['u1'])
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
    services.listDispatchOwners.mockResolvedValue(['u1'])
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
    services.listDispatchOwners.mockResolvedValue(['u1'])
    services.scheduleNext
      .mockResolvedValueOnce({
        outcome: 'leased', requestId: 'r1', connectionId: 'c1', leaseId: 'l1', mediaType: 'image',
      })
      .mockResolvedValueOnce({
        outcome: 'leased', requestId: 'r2', connectionId: 'c2', leaseId: 'l2', mediaType: 'video',
      })
      .mockResolvedValueOnce({ outcome: 'empty' })
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
    services.listReconcileRequests.mockResolvedValue([
      { requestId: 'image-r', mediaType: 'image' },
      { requestId: 'video-r', mediaType: 'video' },
    ])
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
})

function fixture() {
  return {
    listHealthOwners: vi.fn().mockResolvedValue([]),
    probeOwnerHealth: vi.fn().mockResolvedValue([]),
    listDispatchOwners: vi.fn().mockResolvedValue([]),
    scheduleNext: vi.fn().mockResolvedValue({ outcome: 'empty' as const }),
    dispatch: vi.fn().mockResolvedValue(undefined),
    listReconcileRequests: vi.fn().mockResolvedValue([]),
    reconcile: vi.fn().mockResolvedValue(undefined),
    scanExpiredPreSubmit: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
  }
}
