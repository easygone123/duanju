import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { TASK_STATUS } from '@/lib/task/types'
import { RUN_STATUS, RUN_STEP_STATUS } from './types'

const ACTIVE_RUN_STATUSES = [
  RUN_STATUS.QUEUED,
  RUN_STATUS.RUNNING,
  RUN_STATUS.CANCELING,
] as const

const ACTIVE_STEP_STATUSES = [
  RUN_STEP_STATUS.PENDING,
  RUN_STEP_STATUS.RUNNING,
] as const

const TERMINAL_TASK_STATUSES = [
  TASK_STATUS.COMPLETED,
  TASK_STATUS.FAILED,
  TASK_STATUS.CANCELED,
  TASK_STATUS.DISMISSED,
] as const

type ActiveRunRow = {
  id: string
  status: string
  taskId: string | null
  updatedAt: Date
  leaseExpiresAt: Date | null
  heartbeatAt: Date | null
  cancelRequestedAt: Date | null
}

type LinkedTaskRow = {
  id: string
  status: string
  result: unknown
  errorCode: string | null
  errorMessage: string | null
  finishedAt: Date | null
}

export type ReconciledActiveRun = {
  runId: string
  taskId: string | null
  nextStatus: 'completed' | 'failed'
  reason: string
}

const LEASE_EXPIRED_RECONCILE_GRACE_MS = 30_000
const CANCELING_RUN_TIMEOUT_MS = 5 * 60_000

function toObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function toNullableJson(value: Record<string, unknown> | null) {
  if (value === null) return Prisma.JsonNull
  return value as Prisma.InputJsonValue
}

function buildFailedReason(task: LinkedTaskRow): string {
  if (task.status === TASK_STATUS.CANCELED) {
    return task.errorMessage?.trim() || 'Linked task was canceled'
  }
  if (task.status === TASK_STATUS.DISMISSED) {
    return task.errorMessage?.trim() || 'Linked task was dismissed'
  }
  return task.errorMessage?.trim() || 'Linked task failed'
}

