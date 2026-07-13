import { parseModelKeyStrict } from '@/lib/model-config-contract'
import {
  VIDEO_DURATION_INVALID,
  VIDEO_DURATION_TOO_SHORT,
  resolveSupportedDuration,
} from '@/lib/novel-promotion/six-grid/duration'

export { VIDEO_DURATION_INVALID, VIDEO_DURATION_TOO_SHORT }

export const VIDEO_DIALOGUE_MODEL_INVALID = 'VIDEO_DIALOGUE_MODEL_INVALID'
export const VIDEO_MODEL_INVALID = 'VIDEO_MODEL_INVALID'

export type VideoModelReason =
  | 'explicit_panel_model'
  | 'dialogue_project_model'
  | 'dialogue_model_not_configured_fallback'
  | 'normal_project_model'

export type VideoDurationContract =
  | { kind: 'fixed'; options: readonly number[] }
  | { kind: 'range'; min: number; max: number; step: number }
  | { kind: 'provider_default'; duration: number }

export interface AvailablePanelVideoModel {
  modelKey: string
  available: boolean
  comfyWorkflowVersionId?: string | null
  duration: VideoDurationContract
}

export interface PanelVideoMetadata {
  hasDialogue?: boolean | null
  dialogueSpeaker?: string | null
  dialogueText?: string | null
  dialogueEmotion?: string | null
  includeDialogueInVideoPrompt?: boolean | null
  videoPrompt?: string | null
  estimatedDuration?: number | null
  durationOverride?: number | null
  legacyDuration?: number | null
}

export interface PanelVideoSubmissionInput {
  panel: PanelVideoMetadata
  project: { videoModel: string | null; dialogueVideoModel?: string | null }
  explicitModelSelection?: string | null
  models: readonly AvailablePanelVideoModel[]
}

export interface PanelVideoSubmission {
  selectedModel: string
  modelReason: VideoModelReason
  visualPrompt: string
  dialogueFragment?: string
  dialogueTimingInstruction?: string
  submittedPrompt: string
  requestedDuration: number
  effectiveDuration: number
  durationSource: 'override' | 'estimated' | 'legacy' | 'provider_default'
  snapshot: {
    model: string
    comfyWorkflowVersionId?: string
    modelReason: VideoModelReason
    requestedDuration: number
    effectiveDuration: number
  }
}

