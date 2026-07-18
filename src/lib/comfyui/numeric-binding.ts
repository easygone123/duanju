import { COMFY_ERROR_CODE, ComfyError } from './errors'
import type {
  ComfyNumericBindingTransform,
  ComfyNumericConversionDiagnostic,
  ComfyVariableValue,
} from './types'

type ComfyNumericBindingInvalidReason =
  | 'invalid_source'
  | 'missing_fps'
  | 'invalid_frames'
  | 'unsupported_target'

function invalid(variable: string, reason: ComfyNumericBindingInvalidReason): never {
  throw new ComfyError(
    COMFY_ERROR_CODE.WORKFLOW_BINDING_INVALID,
    `Invalid numeric workflow binding: ${reason}`,
    { details: { variable, reason } },
  )
}

export function decimalEquals(left: number, right: number): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false
  const scale = Math.max(1, Math.abs(left), Math.abs(right))
  return Math.abs(left - right) <= Number.EPSILON * scale * 8
}

function matchesAllowedTarget(
  allowed: number,
  target: number,
  targetUnit: ComfyNumericBindingTransform['targetUnit'],
): boolean {
  if (targetUnit === 'frames' || Number.isInteger(target)) return allowed === target
  return decimalEquals(allowed, target)
}

export function convertComfyNumericBinding(input: {
  variable: string
  value: unknown
  variables: Record<string, ComfyVariableValue | undefined>
  transform: ComfyNumericBindingTransform
}): ComfyNumericConversionDiagnostic & { encodedValue: number | string } {
  if (
    typeof input.value !== 'number'
    || !Number.isFinite(input.value)
    || input.value <= 0
  ) {
    invalid(input.variable, 'invalid_source')
  }

  const sourceValue = input.value
  let targetValue = sourceValue
  let effectiveFps: number | undefined

  if (input.transform.sourceUnit === 'seconds' && input.transform.targetUnit === 'frames') {
    const runtimeFps = input.variables[input.transform.fps?.variable ?? 'fps']
    effectiveFps = typeof runtimeFps === 'number'
      && Number.isFinite(runtimeFps)
      && runtimeFps > 0
      ? runtimeFps
      : input.transform.fps?.fallback

    if (effectiveFps === undefined || !Number.isFinite(effectiveFps) || effectiveFps <= 0) {
      invalid(input.variable, 'missing_fps')
    }

    const applyRounding = input.transform.rounding === 'floor'
      ? Math.floor
      : input.transform.rounding === 'ceil'
        ? Math.ceil
        : Math.round
    targetValue = applyRounding(sourceValue * effectiveFps)
      + (input.transform.frameOffset ?? 0)

    if (!Number.isSafeInteger(targetValue) || targetValue <= 0) {
      invalid(input.variable, 'invalid_frames')
    }
  }

  if (
    input.transform.allowedTargetValues !== undefined
    && !input.transform.allowedTargetValues.some(
      (allowed) => matchesAllowedTarget(
        allowed,
        targetValue,
        input.transform.targetUnit,
      ),
    )
  ) {
    invalid(input.variable, 'unsupported_target')
  }

  return {
    variable: input.variable,
    sourceValue,
    targetValue,
    encodedValue: input.transform.output === 'numeric_string'
      ? String(targetValue)
      : targetValue,
    encodedAs: input.transform.output,
    sourceUnit: input.transform.sourceUnit,
    targetUnit: input.transform.targetUnit,
    ...(effectiveFps === undefined ? {} : { effectiveFps }),
    ...(input.transform.rounding === undefined
      ? {}
      : { rounding: input.transform.rounding }),
    ...(input.transform.frameOffset === undefined
      ? {}
      : { frameOffset: input.transform.frameOffset }),
  }
}
