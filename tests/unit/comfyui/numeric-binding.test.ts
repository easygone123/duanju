import { describe, expect, it } from 'vitest'
import {
  convertComfyNumericBinding,
  decimalEquals,
} from '@/lib/comfyui/numeric-binding'
import { COMFY_ERROR_CODE, ComfyError } from '@/lib/comfyui/errors'
import type { ComfyNumericBindingTransform } from '@/lib/comfyui/types'

const frames = (
  patch: Partial<ComfyNumericBindingTransform> = {},
): ComfyNumericBindingTransform => ({
  sourceUnit: 'seconds',
  targetUnit: 'frames',
  output: 'number',
  fps: { source: 'runtime_then_fallback', variable: 'fps', fallback: 16 },
  rounding: 'round',
  frameOffset: 1,
  ...patch,
})

function captureError(fn: () => unknown): ComfyError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(ComfyError)
    return error as ComfyError
  }
  throw new Error('Expected function to throw')
}

describe('ComfyUI numeric bindings', () => {
  it('preserves fractional seconds', () => {
    expect(convertComfyNumericBinding({
      variable: 'duration',
      value: 5.5,
      variables: {},
      transform: { sourceUnit: 'seconds', targetUnit: 'seconds', output: 'number' },
    })).toEqual({
      variable: 'duration',
      sourceValue: 5.5,
      targetValue: 5.5,
      encodedValue: 5.5,
      encodedAs: 'number',
      sourceUnit: 'seconds',
      targetUnit: 'seconds',
    })
  })

  it('uses runtime FPS before fallback', () => {
    expect(convertComfyNumericBinding({
      variable: 'duration', value: 5, variables: { fps: 24 }, transform: frames(),
    })).toMatchObject({ targetValue: 121, effectiveFps: 24 })
  })

  it('uses fallback FPS and emits a numeric string', () => {
    expect(convertComfyNumericBinding({
      variable: 'duration', value: 5, variables: {},
      transform: frames({ output: 'numeric_string' }),
    }).encodedValue).toBe('81')
  })

  it.each([['round', 53], ['floor', 52], ['ceil', 53]] as const)(
    'applies %s deterministically', (rounding, expected) => {
      expect(convertComfyNumericBinding({
        variable: 'duration', value: 3.3, variables: {},
        transform: frames({ rounding, frameOffset: 0 }),
      }).targetValue).toBe(expected)
    },
  )

  it('rejects unsupported target values without snapping', () => {
    expect(() => convertComfyNumericBinding({
      variable: 'duration', value: 6, variables: {},
      transform: frames({ allowedTargetValues: [81, 161] }),
    })).toThrowError(/unsupported_target/)
  })

  it.each(['5', Number.NaN, Number.POSITIVE_INFINITY, 0, -1])(
    'rejects invalid source value %s', (value) => {
      const error = captureError(() => convertComfyNumericBinding({
        variable: 'duration', value, variables: {}, transform: frames(),
      }))

      expect(error.code).toBe(COMFY_ERROR_CODE.WORKFLOW_BINDING_INVALID)
      expect(error.details).toEqual({ variable: 'duration', reason: 'invalid_source' })
    },
  )

  it('rejects frame conversion without a valid runtime or fallback FPS', () => {
    const error = captureError(() => convertComfyNumericBinding({
      variable: 'duration',
      value: 5,
      variables: { fps: Number.NaN },
      transform: frames({ fps: undefined }),
    }))

    expect(error.details).toEqual({ variable: 'duration', reason: 'missing_fps' })
  })

  it('rejects frame counts outside the safe integer range', () => {
    const error = captureError(() => convertComfyNumericBinding({
      variable: 'duration',
      value: Number.MAX_SAFE_INTEGER,
      variables: {},
      transform: frames({ frameOffset: 0 }),
    }))

    expect(error.details).toEqual({ variable: 'duration', reason: 'invalid_frames' })
  })

  it('rejects a positive duration that rounds down to zero frames', () => {
    const error = captureError(() => convertComfyNumericBinding({
      variable: 'duration',
      value: 0.01,
      variables: {},
      transform: frames({ rounding: 'floor', frameOffset: 0 }),
    }))

    expect(error.details).toEqual({ variable: 'duration', reason: 'invalid_frames' })
  })

  it('requires exact allowed values for frame targets', () => {
    expect(() => convertComfyNumericBinding({
      variable: 'duration',
      value: 0.0625,
      variables: {},
      transform: frames({
        frameOffset: 0,
        allowedTargetValues: [1 + Number.EPSILON],
      }),
    })).toThrowError(/unsupported_target/)
  })

  it('accepts decimal-safe allowed values without accepting nearby values', () => {
    expect(decimalEquals(0.1 + 0.2, 0.3)).toBe(true)
    expect(decimalEquals(0.3000001, 0.3)).toBe(false)
    expect(convertComfyNumericBinding({
      variable: 'duration',
      value: 0.1 + 0.2,
      variables: {},
      transform: {
        sourceUnit: 'seconds',
        targetUnit: 'seconds',
        output: 'number',
        allowedTargetValues: [0.3],
      },
    }).targetValue).toBe(0.1 + 0.2)
  })

  it('does not mutate its inputs', () => {
    const variables = { fps: 24 }
    const transform = frames({ allowedTargetValues: [121] })
    const input = { variable: 'duration', value: 5, variables, transform }
    const variablesBefore = structuredClone(variables)
    const transformBefore = structuredClone(transform)

    convertComfyNumericBinding(input)

    expect(variables).toEqual(variablesBefore)
    expect(transform).toEqual(transformBefore)
  })
})