export function resolvePinnedVideoPrompt(input: {
  queuedPrompt?: string | null
  persistedPrompt?: string | null
  persistedDescription?: string | null
}): string | null {
  for (const value of [input.queuedPrompt, input.persistedPrompt, input.persistedDescription]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function singleLine(value: string | null | undefined, maxLength: number): string {
  return (value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function findAvailableModel(
  models: readonly AvailablePanelVideoModel[],
  modelKey: string | null | undefined,
): AvailablePanelVideoModel | undefined {
  if (!modelKey || !parseModelKeyStrict(modelKey)) return undefined
  return models.find((model) => model.modelKey === modelKey && model.available)
}

function resolveModel(input: PanelVideoSubmissionInput): {
  model: AvailablePanelVideoModel
  reason: VideoModelReason
} {
  if (input.explicitModelSelection) {
    const explicit = findAvailableModel(input.models, input.explicitModelSelection)
    if (!explicit) throw new Error(VIDEO_MODEL_INVALID)
    return { model: explicit, reason: 'explicit_panel_model' }
  }

  if (input.panel.hasDialogue) {
    if (input.project.dialogueVideoModel) {
      const dialogue = findAvailableModel(input.models, input.project.dialogueVideoModel)
      if (!dialogue) throw new Error(VIDEO_DIALOGUE_MODEL_INVALID)
      return { model: dialogue, reason: 'dialogue_project_model' }
    }
    const fallback = findAvailableModel(input.models, input.project.videoModel)
    if (!fallback) throw new Error(VIDEO_MODEL_INVALID)
    return { model: fallback, reason: 'dialogue_model_not_configured_fallback' }
  }

  const normal = findAvailableModel(input.models, input.project.videoModel)
  if (!normal) throw new Error(VIDEO_MODEL_INVALID)
  return { model: normal, reason: 'normal_project_model' }
}

function resolveRequestedDuration(
  panel: PanelVideoMetadata,
  contract: VideoDurationContract,
): { requested: number; source: PanelVideoSubmission['durationSource'] } {
  if (positive(panel.durationOverride)) return { requested: panel.durationOverride, source: 'override' }
  if (panel.durationOverride !== null && panel.durationOverride !== undefined) {
    throw new Error(VIDEO_DURATION_INVALID)
  }
  if (positive(panel.estimatedDuration)) return { requested: panel.estimatedDuration, source: 'estimated' }
  if (panel.estimatedDuration !== null && panel.estimatedDuration !== undefined) {
    throw new Error(VIDEO_DURATION_INVALID)
  }
  if (positive(panel.legacyDuration)) return { requested: panel.legacyDuration, source: 'legacy' }
  if (contract.kind === 'provider_default' && positive(contract.duration)) {
    return { requested: contract.duration, source: 'provider_default' }
  }
  if (contract.kind === 'fixed' && contract.options.length > 0) {
    const first = [...contract.options].sort((left, right) => left - right)[0]
    if (positive(first)) return { requested: first, source: 'provider_default' }
  }
  if (contract.kind === 'range' && positive(contract.min)) {
    return { requested: contract.min, source: 'provider_default' }
  }
  throw new Error(VIDEO_DURATION_INVALID)
}

function resolveRangeDuration(requested: number, contract: Extract<VideoDurationContract, { kind: 'range' }>) {
  if (!positive(contract.min) || !positive(contract.max) || !positive(contract.step) || contract.min > contract.max) {
    throw new Error(VIDEO_DURATION_INVALID)
  }
  if (requested > contract.max) throw new Error(VIDEO_DURATION_TOO_SHORT)
  const steps = Math.max(0, Math.ceil((requested - contract.min) / contract.step - Number.EPSILON))
  const effective = contract.min + steps * contract.step
  if (effective > contract.max + Number.EPSILON) throw new Error(VIDEO_DURATION_TOO_SHORT)
  return Math.round(effective * 1000) / 1000
}

function resolveEffectiveDuration(requested: number, contract: VideoDurationContract): number {
  if (contract.kind === 'fixed') return resolveSupportedDuration(requested, contract.options)
  if (contract.kind === 'range') return resolveRangeDuration(requested, contract)
  if (!positive(contract.duration)) throw new Error(VIDEO_DURATION_INVALID)
  if (contract.duration < requested) throw new Error(VIDEO_DURATION_TOO_SHORT)
  return contract.duration
}

function buildDialogueFragment(panel: PanelVideoMetadata): string | undefined {
  if (!panel.hasDialogue || panel.includeDialogueInVideoPrompt !== true) return undefined
  const data = {
    speaker: singleLine(panel.dialogueSpeaker, 120),
    emotion: singleLine(panel.dialogueEmotion, 120),
    acting: 'natural acting synchronized with speech',
    mouth: 'natural mouth movement',
    lip: 'accurate lip synchronization',
    text: singleLine(panel.dialogueText, 1000),
  }
  return `[DIALOGUE_DATA] ${JSON.stringify(data)}`
}

const DIALOGUE_TIMING_INSTRUCTION = '[DIALOGUE_TIMING] Fit the complete literal dialogue naturally within the requested shot duration, preserving brief acting and reaction beats.'

export function resolvePanelVideoSubmission(input: PanelVideoSubmissionInput): PanelVideoSubmission {
  const { model, reason } = resolveModel(input)
  const visualPrompt = singleLine(input.panel.videoPrompt, 8000)
  const dialogueFragment = buildDialogueFragment(input.panel)
  const dialogueTimingInstruction = dialogueFragment ? DIALOGUE_TIMING_INSTRUCTION : undefined
  const { requested, source } = resolveRequestedDuration(input.panel, model.duration)
  const effectiveDuration = resolveEffectiveDuration(requested, model.duration)
  const comfyWorkflowVersionId = model.comfyWorkflowVersionId?.trim() || undefined
  if (parseModelKeyStrict(model.modelKey)?.provider === 'comfyui' && !comfyWorkflowVersionId) {
    throw new Error(VIDEO_MODEL_INVALID)
  }

  return {
    selectedModel: model.modelKey,
    modelReason: reason,
    visualPrompt,
    dialogueFragment,
    dialogueTimingInstruction,
    submittedPrompt: [visualPrompt, dialogueFragment, dialogueTimingInstruction].filter(Boolean).join(' '),
    requestedDuration: requested,
    effectiveDuration,
    durationSource: source,
    snapshot: {
      model: model.modelKey,
      ...(comfyWorkflowVersionId ? { comfyWorkflowVersionId } : {}),
      modelReason: reason,
      requestedDuration: requested,
      effectiveDuration,
    },
  }
}