export async function reconcileActiveRunsFromTasks(limit = 200): Promise<ReconciledActiveRun[]> {
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 500) : 200
  const now = Date.now()
  const activeRuns = await prisma.graphRun.findMany({
    where: {
      status: {
        in: [...ACTIVE_RUN_STATUSES],
      },
    },
    orderBy: {
      updatedAt: 'asc',
    },
    take: safeLimit,
    select: {
      id: true,
      status: true,
      taskId: true,
      updatedAt: true,
      leaseExpiresAt: true,
      heartbeatAt: true,
      cancelRequestedAt: true,
    },
  }) as ActiveRunRow[]

  if (activeRuns.length === 0) return []

  const taskIds = activeRuns
    .map((run) => run.taskId)
    .filter((taskId): taskId is string => typeof taskId === 'string' && taskId.trim().length > 0)
  const tasks = taskIds.length === 0
    ? []
    : await prisma.task.findMany({
        where: {
          id: {
            in: taskIds,
          },
          status: {
            in: [...TERMINAL_TASK_STATUSES],
          },
        },
        select: {
          id: true,
          status: true,
          result: true,
          errorCode: true,
          errorMessage: true,
          finishedAt: true,
        },
      }) as LinkedTaskRow[]
  const taskMap = new Map<string, LinkedTaskRow>(tasks.map((task) => [task.id, task]))

  const staleRuns = activeRuns.filter((run) => {
    if (run.taskId && taskMap.has(run.taskId)) return false
    if (
      run.status === RUN_STATUS.RUNNING
      && run.leaseExpiresAt
      && now - run.leaseExpiresAt.getTime() >= LEASE_EXPIRED_RECONCILE_GRACE_MS
    ) {
      return !run.heartbeatAt || run.heartbeatAt.getTime() <= run.leaseExpiresAt.getTime()
    }
    if (
      run.status === RUN_STATUS.CANCELING
      && run.cancelRequestedAt
      && now - run.cancelRequestedAt.getTime() >= CANCELING_RUN_TIMEOUT_MS
    ) {
      return true
    }
    return false
  })

  const reconciled: ReconciledActiveRun[] = []

  for (const run of staleRuns) {
    const failureMessage = run.status === RUN_STATUS.CANCELING
      ? 'Run cancel request timed out'
      : 'Run lease expired without heartbeat'
    const failureCode = run.status === RUN_STATUS.CANCELING ? 'RUN_CANCEL_TIMEOUT' : 'RUN_LEASE_EXPIRED'
    const settled = await prisma.$transaction(async (tx) => {
      const updatedRun = await tx.graphRun.updateMany({
        where: {
          id: run.id,
          status: {
            in: [...ACTIVE_RUN_STATUSES],
          },
        },
        data: {
          status: RUN_STATUS.FAILED,
          errorCode: failureCode,
          errorMessage: failureMessage,
          finishedAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
        },
      })
      if (updatedRun.count === 0) return false

      await tx.graphStep.updateMany({
        where: {
          runId: run.id,
          status: {
            in: [...ACTIVE_STEP_STATUSES],
          },
        },
        data: {
          status: RUN_STEP_STATUS.FAILED,
          finishedAt: new Date(),
          lastErrorCode: failureCode,
          lastErrorMessage: failureMessage,
        },
      })
      return true
    })
    if (settled) {
      reconciled.push({
        runId: run.id,
        taskId: run.taskId,
        nextStatus: 'failed',
        reason: failureCode,
      })
    }
  }

  if (tasks.length === 0) return reconciled

  for (const run of activeRuns) {
    const taskId = run.taskId?.trim() || ''
    if (!taskId) continue
    const task = taskMap.get(taskId)
    if (!task) continue
    const settledAt = task.finishedAt || new Date()

    if (task.status === TASK_STATUS.COMPLETED) {
      const settled = await prisma.$transaction(async (tx) => {
        const updatedRun = await tx.graphRun.updateMany({
          where: {
            id: run.id,
            status: {
              in: [...ACTIVE_RUN_STATUSES],
            },
          },
          data: {
            status: RUN_STATUS.COMPLETED,
            output: toNullableJson(toObject(task.result)),
            errorCode: null,
            errorMessage: null,
            finishedAt: settledAt,
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
          },
        })
        if (updatedRun.count === 0) return false

        await tx.graphStep.updateMany({
          where: {
            runId: run.id,
            status: {
              in: [...ACTIVE_STEP_STATUSES],
            },
          },
          data: {
            status: RUN_STEP_STATUS.COMPLETED,
            finishedAt: settledAt,
            lastErrorCode: null,
            lastErrorMessage: null,
          },
        })
        return true
      })

      if (settled) {
        reconciled.push({
          runId: run.id,
          taskId: run.taskId,
          nextStatus: 'completed',
          reason: 'linked task already completed',
        })
      }
      continue
    }

    const failureMessage = buildFailedReason(task)
    const settled = await prisma.$transaction(async (tx) => {
      const updatedRun = await tx.graphRun.updateMany({
        where: {
          id: run.id,
          status: {
            in: [...ACTIVE_RUN_STATUSES],
          },
        },
        data: {
          status: RUN_STATUS.FAILED,
          errorCode: task.errorCode?.trim() || 'TASK_TERMINATED',
          errorMessage: failureMessage,
          finishedAt: settledAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
        },
      })
      if (updatedRun.count === 0) return false

      await tx.graphStep.updateMany({
        where: {
          runId: run.id,
          status: {
            in: [...ACTIVE_STEP_STATUSES],
          },
        },
        data: {
          status: RUN_STEP_STATUS.FAILED,
          finishedAt: settledAt,
          lastErrorCode: task.errorCode?.trim() || 'TASK_TERMINATED',
          lastErrorMessage: failureMessage,
        },
      })
      return true
    })

    if (settled) {
      reconciled.push({
        runId: run.id,
        taskId: run.taskId,
        nextStatus: 'failed',
        reason: `linked task already ${task.status}`,
      })
    }
  }

  return reconciled
}
