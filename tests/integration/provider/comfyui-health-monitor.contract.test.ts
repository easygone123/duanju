import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ComfyError, COMFY_ERROR_CODE } from '@/lib/comfyui/errors'
import {
  comfyHealthKey,
  cacheComfyHealthIfNewer,
  monitorComfyHealth,
  type ComfyHealthMonitorDependencies,
} from '@/lib/comfyui/health'
import type { ComfyWorkflowRequirements } from '@/lib/comfyui/types'

const checkedAt = new Date('2026-07-11T08:00:00.000Z')
const requirements: ComfyWorkflowRequirements = {
  nodeClasses: ['KSampler'], candidateLoaderInputs: [],
}
const graph = { '1': { class_type: 'KSampler', inputs: {} } }

function dependencies(): ComfyHealthMonitorDependencies & {
  authorize: ReturnType<typeof vi.fn>
  getSystemStats: ReturnType<typeof vi.fn>
  getQueue: ReturnType<typeof vi.fn>
  hasLease: ReturnType<typeof vi.fn>
  checkCompatibility: ReturnType<typeof vi.fn>
  cacheEval: ReturnType<typeof vi.fn>
} {
  return {
    authorize: vi.fn().mockResolvedValue(undefined),
    getSystemStats: vi.fn().mockResolvedValue({ system: { comfyui_version: '0.3.50' } }),
    getQueue: vi.fn().mockResolvedValue({ running: [], pending: [] }),
    hasLease: vi.fn().mockResolvedValue(false),
    checkCompatibility: vi.fn().mockResolvedValue({
      compatible: true, missingNodes: [], missingModels: [], workflowHash: 'workflow-a',
      capabilityFingerprint: 'f'.repeat(64),
    }),
    cacheEval: vi.fn().mockResolvedValue(1),
  }
}

async function monitor(deps: ComfyHealthMonitorDependencies) {
  return monitorComfyHealth({
    connectionId: 'connection-1',
    workflowHash: 'workflow-a',
    graph,
    requirements,
    checkedAt,
    ttlMs: 12_000,
  }, deps)
}

