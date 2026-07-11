import { prisma } from '@/lib/prisma'
import { normalizeTaskError } from '@/lib/errors/normalize'
import { coerceTaskIntent, type TaskIntent } from './intent'
import { parseComfyExternalId } from '@/lib/comfyui/external-id'

export type TaskTargetQuery = {
  targetType: string
  targetId: string
  types?: string[]
}

export type TaskTargetPhase = 'idle' | 'queued' | 'processing' | 'completed' | 'failed'

export type TaskTargetState = {
  targetType: string
  targetId: string
  phase: TaskTargetPhase
  runningTaskId: string | null
  runningTaskType: string | null
  intent: TaskIntent
  hasOutputAtStart: boolean | null
  progress: number | null
  stage: string | null
  stageLabel: string | null
  lastError: {
    code: string
    message: string
  } | null
  updatedAt: string | null
  comfyDiagnostics?: ComfyTaskDiagnostics | null
}

export type ComfyTaskDiagnostics = {
  stage: 'waiting_capacity' | 'executing' | 'transferring'
  waitingForCapacity: boolean
  capacityWaitMs: number | null
  executionMs: number | null
  transferMs: number | null
  connectionId: string | null
  workflowId: string
  workflowVersionId: string
  promptId: string | null
}

type ComfyDiagnosticRequest = {
  id: string; status: string; connectionId: string | null; workflowId: string; workflowVersionId: string;
  promptId: string | null; queuedAt: Date; leasedAt: Date | null; runningAt: Date | null;
  transferringAt: Date | null; completedAt: Date | null; updatedAt: Date
}

const SAFE_DIAGNOSTIC_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function projectComfyTaskDiagnostics(externalId: string | null | undefined, request: ComfyDiagnosticRequest | null): ComfyTaskDiagnostics | null {
  if (!externalId || !request) return null
  let requestId: string
  try { requestId = parseComfyExternalId(externalId).requestId } catch { return null }
  if (!SAFE_DIAGNOSTIC_ID.test(requestId) || request.id !== requestId || !SAFE_DIAGNOSTIC_ID.test(request.workflowId)
    || !SAFE_DIAGNOSTIC_ID.test(request.workflowVersionId)) return null
  const connectionId = safeDiagnosticId(request.connectionId)
  const promptId = safeDiagnosticId(request.promptId)
  const waitingForCapacity = request.status === 'waiting_capacity' || request.status === 'blocked_no_compatible_instance'
  const stage = waitingForCapacity ? 'waiting_capacity' as const
    : request.status === 'transferring' ? 'transferring' as const : 'executing' as const
  const end = request.completedAt ?? request.updatedAt
  return {
    stage, waitingForCapacity,
    capacityWaitMs: duration(request.queuedAt, request.leasedAt ?? (waitingForCapacity ? end : null)),
    executionMs: duration(request.runningAt, request.transferringAt ?? (!waitingForCapacity ? end : null)),
    transferMs: duration(request.transferringAt, end),
    connectionId, workflowId: request.workflowId, workflowVersionId: request.workflowVersionId, promptId,
  }
}

function safeDiagnosticId(value: string | null) { return value && SAFE_DIAGNOSTIC_ID.test(value) ? value : null }
function duration(start: Date | null, end: Date | null) { return start && end ? Math.max(0, end.getTime() - start.getTime()) : null }

const ACTIVE_STATUS = new Set(['queued', 'processing'])

export function pairKey(targetType: string, targetId: string) {
  return `${targetType}:${targetId}`
}

export function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  return null
}

export function toProgress(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.floor(value)
  if (rounded < 0) return 0
  if (rounded > 100) return 100
  return rounded
}

export function extractTaskStateFields(task: {
  type: string
  progress: number
  payload: unknown
}) {
  const payload = asObject(task.payload)
  const payloadUi = asObject(payload?.ui)
  return {
    stage: asNonEmptyString(payload?.stage),
    stageLabel: asNonEmptyString(payload?.stageLabel),
    hasOutputAtStart: asBoolean(payloadUi?.hasOutputAtStart),
    intent: coerceTaskIntent(payloadUi?.intent ?? payload?.intent, task.type),
    progress: toProgress(task.progress),
  }
}

export function normalizeFailedError(task: {
  errorCode: string | null
  errorMessage: string | null
}) {
  const normalized = normalizeTaskError(task.errorCode, task.errorMessage)
  if (!normalized) return null
  return {
    code: normalized.code,
    message: normalized.message,
  }
}

export function buildIdleState(target: TaskTargetQuery): TaskTargetState {
  return {
    targetType: target.targetType,
    targetId: target.targetId,
    phase: 'idle',
    runningTaskId: null,
    runningTaskType: null,
    intent: 'process',
    hasOutputAtStart: null,
    progress: null,
    stage: null,
    stageLabel: null,
    lastError: null,
    updatedAt: null,
    comfyDiagnostics: null,
  }
}

