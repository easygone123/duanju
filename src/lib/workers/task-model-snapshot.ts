import { parseModelKeyStrict } from '@/lib/model-config-contract'

export interface TaskModelSnapshot {
  model: string
  comfyWorkflowVersionId: string | undefined
}

type MediaKind = 'image' | 'video'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(record: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field)
}

export function hasTaskModelSnapshotFields(payload: unknown, mediaKind: MediaKind): boolean {
  if (!isRecord(payload)) return false
  return hasOwn(payload, `${mediaKind}Model`) || hasOwn(payload, 'comfyWorkflowVersionId')
}

function resolveTaskModelSnapshot(
  mediaKind: MediaKind,
  payload: unknown,
  legacyConfig: { model: string | null | undefined; comfyWorkflowVersionId?: string | null },
): TaskModelSnapshot {
  const record = isRecord(payload) ? payload : {}
  const modelField = `${mediaKind}Model`
  const hasSnapshot = hasTaskModelSnapshotFields(record, mediaKind)
  const rawModel = hasSnapshot ? record[modelField] : legacyConfig.model
  const rawVersion = hasSnapshot
    ? record.comfyWorkflowVersionId
    : legacyConfig.comfyWorkflowVersionId
  if (typeof rawModel !== 'string' || !parseModelKeyStrict(rawModel)) {
    throw new Error(`TASK_MODEL_SNAPSHOT_INVALID: ${modelField}`)
  }

  const parsed = parseModelKeyStrict(rawModel)!
  if (parsed.provider === 'comfyui') {
    if (typeof rawVersion !== 'string' || !rawVersion.trim()) {
      throw new Error('TASK_MODEL_SNAPSHOT_INVALID: comfyWorkflowVersionId')
    }
    return { model: rawModel, comfyWorkflowVersionId: rawVersion }
  }
  if (rawVersion !== undefined && rawVersion !== null && rawVersion !== '') {
    throw new Error('TASK_MODEL_SNAPSHOT_INVALID: unexpected comfyWorkflowVersionId')
  }
  return { model: rawModel, comfyWorkflowVersionId: undefined }
}

export function resolveImageTaskSnapshot(
  payload: unknown,
  legacyConfig: { model: string | null | undefined; comfyWorkflowVersionId?: string | null },
): TaskModelSnapshot {
  return resolveTaskModelSnapshot('image', payload, legacyConfig)
}

export function resolveVideoTaskSnapshot(
  payload: unknown,
  legacyConfig: { model: string | null | undefined; comfyWorkflowVersionId?: string | null },
): TaskModelSnapshot {
  return resolveTaskModelSnapshot('video', payload, legacyConfig)
}
