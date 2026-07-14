import type { Job } from 'bullmq'
import type { TaskJobData } from '@/lib/task/types'

export async function handleViralReplicationGenerationTask(_job: Job<TaskJobData>): Promise<never> {
  void _job
  throw new Error('VIRAL_STORYBOARD_GENERATION_NOT_IMPLEMENTED')
}
