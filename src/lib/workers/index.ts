import 'dotenv/config'

import { logError as _ulogError, logInfo as _ulogInfo } from '@/lib/logging/core'
import { createProductionComfyRuntimeDeps } from '@/lib/comfyui/runtime-deps'
import { startComfyRuntime } from '@/lib/comfyui/runtime'

import { bootstrapWorkerProcesses, closeWorkerProcesses } from './comfy-runtime'

async function startWorkerProcess() {
  const boot = await bootstrapWorkerProcesses({
    env: process.env,
    createWorkers: async () => {
      const [image, video, voice, text] = await Promise.all([
        import('./image.worker'),
        import('./video.worker'),
        import('./voice.worker'),
        import('./text.worker'),
      ])
      return [
        image.createImageWorker(), video.createVideoWorker(),
        voice.createVoiceWorker(), text.createTextWorker(),
      ]
    },
    startRuntime: (config) => startComfyRuntime({
      config,
      deps: createProductionComfyRuntimeDeps(),
    }),
  })
  const { redis, queueRedis } = await import('@/lib/redis')
  const { workers, runtime } = boot

  _ulogInfo('[Workers] started:', workers.length)
  for (const worker of workers) {
    worker.on('ready', () => {
      _ulogInfo(`[Workers] ready: ${worker.name}`)
    })
    worker.on('error', (err) => {
      _ulogError(`[Workers] error: ${worker.name}`, err.message)
    })
    worker.on('failed', (job, err) => {
      _ulogError(`[Workers] job failed: ${worker.name}`, {
        jobId: job?.id,
        taskId: job?.data?.taskId,
        taskType: job?.data?.type,
        error: err.message,
      })
    })
  }

  let shutdownPromise: Promise<void> | null = null
  const shutdown = (signal: string) => {
    shutdownPromise ??= (async () => {
      _ulogInfo(`[Workers] shutdown signal: ${signal}`)
      await closeWorkerProcesses(runtime, workers, async () => {
        await Promise.all([redis.quit(), queueRedis.quit()])
      })
      process.exit(0)
    })()
    return shutdownPromise
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

void startWorkerProcess().catch((error) => {
  _ulogError('[Workers] startup failed', {
    error: error instanceof Error ? error.message : 'Unknown startup error',
  })
  process.exit(1)
})
