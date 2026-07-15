import type { Worker } from 'bullmq'
import type { TaskJobData } from '@/lib/task/types'

export type ProductionWorker = Pick<Worker<TaskJobData>, 'name' | 'on' | 'close'>

export type ProductionWorkerModules = {
  image: { createImageWorker(): ProductionWorker }
  video: { createVideoWorker(): ProductionWorker }
  voice: { createVoiceWorker(): ProductionWorker }
  text: { createTextWorker(): ProductionWorker }
  viralReplication: { createViralReplicationWorker(): ProductionWorker }
}

export const PRODUCTION_WORKER_COUNT = 5

export async function loadProductionWorkerModules(): Promise<ProductionWorkerModules> {
  const [image, video, voice, text, viralReplication] = await Promise.all([
    import('./image.worker'),
    import('./video.worker'),
    import('./voice.worker'),
    import('./text.worker'),
    import('./viral-replication.worker'),
  ])
  return { image, video, voice, text, viralReplication }
}

export async function createProductionWorkers(
  loadModules: () => Promise<ProductionWorkerModules> = loadProductionWorkerModules,
): Promise<ProductionWorker[]> {
  const modules = await loadModules()
  return [
    modules.image.createImageWorker(),
    modules.video.createVideoWorker(),
    modules.voice.createVoiceWorker(),
    modules.text.createTextWorker(),
    modules.viralReplication.createViralReplicationWorker(),
  ]
}