describe('ComfyUI health monitor contract', () => {
  beforeEach(() => vi.clearAllMocks())

  it('checks policy, stats, queue, local lease, then capability fingerprint in order', async () => {
    const deps = dependencies()
    const order: string[] = []
    deps.authorize.mockImplementation(async () => { order.push('policy') })
    deps.getSystemStats.mockImplementation(async () => { order.push('stats'); return {} })
    deps.getQueue.mockImplementation(async () => { order.push('queue'); return { running: [], pending: [] } })
    deps.hasLease.mockImplementation(async () => { order.push('lease'); return false })
    deps.checkCompatibility.mockImplementation(async () => {
      order.push('fingerprint')
      return {
        compatible: true, missingNodes: [], missingModels: [], workflowHash: 'workflow-a',
        capabilityFingerprint: 'f'.repeat(64),
      }
    })

    const result = await monitor(deps)

    expect(order).toEqual(['policy', 'stats', 'queue', 'lease', 'fingerprint'])
    expect(result.health.state).toBe('online_idle')
    expect(result.compatibility?.compatible).toBe(true)
  })

  it('stores a sanitized health projection at comfy:health:<connectionId> with TTL', async () => {
    const deps = dependencies()

    await monitor(deps)

    expect(deps.cacheEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('get'"),
      1,
      comfyHealthKey('connection-1'),
      checkedAt.toISOString(),
      JSON.stringify({
        state: 'online_idle', checkedAt: checkedAt.toISOString(), version: '0.3.50',
        runningCount: 0, pendingCount: 0,
      }),
      12_000,
    )
  })

  it('classifies authentication failure, caches it, and stops after stats', async () => {
    const deps = dependencies()
    deps.getSystemStats.mockRejectedValue(new ComfyError(
      COMFY_ERROR_CODE.AUTH_FAILED, 'Bearer top-secret',
    ))

    const result = await monitor(deps)

    expect(result.health.state).toBe('auth_failed')
    expect(JSON.stringify(result)).not.toContain('top-secret')
    expect(deps.getQueue).not.toHaveBeenCalled()
    expect(deps.cacheEval).toHaveBeenCalledOnce()
  })

  it('classifies policy or transport failure as offline without leaking diagnostics', async () => {
    const deps = dependencies()
    deps.authorize.mockRejectedValue(new Error('connect token=top-secret'))

    const result = await monitor(deps)

    expect(result.health.state).toBe('offline')
    expect(JSON.stringify(result)).not.toContain('top-secret')
    expect(deps.getSystemStats).not.toHaveBeenCalled()
  })

  it('distinguishes an external Comfy queue from a local waoowaoo lease', async () => {
    const external = dependencies()
    external.getQueue.mockResolvedValue({ running: [['manual']], pending: [] })
    await expect(monitor(external)).resolves.toMatchObject({
      health: { state: 'online_busy_external', runningCount: 1, pendingCount: 0 },
    })

    const owned = dependencies()
    owned.hasLease.mockResolvedValue(true)
    await expect(monitor(owned)).resolves.toMatchObject({
      health: { state: 'online_busy_owned', runningCount: 0, pendingCount: 0 },
    })
  })

  it('records exact connection uptime and idle/owned/external state metrics', async () => {
    const recordState = vi.fn()
    const idle = dependencies()
    idle.recordState = recordState
    await monitor(idle)
    const external = dependencies()
    external.recordState = recordState
    external.getQueue.mockResolvedValue({ running: [['manual']], pending: [] })
    await monitor(external)
    const owned = dependencies()
    owned.recordState = recordState
    owned.hasLease.mockResolvedValue(true)
    await monitor(owned)
    expect(recordState.mock.calls.map((call) => call[0].state)).toEqual([
      'online_idle', 'online_busy_external', 'online_busy_owned',
    ])
    expect(recordState).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: 'connection-1', up: 1, idle: 1, ownedBusy: 0, externalBusy: 0,
    }))
  })

  it('returns workflow_incompatible with exact missing requirements', async () => {
    const deps = dependencies()
    deps.checkCompatibility.mockResolvedValue({
      compatible: false,
      missingNodes: ['VideoNode'],
      missingModels: [{ nodeId: '4', field: 'ckpt_name', value: 'missing.safetensors' }],
      workflowHash: 'workflow-a',
      capabilityFingerprint: 'a'.repeat(64),
    })

    const result = await monitor(deps)

    expect(result.health.state).toBe('workflow_incompatible')
    expect(result.compatibility).toEqual({
      compatible: false,
      missingNodes: ['VideoNode'],
      missingModels: [{ nodeId: '4', field: 'ckpt_name', value: 'missing.safetensors' }],
      workflowHash: 'workflow-a',
      capabilityFingerprint: 'a'.repeat(64),
    })
    const cachedPayload = JSON.parse(deps.cacheEval.mock.calls[0][4])
    expect(cachedPayload.state).toBe('online_idle')
  })

  it('keeps compatibility probe failures separate from base connection health', async () => {
    const deps = dependencies()
    deps.checkCompatibility.mockRejectedValue(new Error('model probe token=top-secret'))

    const result = await monitor(deps)

    expect(result.health.state).toBe('online_idle')
    expect(result.compatibilityError).toEqual({
      code: 'COMFY_COMPATIBILITY_CHECK_FAILED',
      message: 'Compatibility check unavailable',
    })
    expect(JSON.stringify(result)).not.toContain('top-secret')
    expect(JSON.parse(deps.cacheEval.mock.calls[0][4]).state).toBe('online_idle')
  })

  it('uses an atomic freshness CAS so inverse completion cannot overwrite newer health', async () => {
    let stored: { checkedAt: string; payload: string } | undefined
    const cacheEval = vi.fn(async (
      _script: string, _keys: number, _key: string, candidateAt: string, payload: string,
    ) => {
      if (stored && stored.checkedAt >= candidateAt) return 0
      stored = { checkedAt: candidateAt, payload }
      return 1
    })
    const older = dependencies()
    const newer = dependencies()
    older.cacheEval = cacheEval
    newer.cacheEval = cacheEval
    const releaseOlder = Promise.withResolvers<void>()
    older.getQueue.mockImplementation(async () => {
      await releaseOlder.promise
      return { running: [], pending: [] }
    })
    newer.getQueue.mockResolvedValue({ running: [['manual']], pending: [] })

    const oldProbe = monitorComfyHealth({
      connectionId: 'connection-1', checkedAt: new Date('2026-07-11T08:00:00.000Z'), ttlMs: 12_000,
    }, older)
    await monitorComfyHealth({
      connectionId: 'connection-1', checkedAt: new Date('2026-07-11T08:00:01.000Z'), ttlMs: 12_000,
    }, newer)
    releaseOlder.resolve()
    await oldProbe

    expect(JSON.parse(stored!.payload).state).toBe('online_busy_external')
    expect(cacheEval).toHaveBeenCalledTimes(2)
  })

  it('exports the Redis CAS writer with the same health key and TTL contract', async () => {
    const evalClient = { eval: vi.fn().mockResolvedValue(1) }
    const health = {
      state: 'online_idle' as const, checkedAt: checkedAt.toISOString(),
      runningCount: 0, pendingCount: 0,
    }

    await cacheComfyHealthIfNewer(evalClient, 'connection-1', health, 12_000)

    expect(evalClient.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('get'"), 1, comfyHealthKey('connection-1'),
      checkedAt.toISOString(), JSON.stringify(health), 12_000,
    )
  })
})
