import { describe, expect, it, vi } from 'vitest'

import {
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
})
