import 'dotenv/config'
import { logInfo as _ulogInfo, logError as _ulogError } from '@/lib/logging/core'
import { createImageWorker } from './image.worker'
import { createVideoWorker } from './video.worker'
import { createVoiceWorker } from './voice.worker'
import { createTextWorker } from './text.worker'
import { redis, queueRedis } from '@/lib/redis'
import { closeWorkerProcesses, createWorkerComfyRuntimeManager } from './comfy-runtime'

const workers = [createImageWorker(), createVideoWorker(), createVoiceWorker(), createTextWorker()]
const comfyRuntime = createWorkerComfyRuntimeManager().start()

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

function shutdown(signal: string) {
  if (shutdownPromise) return shutdownPromise
  shutdownPromise = performShutdown(signal)
  return shutdownPromise
}

async function performShutdown(signal: string) {
  _ulogInfo(`[Workers] shutdown signal: ${signal}`)
  await closeWorkerProcesses(comfyRuntime, workers, async () => {
    await Promise.all([redis.quit(), queueRedis.quit()])
  })
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
