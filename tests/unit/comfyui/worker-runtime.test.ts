import { describe, expect, it, vi } from 'vitest'

import {
  bootstrapWorkerProcesses,
  closeWorkerProcesses,
  createWorkerComfyRuntimeManager,
} from '@/lib/workers/comfy-runtime'

describe('worker ComfyUI runtime wiring', () => {
  it('starts the ComfyUI runtime only once', () => {
    const runtime = { close: vi.fn(), wakeDispatcher: vi.fn() }
    const start = vi.fn(() => runtime)
    const manager = createWorkerComfyRuntimeManager(start)

    expect(manager.start()).toBe(runtime)
    expect(manager.start()).toBe(runtime)
    expect(start).toHaveBeenCalledOnce()
  })

  it('closes runtime before Bull workers and Redis resources', async () => {
    const order: string[] = []
    const runtime = { close: vi.fn(async () => { order.push('runtime') }), wakeDispatcher: vi.fn() }
    const workers = [
      { close: vi.fn(async () => { order.push('worker-1') }) },
      { close: vi.fn(async () => { order.push('worker-2') }) },
    ]
    const closeRedis = vi.fn(async () => { order.push('redis') })

    await closeWorkerProcesses(runtime, workers, closeRedis)

    expect(order[0]).toBe('runtime')
    expect(order.at(-1)).toBe('redis')
    expect(workers[0].close).toHaveBeenCalledOnce()
    expect(workers[1].close).toHaveBeenCalledOnce()
  })

  it('validates enabled ComfyUI before creating Bull workers or runtime resources', async () => {
    const createWorkers = vi.fn()
    const startRuntime = vi.fn()

    await expect(bootstrapWorkerProcesses({
      env: { COMFYUI_ENABLED: 'true', COMFYUI_NETWORK_MODE: 'allowlist' },
      createWorkers,
      startRuntime,
    })).rejects.toThrow('Invalid COMFYUI_ALLOWED_HOSTS/COMFYUI_ALLOWED_CIDRS')

    expect(createWorkers).not.toHaveBeenCalled()
    expect(startRuntime).not.toHaveBeenCalled()
  })

  it('starts normal cloud workers while disabled ComfyUI ignores unused invalid settings', async () => {
    const workers = [{ close: vi.fn().mockResolvedValue(undefined) }]
    const runtime = { close: vi.fn(), wakeDispatcher: vi.fn() }
    const createWorkers = vi.fn().mockResolvedValue(workers)
    const startRuntime = vi.fn(() => runtime)

    await expect(bootstrapWorkerProcesses({
      env: {
        COMFYUI_ENABLED: 'false',
        COMFYUI_NETWORK_MODE: 'invalid-but-disabled',
        COMFYUI_HEALTH_INTERVAL_MS: 'invalid-but-disabled',
      },
      createWorkers,
      startRuntime,
    })).resolves.toMatchObject({ workers, runtime })

    expect(createWorkers).toHaveBeenCalledOnce()
    expect(startRuntime).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }))
  })
})