export function resolveTargetState(
  target: TaskTargetQuery,
  tasks: Array<{
    id: string
    type: string
    status: string
    progress: number
    payload: unknown
    errorCode: string | null
    errorMessage: string | null
    updatedAt: Date
    externalId?: string | null
  }>,
): TaskTargetState {
  const allowedTypes = target.types?.length ? new Set(target.types) : null
  const filtered = allowedTypes
    ? tasks.filter((task) => allowedTypes.has(task.type))
    : tasks

  if (filtered.length === 0) return buildIdleState(target)

  const running = filtered.find((task) => ACTIVE_STATUS.has(task.status)) || null
  const terminal = filtered.find((task) =>
    task.status === 'completed' || task.status === 'failed' || task.status === 'canceled'
  ) || null
  const latest = running || terminal

  if (!latest) return buildIdleState(target)

  const latestFields = extractTaskStateFields(latest)

  if (running) {
    const runningFields = extractTaskStateFields(running)
    return {
      targetType: target.targetType,
      targetId: target.targetId,
      phase: running.status === 'processing' ? 'processing' : 'queued',
      runningTaskId: running.id,
      runningTaskType: running.type,
      intent: runningFields.intent,
      hasOutputAtStart: runningFields.hasOutputAtStart,
      progress: runningFields.progress,
      stage: runningFields.stage,
      stageLabel: runningFields.stageLabel,
      lastError: null,
      updatedAt: running.updatedAt.toISOString(),
    }
  }

  if (latest.status === 'completed') {
    return {
      targetType: target.targetType,
      targetId: target.targetId,
      phase: 'completed',
      runningTaskId: null,
      runningTaskType: latest.type,
      intent: latestFields.intent,
      hasOutputAtStart: latestFields.hasOutputAtStart,
      progress: 100,
      stage: latestFields.stage,
      stageLabel: latestFields.stageLabel,
      lastError: null,
      updatedAt: latest.updatedAt.toISOString(),
    }
  }

  return {
    targetType: target.targetType,
    targetId: target.targetId,
    phase: 'failed',
    runningTaskId: null,
    runningTaskType: latest.type,
    intent: latestFields.intent,
    hasOutputAtStart: latestFields.hasOutputAtStart,
    progress: null,
    stage: latestFields.stage,
    stageLabel: latestFields.stageLabel,
    lastError: normalizeFailedError(latest),
    updatedAt: latest.updatedAt.toISOString(),
  }
}

/**
 * 单次查询的 OR 条件上限。
 * 过大的 OR 列表 + ORDER BY 会导致 MySQL sort buffer 溢出（Error 1038）。
 */
const QUERY_BATCH_SIZE = 50

export async function queryTaskTargetStates(params: {
  projectId: string
  userId: string
  targets: TaskTargetQuery[]
}): Promise<TaskTargetState[]> {
  if (!params.targets.length) return []

  const pairEntries = new Map<string, { targetType: string; targetId: string }>()
  const typeUnion = new Set<string>()

  for (const target of params.targets) {
    pairEntries.set(pairKey(target.targetType, target.targetId), {
      targetType: target.targetType,
      targetId: target.targetId,
    })
    for (const type of target.types || []) {
      if (type) typeUnion.add(type)
    }
  }

  const pairs = Array.from(pairEntries.values())
  if (pairs.length === 0) return params.targets.map((target) => buildIdleState(target))

  const typeFilter = typeUnion.size > 0 ? { type: { in: Array.from(typeUnion) } } : {}

  // 分批查询，避免 MySQL sort buffer 溢出
  const allRows: Array<{
    id: string
    type: string
    status: string
    progress: number
    payload: unknown
    errorCode: string | null
    errorMessage: string | null
    targetType: string
    targetId: string
    updatedAt: Date
    externalId: string | null
  }> = []

  for (let i = 0; i < pairs.length; i += QUERY_BATCH_SIZE) {
    const batch = pairs.slice(i, i + QUERY_BATCH_SIZE)
    const rows = await prisma.task.findMany({
      where: {
        projectId: params.projectId,
        userId: params.userId,
        OR: batch.map((item) => ({
          targetType: item.targetType,
          targetId: item.targetId,
        })),
        status: {
          in: ['queued', 'processing', 'completed', 'failed', 'canceled'],
        },
        ...typeFilter,
      },
      // 不在数据库层排序，改为应用层排序以避免 sort buffer 溢出
      select: {
        id: true,
        type: true,
        status: true,
        progress: true,
        payload: true,
        errorCode: true,
        errorMessage: true,
        targetType: true,
        targetId: true,
      updatedAt: true,
        externalId: true,
      },
    })
    allRows.push(...rows)
  }

  // 应用层按 updatedAt desc 排序（每个 target 组内排序即可）
  const grouped = new Map<string, typeof allRows>()
  for (const row of allRows) {
    const key = pairKey(row.targetType, row.targetId)
    const existing = grouped.get(key)
    if (existing) {
      existing.push(row)
    } else {
      grouped.set(key, [row])
    }
  }

  // 对每组按 updatedAt desc 排序
  for (const group of grouped.values()) {
    group.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  }

  const requestIds = new Set<string>()
  for (const row of allRows) {
    if (!row.externalId || !ACTIVE_STATUS.has(row.status) || requestIds.size >= 500) continue
    try {
      const requestId = parseComfyExternalId(row.externalId).requestId
      if (SAFE_DIAGNOSTIC_ID.test(requestId)) requestIds.add(requestId)
    } catch { /* ignore untrusted external ids */ }
  }
  const requests = requestIds.size > 0 ? await prisma.comfyGenerationRequest.findMany({
    where: { id: { in: [...requestIds] }, userId: params.userId, projectId: params.projectId },
    select: {
      id: true, taskId: true, status: true, connectionId: true, workflowId: true, workflowVersionId: true,
      promptId: true, queuedAt: true, leasedAt: true, runningAt: true, transferringAt: true,
      completedAt: true, updatedAt: true,
    },
  }) : []
  const requestsByTaskId = new Map(requests.map((request) => [request.taskId, request]))
  return params.targets.map((target) => {
    const state = resolveTargetState(
      target,
      grouped.get(pairKey(target.targetType, target.targetId)) || [],
    )
    if (!state.runningTaskId) return state
    const task = allRows.find((row) => row.id === state.runningTaskId)
    return { ...state, comfyDiagnostics: projectComfyTaskDiagnostics(task?.externalId, requestsByTaskId.get(state.runningTaskId) ?? null) }
  })
}
