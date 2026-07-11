import { describe, expect, it, vi } from 'vitest'

import { runFreshComfyPreSubmitGate } from '@/lib/comfyui/runtime-execution-adapter'

const graph = { '1': { class_type: 'KSampler', inputs: {} } }
const requirements = { nodeClasses: ['KSampler'], candidateLoaderInputs: [] }

function client() {
  return {
    getSystemStats: vi.fn().mockResolvedValue({ system: { comfyui_version: '1.0' } }),
    getQueue: vi.fn().mockResolvedValue({ running: [], pending: [] }),
    getObjectInfo: vi.fn().mockResolvedValue({ KSampler: { input: { required: {} } } }),
    getModels: vi.fn().mockResolvedValue([]),
  }
}

describe('fresh ComfyUI pre-submit gate', () => {
  it('rejects a stale cached-idle node when an external prompt has since appeared', async () => {
    const live = client()
    live.getQueue.mockResolvedValue({ running: [[0, 'external-prompt']], pending: [] })
    const verifyOwner = vi.fn().mockResolvedValue(true)

    await expect(runFreshComfyPreSubmitGate({
      connectionId: 'connection-1', workflowHash: 'hash-1', graph, requirements,
      client: live, verifyOwner,
    })).resolves.toBe('external_busy')

    expect(live.getSystemStats).toHaveBeenCalledOnce()
    expect(live.getQueue).toHaveBeenCalledOnce()
    expect(live.getObjectInfo).not.toHaveBeenCalled()
    expect(verifyOwner).toHaveBeenCalledOnce()
  })

  it('rejects capability drift and verifies lease ownership after fresh compatibility', async () => {
    const live = client()
    live.getObjectInfo.mockResolvedValue({ OtherNode: { input: { required: {} } } })
    const verifyOwner = vi.fn().mockResolvedValue(true)

    await expect(runFreshComfyPreSubmitGate({
      connectionId: 'connection-1', workflowHash: 'hash-1', graph, requirements,
      client: live, verifyOwner,
    })).resolves.toBe('incompatible')

    expect(live.getObjectInfo).toHaveBeenCalledOnce()
    expect(verifyOwner).toHaveBeenCalledOnce()
    expect(live.getObjectInfo.mock.invocationCallOrder[0])
      .toBeLessThan(verifyOwner.mock.invocationCallOrder[0])
  })

  it('rechecks queue after compatibility so a prompt arriving during the gate cannot slip through', async () => {
    const live = client()
    live.getQueue
      .mockResolvedValueOnce({ running: [], pending: [] })
      .mockResolvedValueOnce({ running: [], pending: [[0, 'late-external']] })

    await expect(runFreshComfyPreSubmitGate({
      connectionId: 'connection-1', workflowHash: 'hash-1', graph, requirements,
      client: live, verifyOwner: vi.fn().mockResolvedValue(true),
    })).resolves.toBe('external_busy')
    expect(live.getQueue).toHaveBeenCalledTimes(2)
  })

  it('fails closed when the owner lease changes after all fresh checks', async () => {
    const live = client()
    await expect(runFreshComfyPreSubmitGate({
      connectionId: 'connection-1', workflowHash: 'hash-1', graph, requirements,
      client: live, verifyOwner: vi.fn().mockResolvedValue(false),
    })).resolves.toBe('lost')
  })

  it('returns disabled before contacting ComfyUI when the fresh connection was disabled', async () => {
    const live = client()
    const verifyOwner = vi.fn().mockResolvedValue(true)
    await expect(runFreshComfyPreSubmitGate({
      connectionId: 'connection-1', workflowHash: 'hash-1', graph, requirements,
      client: live, verifyOwner,
      connectionState: vi.fn().mockResolvedValue('disabled'),
    })).resolves.toBe('disabled')
    expect(live.getSystemStats).not.toHaveBeenCalled()
    expect(live.getQueue).not.toHaveBeenCalled()
    expect(verifyOwner).not.toHaveBeenCalled()
  })
})
