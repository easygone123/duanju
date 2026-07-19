import {
  canonicalDurationDefinition,
  resolveComfyDurationContract,
  type ComfyDurationContract,
} from './duration-contract'
import { decimalEquals } from './numeric-binding'
import type {
  ComfyInputBinding,
  ComfyMediaType,
  ComfyVariableDefinition,
} from './types'

export const COMFY_VIDEO_TEST_DURATION_REQUIRED = 'COMFY_VIDEO_TEST_DURATION_REQUIRED'
export const COMFY_VIDEO_TEST_DURATION_INVALID = 'COMFY_VIDEO_TEST_DURATION_INVALID'

export type VideoTestDurationContract =
  | { required: false; eligible: true }
  | {
      required: true
      eligible: false
      issueCode: typeof COMFY_VIDEO_TEST_DURATION_REQUIRED
    }
  | {
      required: true
      eligible: true
      variableName: string
      defaultSeconds: number
      targetUnit: 'seconds' | 'frames'
      definition: ComfyVariableDefinition
      durationContract: ComfyDurationContract
    }

interface VideoTestDurationInput {
  mediaType: ComfyMediaType
  variableDefinitions: readonly ComfyVariableDefinition[]
  bindings: readonly ComfyInputBinding[]
}

function missingDurationContract(): VideoTestDurationContract {
  return {
    required: true,
    eligible: false,
    issueCode: COMFY_VIDEO_TEST_DURATION_REQUIRED,
  }
}

export function deriveVideoTestDurationContract(
  input: VideoTestDurationInput,
): VideoTestDurationContract {
  if (input.mediaType !== 'video') return { required: false, eligible: true }

  const definition = canonicalDurationDefinition(input.variableDefinitions)
  if (!definition || definition.type !== 'number') return missingDurationContract()

  const durationBindings = input.bindings.filter((binding) => (
    binding.variable === definition.name
    && binding.valueType === 'number'
    && binding.numericTransform?.sourceUnit === 'seconds'
    && (binding.numericTransform.targetUnit === 'seconds'
      || binding.numericTransform.targetUnit === 'frames')
  ))
  if (durationBindings.length === 0) return missingDurationContract()

  const durationContract = resolveComfyDurationContract({
    variableDefinitions: input.variableDefinitions,
    bindings: input.bindings,
  })
  const options = durationContract.kind === 'fixed' ? durationContract.options : []
  if (durationContract.kind === 'fixed' && options.length === 0) {
    return missingDurationContract()
  }

  return {
    required: true,
    eligible: true,
    variableName: definition.name,
    defaultSeconds: options[0] ?? 1,
    targetUnit: durationBindings.some(
      (binding) => binding.numericTransform?.targetUnit === 'frames',
    ) ? 'frames' : 'seconds',
    definition,
    durationContract,
  }
}

export function validateVideoTestDurationValue(
  contract: Extract<VideoTestDurationContract, { required: true; eligible: true }>,
  value: unknown,
): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return false
  return contract.durationContract.kind !== 'fixed'
    || contract.durationContract.options.some((option) => decimalEquals(option, value))
}
