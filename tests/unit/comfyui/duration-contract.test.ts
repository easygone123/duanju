import { describe, expect, it } from 'vitest'

import { resolveComfyDurationContract } from '@/lib/comfyui/duration-contract'
import type { ComfyInputBinding, ComfyVariableDefinition } from '@/lib/comfyui/types'

const definitions: ComfyVariableDefinition[] = [{
  name: 'duration', type: 'number', required: true,
}]

function durationBinding(
  numericTransform: NonNullable<ComfyInputBinding['numericTransform']>,
): ComfyInputBinding {
  return {
    nodeId: '1', inputPath: 'length', variable: 'duration', valueType: 'number',
    numericTransform,
  }
}

describe('ComfyUI canonical duration contract', () => {
  it('inverts allowed frames into canonical seconds', () => {
    expect(resolveComfyDurationContract({
      variableDefinitions: definitions,
      bindings: [durationBinding({
        sourceUnit: 'seconds', targetUnit: 'frames', output: 'number',
        fps: { source: 'runtime_then_fallback', variable: 'fps', fallback: 16 },
        rounding: 'round', frameOffset: 1, allowedTargetValues: [81, 161],
      })],
    })).toEqual({ kind: 'fixed', options: [5, 10] })
  })

  it('preserves fractional second options', () => {
    expect(resolveComfyDurationContract({
      variableDefinitions: definitions,
      bindings: [durationBinding({
        sourceUnit: 'seconds', targetUnit: 'seconds', output: 'number',
        allowedTargetValues: [2.5, 5.5],
      })],
    })).toEqual({ kind: 'fixed', options: [2.5, 5.5] })
  })

  it('uses positive runtime FPS before the pinned fallback', () => {
    expect(resolveComfyDurationContract({
      variableDefinitions: definitions,
      bindings: [durationBinding({
        sourceUnit: 'seconds', targetUnit: 'frames', output: 'numeric_string',
        fps: { source: 'runtime_then_fallback', variable: 'fps', fallback: 16 },
        rounding: 'round', frameOffset: 1, allowedTargetValues: [121],
      })],
      runtimeFps: 24,
    })).toEqual({ kind: 'fixed', options: [5] })
  })

  it('forward-checks rounding and offset and drops non-positive inverse choices', () => {
    expect(resolveComfyDurationContract({
      variableDefinitions: definitions,
      bindings: [durationBinding({
        sourceUnit: 'seconds', targetUnit: 'frames', output: 'number',
        fps: { source: 'runtime_then_fallback', variable: 'fps', fallback: 16 },
        rounding: 'floor', frameOffset: 1, allowedTargetValues: [1, 82],
      })],
    })).toEqual({ kind: 'fixed', options: [5.0625] })
  })

  it('falls back to legacy canonical duration options without a native target contract', () => {
    expect(resolveComfyDurationContract({
      variableDefinitions: [{
        name: 'duration', type: 'number', required: true, options: [10, 5, 10],
      }],
      bindings: [durationBinding({
        sourceUnit: 'seconds', targetUnit: 'seconds', output: 'number',
      })],
    })).toEqual({ kind: 'fixed', options: [5, 10] })
  })

  it('keeps a workflow without native or legacy choices unconstrained', () => {
    expect(resolveComfyDurationContract({
      variableDefinitions: definitions,
      bindings: [durationBinding({
        sourceUnit: 'seconds', targetUnit: 'seconds', output: 'number',
      })],
    })).toEqual({ kind: 'unconstrained' })
  })
})
