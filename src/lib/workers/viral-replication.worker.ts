import { Worker, type Job } from 'bullmq'
import { queueRedis } from '@/lib/redis'
import { QUEUE_NAME } from '@/lib/task/queue-names'
import { TASK_TYPE, type TaskJobData } from '@/lib/task/types'
import { withTaskLifecycle } from './shared'
import { handleViralReplicationAnalysisTask } from './handlers/viral-replication-analysis'
import { handleViralReplicationGenerationTask } from './handlers/viral-replication-generation'

async function processViralReplicationTask(job: Job<TaskJobData>) {
  switch (job.data.type) {
    case TASK_TYPE.VIRAL_VIDEO_ANALYSIS:
      return await handleViralReplicationAnalysisTask(job)
    case TASK_TYPE.VIRAL_STORYBOARD_GENERATION:
      return await handleViralReplicationGenerationTask(job)
    default:
      throw new Error(`Unsupported viral replication task type: ${job.data.type}`)
  }
}

export function createViralReplicationWorker() {
  return new Worker<TaskJobData>(
    QUEUE_NAME.VIRAL_REPLICATION,
    async (job) => await withTaskLifecycle(job, processViralReplicationTask),
    {
      connection: queueRedis,
      concurrency: Number.parseInt(process.env.QUEUE_CONCURRENCY_VIRAL_REPLICATION || '2', 10) || 2,
    },
  )
}
