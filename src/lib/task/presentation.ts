import type { TaskIntent } from './intent'
import type { ComfyTaskDiagnostics } from './state-service'

export type TaskPresentationPhase = 'idle' | 'queued' | 'processing' | 'completed' | 'failed'
export type TaskPresentationResource = 'image' | 'video' | 'audio' | 'text'
export type TaskPresentationMode = 'none' | 'overlay' | 'placeholder'

export type TaskPresentationState = {
  phase: TaskPresentationPhase
  intent: TaskIntent
  resource: TaskPresentationResource
  hasOutput: boolean
  mode: TaskPresentationMode
  isRunning: boolean
  isError: boolean
  labelKey: string | null
  comfyDiagnostics?: ComfyTaskDiagnostics | null
}

export function isRunningPhase(phase: string | null | undefined): phase is 'queued' | 'processing' {
  return phase === 'queued' || phase === 'processing'
}

export function resolveTaskPresentationState(input: {
  phase: TaskPresentationPhase
  intent: TaskIntent
  resource: TaskPresentationResource
  hasOutput: boolean
  comfyDiagnostics?: ComfyTaskDiagnostics | null
}): TaskPresentationState {
  const isRunning = input.phase === 'queued' || input.phase === 'processing'
  if (isRunning) {
    return {
      phase: input.phase,
      intent: input.intent,
      resource: input.resource,
      hasOutput: input.hasOutput,
      mode: input.hasOutput ? 'overlay' : 'placeholder',
      isRunning: true,
      isError: false,
      labelKey: `taskStatus.intent.${input.intent}.running.${input.resource}`,
      comfyDiagnostics: input.comfyDiagnostics ?? null,
    }
  }

  if (input.phase === 'failed') {
    return {
      phase: input.phase,
      intent: input.intent,
      resource: input.resource,
      hasOutput: input.hasOutput,
      mode: input.hasOutput ? 'overlay' : 'placeholder',
      isRunning: false,
      isError: true,
      labelKey: `taskStatus.failed.${input.resource}`,
      comfyDiagnostics: input.comfyDiagnostics ?? null,
    }
  }

  return {
    phase: input.phase,
    intent: input.intent,
    resource: input.resource,
    hasOutput: input.hasOutput,
    mode: 'none',
    isRunning: false,
    isError: false,
    labelKey: null,
    comfyDiagnostics: input.comfyDiagnostics ?? null,
  }
}
