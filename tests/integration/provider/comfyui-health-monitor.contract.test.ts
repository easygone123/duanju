import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ComfyError, COMFY_ERROR_CODE } from '@/lib/comfyui/errors'
import {
  comfyHealthKey,
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
  cacheSet: ReturnType<typeof vi.fn>
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
    cacheSet: vi.fn().mockResolvedValue('OK'),
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

    expect(deps.cacheSet).toHaveBeenCalledWith(
      comfyHealthKey('connection-1'),
      JSON.stringify({
        state: 'online_idle', checkedAt: checkedAt.toISOString(), version: '0.3.50',
        runningCount: 0, pendingCount: 0,
      }),
      'PX',
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
    expect(deps.cacheSet).toHaveBeenCalledOnce()
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
  })
})
