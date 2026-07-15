import { prisma } from '@/lib/prisma'
import { TASK_STATUS } from '@/lib/task/types'
import { VIRAL_REPLICATION_STATUS } from './constants'

const RECONCILE_BATCH_SIZE = 200

export async function failOwnedViralAnalysisExecution(
  taskId: string,
  reason: string,
): Promise<boolean> {
  const result = await prisma.viralReplication.updateMany({
    where: {
      status: VIRAL_REPLICATION_STATUS.ANALYZING,
      analysisExecutionTaskId: taskId,
    },
    data: {
      status: VIRAL_REPLICATION_STATUS.FAILED,
      errorMessage: reason,
      analysisExecutionTaskId: null,
      analysisExecutionToken: null,
      analysisExecutionExpiresAt: null,
    },
  })
  return result.count > 0
}

export async function reconcileFailedViralAnalysisExecutions(): Promise<string[]> {
  const activeExecutions = await prisma.viralReplication.findMany({
    where: {
      status: VIRAL_REPLICATION_STATUS.ANALYZING,
      analysisExecutionTaskId: { not: null },
    },
    select: { analysisExecutionTaskId: true },
    orderBy: { updatedAt: 'asc' },
    take: RECONCILE_BATCH_SIZE,
  })
  const taskIds = [...new Set(activeExecutions.flatMap(({ analysisExecutionTaskId }) => (
    analysisExecutionTaskId ? [analysisExecutionTaskId] : []
  )))]
  if (taskIds.length === 0) return []

  const failedTasks = await prisma.task.findMany({
    where: {
      id: { in: taskIds },
      status: TASK_STATUS.FAILED,
    },
    select: { id: true, errorMessage: true },
  })
  const reconciled: string[] = []
  for (const task of failedTasks) {
    const released = await failOwnedViralAnalysisExecution(
      task.id,
      task.errorMessage || 'Owning analysis Task failed',
    )
    if (released) reconciled.push(task.id)
  }
  return reconciled
}
