import { describe, expect, it, vi } from 'vitest'
import {
  createProductionWorkers,
  PRODUCTION_WORKER_COUNT,
  type ProductionWorkerModules,
} from '@/lib/workers/production-workers'
import { closeWorkerProcesses } from '@/lib/workers/comfy-runtime'

function buildWorker(name: string) {
  return {
    name,
    on: vi.fn(),
    close: vi.fn(async () => undefined),
  }
}

describe('production worker factory', () => {
  it('creates all five production workers in the declared order', async () => {
    const workers = [
      buildWorker('image'),
      buildWorker('video'),
      buildWorker('voice'),
      buildWorker('text'),
      buildWorker('viral-replication'),
    ]
    const factories = workers.map((worker) => vi.fn(() => worker))
    const modules: ProductionWorkerModules = {
      image: { createImageWorker: factories[0] },
      video: { createVideoWorker: factories[1] },
      voice: { createVoiceWorker: factories[2] },
      text: { createTextWorker: factories[3] },
      viralReplication: { createViralReplicationWorker: factories[4] },
    }

    const created = await createProductionWorkers(async () => modules)

    expect(PRODUCTION_WORKER_COUNT).toBe(5)
    expect(created.map((worker) => worker.name)).toEqual([
      'image', 'video', 'voice', 'text', 'viral-replication',
    ])
    expect(factories.every((factory) => factory.mock.calls.length === 1)).toBe(true)
  })

  it('participates in shared shutdown for every production worker', async () => {
    const workers = [
      buildWorker('image'),
      buildWorker('video'),
      buildWorker('voice'),
      buildWorker('text'),
      buildWorker('viral-replication'),
    ]
    const modules: ProductionWorkerModules = {
      image: { createImageWorker: () => workers[0] },
      video: { createVideoWorker: () => workers[1] },
      voice: { createVoiceWorker: () => workers[2] },
      text: { createTextWorker: () => workers[3] },
      viralReplication: { createViralReplicationWorker: () => workers[4] },
    }
    const created = await createProductionWorkers(async () => modules)
    const runtime = { close: vi.fn(async () => undefined), wakeDispatcher: vi.fn() }
    const closeRedis = vi.fn(async () => undefined)

    await closeWorkerProcesses(runtime, created, closeRedis)

    expect(workers.every((worker) => worker.close.mock.calls.length === 1)).toBe(true)
    expect(runtime.close).toHaveBeenCalledOnce()
    expect(closeRedis).toHaveBeenCalledOnce()
  })
})
