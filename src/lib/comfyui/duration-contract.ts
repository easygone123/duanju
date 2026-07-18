import { convertComfyNumericBinding, decimalEquals } from './numeric-binding'
import type {
  ComfyInputBinding,
  ComfyNumericBindingTransform,
  ComfyVariableDefinition,
} from './types'

export type ComfyDurationContract =
  | { kind: 'fixed'; options: number[]; nativeConstrained?: true }
  | { kind: 'unconstrained' }

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function sortedUnique(values: readonly number[]): number[] {
  return values
    .filter(positive)
    .sort((left, right) => left - right)
    .filter((value, index, sorted) => (
      index === 0 || !decimalEquals(sorted[index - 1]!, value)
    ))
}

function targetMatches(
  targetValue: number,
  allowedValue: number,
  transform: ComfyNumericBindingTransform,
): boolean {
  return transform.targetUnit === 'frames'
    ? targetValue === allowedValue
    : decimalEquals(targetValue, allowedValue)
}

function forwardMatches(
  seconds: number,
  transform: ComfyNumericBindingTransform,
  runtimeFps: number | undefined,
  allowedValue?: number,
): boolean {
  if (!positive(seconds)) return false
  try {
    const converted = convertComfyNumericBinding({
      variable: 'duration',
      value: seconds,
      variables: positive(runtimeFps) ? { fps: runtimeFps } : {},
      transform,
    })
    return allowedValue === undefined
      || targetMatches(converted.targetValue, allowedValue, transform)
  } catch {
    return false
  }
}

function invertBinding(
  transform: ComfyNumericBindingTransform,
  runtimeFps: number | undefined,
): number[] {
  const allowed = transform.allowedTargetValues ?? []
  if (transform.sourceUnit !== 'seconds') return []
  if (transform.targetUnit === 'seconds') {
    return sortedUnique(allowed.filter((seconds) => (
      forwardMatches(seconds, transform, runtimeFps, seconds)
    )))
  }
  if (transform.targetUnit !== 'frames') return []
  const effectiveFps = positive(runtimeFps) ? runtimeFps : transform.fps?.fallback
  if (!positive(effectiveFps)) return []
  const offset = transform.frameOffset ?? 0
  return sortedUnique(allowed.flatMap((allowedFrame) => {
    const seconds = (allowedFrame - offset) / effectiveFps
    return forwardMatches(seconds, transform, runtimeFps, allowedFrame) ? [seconds] : []
  }))
}

export function canonicalDurationDefinition(
  definitions: readonly ComfyVariableDefinition[],
): ComfyVariableDefinition | undefined {
  return definitions.find((definition) => definition.name === 'duration')
    ?? definitions.find((definition) => (
      definition.type === 'number' && /duration|seconds/i.test(definition.name)
    ))
}

export function resolveComfyDurationContract(input: {
  variableDefinitions: readonly ComfyVariableDefinition[]
  bindings: readonly ComfyInputBinding[]
  runtimeFps?: number
}): ComfyDurationContract {
  const definition = canonicalDurationDefinition(input.variableDefinitions)
  if (!definition) return { kind: 'unconstrained' }

  const constrainedBindings = input.bindings.filter((binding) => (
    binding.variable === definition.name
    && binding.numericTransform?.allowedTargetValues !== undefined
  ))
  if (constrainedBindings.length > 0) {
    const [first, ...remaining] = constrainedBindings
    const options = invertBinding(first!.numericTransform!, input.runtimeFps)
      .filter((seconds) => remaining.every((binding) => (
        forwardMatches(seconds, binding.numericTransform!, input.runtimeFps)
      )))
    return { kind: 'fixed', options: sortedUnique(options), nativeConstrained: true }
  }

  const legacyOptions = definition.options?.filter(positive) ?? []
  return legacyOptions.length > 0
    ? { kind: 'fixed', options: sortedUnique(legacyOptions) }
    : { kind: 'unconstrained' }
}
