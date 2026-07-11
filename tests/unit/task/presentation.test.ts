import { describe, expect, it } from 'vitest'
import { resolveTaskPresentationState } from '@/lib/task/presentation'

describe('resolveTaskPresentationState', () => {
  it('uses overlay mode when running and has output', () => {
    const state = resolveTaskPresentationState({
      phase: 'processing',
      intent: 'regenerate',
      resource: 'image',
      hasOutput: true,
    })
    expect(state.isRunning).toBe(true)
    expect(state.mode).toBe('overlay')
    expect(state.labelKey).toBe('taskStatus.intent.regenerate.running.image')
  })

  it('uses placeholder mode when running and no output', () => {
    const state = resolveTaskPresentationState({
      phase: 'queued',
      intent: 'generate',
      resource: 'image',
      hasOutput: false,
    })
    expect(state.mode).toBe('placeholder')
    expect(state.labelKey).toBe('taskStatus.intent.generate.running.image')
  })

  it('maps failed state to failed label', () => {
    const state = resolveTaskPresentationState({
      phase: 'failed',
      intent: 'modify',
      resource: 'video',
      hasOutput: true,
    })
    expect(state.isError).toBe(true)
    expect(state.labelKey).toBe('taskStatus.failed.video')
  })

  it('carries sanitized ComfyUI diagnostics into overlay presentation', () => {
    const comfyDiagnostics = {
      stage: 'waiting_capacity' as const, waitingForCapacity: true, capacityWaitMs: 5000,
      executionMs: null, transferMs: null, connectionId: null, workflowId: 'wf-1',
      workflowVersionId: 'v1', promptId: null,
    }
    expect(resolveTaskPresentationState({
      phase: 'queued', intent: 'generate', resource: 'image', hasOutput: false, comfyDiagnostics,
    }).comfyDiagnostics).toEqual(comfyDiagnostics)
  })
})
