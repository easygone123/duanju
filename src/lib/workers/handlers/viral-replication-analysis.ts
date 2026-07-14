import type { Job } from 'bullmq'
import type { TaskJobData } from '@/lib/task/types'

export async function handleViralReplicationAnalysisTask(_job: Job<TaskJobData>): Promise<never> {
  void _job
  throw new Error('VIRAL_VIDEO_ANALYSIS_NOT_IMPLEMENTED')
}
