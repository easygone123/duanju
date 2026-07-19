import { describe, expect, it } from 'vitest'

import {
  deriveVideoTestDurationContract,
  validateVideoTestDurationValue,
} from '@/lib/comfyui/video-test-duration'

describe('ComfyUI video live-test duration contract', () => {
  it('defaults an unconstrained seconds mapping to one second', () => {
    expect(deriveVideoTestDurationContract({
      mediaType: 'video',
      variableDefinitions: [{ name: 'duration', type: 'number', required: false }],
      bindings: [{
        nodeId: '1',
        inputPath: 'seconds',
        variable: 'duration',
        valueType: 'number',
        numericTransform: {
          sourceUnit: 'seconds', targetUnit: 'seconds', output: 'number',
        },
      }],
    })).toMatchObject({
      required: true,
      eligible: true,
      variableName: 'duration',
      defaultSeconds: 1,
      targetUnit: 'seconds',
    })
  })

  it('uses the shortest supported duration for a constrained total-frame mapping', () => {
    expect(deriveVideoTestDurationContract({
      mediaType: 'video',
      variableDefinitions: [{ name: 'duration', type: 'number', required: false }],
      bindings: [{
        nodeId: '1',
        inputPath: 'length',
        variable: 'duration',
        valueType: 'number',
        numericTransform: {
          sourceUnit: 'seconds', targetUnit: 'frames', output: 'number',
          fps: { source: 'runtime_then_fallback', variable: 'fps', fallback: 16 },
          rounding: 'round', frameOffset: 1, allowedTargetValues: [161, 81],
        },
      }],
    })).toMatchObject({
      required: true,
      eligible: true,
      variableName: 'duration',
      defaultSeconds: 5,
      targetUnit: 'frames',
    })
  })

  it('uses a supported numeric alias as the submitted variable name', () => {
    expect(deriveVideoTestDurationContract({
      mediaType: 'video',
      variableDefinitions: [{ name: 'seconds', type: 'number', required: false }],
      bindings: [{
        nodeId: '1', inputPath: 'seconds', variable: 'seconds', valueType: 'number',
        numericTransform: { sourceUnit: 'seconds', targetUnit: 'seconds', output: 'number' },
      }],
    })).toMatchObject({ eligible: true, variableName: 'seconds', defaultSeconds: 1 })
  })

  it('blocks a video definition that has no bound duration target', () => {
    expect(deriveVideoTestDurationContract({
      mediaType: 'video',
      variableDefinitions: [{ name: 'duration', type: 'number', required: false }],
      bindings: [],
    })).toEqual({
      required: true,
      eligible: false,
      issueCode: 'COMFY_VIDEO_TEST_DURATION_REQUIRED',
    })
  })

  it('blocks a bound duration without an explicit seconds or frames conversion', () => {
    expect(deriveVideoTestDurationContract({
      mediaType: 'video',
      variableDefinitions: [{ name: 'duration', type: 'number', required: false }],
      bindings: [{
        nodeId: '1', inputPath: 'length', variable: 'duration', valueType: 'number',
      }],
    })).toMatchObject({ eligible: false, issueCode: 'COMFY_VIDEO_TEST_DURATION_REQUIRED' })
  })

  it('does not add a duration requirement to image workflows', () => {
    expect(deriveVideoTestDurationContract({
      mediaType: 'image', variableDefinitions: [], bindings: [],
    })).toEqual({ required: false, eligible: true })
  })

  it('accepts only positive supported live-test durations', () => {
    const contract = deriveVideoTestDurationContract({
      mediaType: 'video',
      variableDefinitions: [{ name: 'duration', type: 'number', required: false }],
      bindings: [{
        nodeId: '1',
        inputPath: 'length',
        variable: 'duration',
        valueType: 'number',
        numericTransform: {
          sourceUnit: 'seconds', targetUnit: 'frames', output: 'number',
          fps: { source: 'runtime_then_fallback', variable: 'fps', fallback: 16 },
          rounding: 'round', frameOffset: 1, allowedTargetValues: [81],
        },
      }],
    })
    if (!contract.required || !contract.eligible) throw new Error('expected eligible contract')

    for (const invalid of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 6]) {
      expect(validateVideoTestDurationValue(contract, invalid)).toBe(false)
    }
    expect(validateVideoTestDurationValue(contract, 5)).toBe(true)
  })
})
