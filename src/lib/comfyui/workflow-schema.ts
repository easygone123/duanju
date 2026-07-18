import { COMFY_ERROR_CODE, ComfyError } from './errors'
import { decimalEquals } from './numeric-binding'
import type {
  ComfyApiWorkflow,
  ComfyVariableDefinition,
  ComfyVariableType,
  ComfyVariableValue,
  ComfyWorkflowPurpose,
  WorkflowContractInput,
  WorkflowValidationIssue,
} from './types'
import { COMFY_REFERENCE_UPLOAD_LIMIT } from './types'

const PLACEHOLDER_PATTERN = /\$\{([^{}]+)\}/g
const NUMERIC_LINK_INDEX = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const BLOCKED_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/
const VARIABLE_TYPES = new Set<ComfyVariableType>([
  'string', 'number', 'boolean', 'image_ref', 'image_ref_list', 'video_ref',
])
const BINDING_TRANSFORMS = new Set([
  'filename', 'image_ref', 'filename_list', 'filename_at', 'bernini_image_slots',
])
const NUMERIC_TRANSFORM_KEYS = new Set([
  'sourceUnit', 'targetUnit', 'output', 'fps', 'rounding', 'frameOffset',
  'allowedTargetValues',
])
const NUMERIC_FPS_KEYS = new Set(['source', 'variable', 'fallback'])
const NUMERIC_ROUNDING = new Set(['round', 'floor', 'ceil'])

export function validateComfyApiWorkflow(raw: unknown): ComfyApiWorkflow {
  const issues = collectFormatIssues(raw)
  if (issues.length > 0) {
    throw new ComfyError(COMFY_ERROR_CODE.WORKFLOW_FORMAT_INVALID, issues[0].message, {
      details: issues,
    })
  }

  return cloneValue(raw as ComfyApiWorkflow)
}

export function discoverComfyPlaceholders(graph: ComfyApiWorkflow): string[] {
  const placeholders = new Set<string>()
  for (const node of Object.values(graph)) {
    visitStrings(node.inputs, (value) => {
      for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
        placeholders.add(match[1])
      }
    })
  }
  return [...placeholders]
}

export function validateWorkflowContract(input: WorkflowContractInput): WorkflowValidationIssue[] {
  let graph: ComfyApiWorkflow
  try {
    graph = validateComfyApiWorkflow(input.graph)
  } catch (error) {
    if (error instanceof ComfyError && Array.isArray(error.details)) {
      return cloneValue(error.details as WorkflowValidationIssue[])
    }
    return [issue('COMFY_API_FORMAT_INVALID', '$', 'Workflow API Format is invalid.')]
  }

  const issues: WorkflowValidationIssue[] = []
  const purpose = resolveComfyWorkflowPurpose(input.purpose)
  if (!purpose) {
    issues.push(issue(
      'COMFY_WORKFLOW_PURPOSE_INVALID', 'purpose', 'Workflow purpose is invalid.',
    ))
  }
  const rawDefinitions: unknown[] = Array.isArray(input.variableDefinitions)
    ? input.variableDefinitions
    : []
  const rawBindings: unknown[] = Array.isArray(input.bindings) ? input.bindings : []
  const rawOutputs: unknown[] = Array.isArray(input.outputs) ? input.outputs : []
  if (!Array.isArray(input.variableDefinitions)) {
    issues.push(issue(
      'COMFY_VARIABLE_DEFINITIONS_INVALID', 'variableDefinitions',
      'Variable definitions must be an array.',
    ))
  }
  if (!Array.isArray(input.bindings)) {
    issues.push(issue('COMFY_BINDINGS_INVALID', 'bindings', 'Bindings must be an array.'))
  }
  if (!Array.isArray(input.outputs)) {
    issues.push(issue('COMFY_OUTPUTS_INVALID', 'outputs', 'Outputs must be an array.'))
  }

  const definitions = validateDefinitions(rawDefinitions, issues)
  const placeholders = new Set(discoverComfyPlaceholders(graph))
  for (const placeholder of placeholders) {
    if (!definitions.has(placeholder)) {
      issues.push(issue(
        'COMFY_VARIABLE_UNDECLARED',
        `variables.${placeholder}`,
        `Placeholder "${placeholder}" has no variable definition.`,
      ))
    }
  }

  rawBindings.forEach((rawBinding, index) => {
    const path = `bindings.${index}`
    if (!isObject(rawBinding)) {
      issues.push(issue('COMFY_BINDING_INVALID', path, 'Binding must be an object.'))
      return
    }
    const binding = rawBinding
    const nodeIdValid = typeof binding.nodeId === 'string' && binding.nodeId.length > 0
    const nodeExists = nodeIdValid && Object.hasOwn(graph, binding.nodeId as string)
    const inputPathValid = isSafeDottedPath(binding.inputPath)
    const variableValid = isValidVariableName(binding.variable)
    const valueTypeValid = typeof binding.valueType === 'string'
      && VARIABLE_TYPES.has(binding.valueType as ComfyVariableType)
    const transformValid = binding.transform === undefined
      || (typeof binding.transform === 'string' && BINDING_TRANSFORMS.has(binding.transform))
    const missingPolicyValid = binding.missingValuePolicy === undefined
      || binding.missingValuePolicy === 'preserve_original'
    const definition = variableValid ? definitions.get(binding.variable as string) : undefined
    const valueIndexValid = binding.transform === 'filename_at'
      ? Number.isInteger(binding.valueIndex) && (binding.valueIndex as number) >= 0
        && (definition?.maxItems === undefined
          || (binding.valueIndex as number) < definition.maxItems)
      : binding.valueIndex === undefined

    if (!nodeIdValid) {
      issues.push(issue(
        'COMFY_BINDING_NODE_INVALID', `${path}.nodeId`, 'Binding nodeId is invalid.',
      ))
    } else if (!nodeExists) {
      issues.push(issue('COMFY_BINDING_NODE_MISSING', `${path}.nodeId`, 'Binding node is missing.'))
    }
    if (!inputPathValid) {
      issues.push(issue('COMFY_BINDING_PATH_UNSAFE', `${path}.inputPath`, 'Binding path is unsafe.'))
    }
    if (!variableValid) {
      issues.push(issue(
        'COMFY_BINDING_VARIABLE_INVALID', `${path}.variable`, 'Binding variable is invalid.',
      ))
    } else if (!definition) {
      issues.push(issue(
        'COMFY_VARIABLE_UNDECLARED', `${path}.variable`, 'Binding variable is undeclared.',
      ))
    }
    if (!valueTypeValid) {
      issues.push(issue(
        'COMFY_BINDING_VALUE_TYPE_INVALID', `${path}.valueType`, 'Binding valueType is invalid.',
      ))
    } else if (definition && definition.type !== binding.valueType) {
      issues.push(issue(
        'COMFY_BINDING_TYPE_MISMATCH', `${path}.valueType`,
        'Binding valueType does not match its variable definition.',
      ))
    }
    if (!transformValid) {
      issues.push(issue(
        'COMFY_BINDING_TRANSFORM_INVALID', `${path}.transform`, 'Binding transform is unsupported.',
      ))
    } else if (
      binding.transform !== undefined
      && definition
      && !isComfyTransformCompatible(binding.transform as string, definition.type)
    ) {
      issues.push(issue(
        'COMFY_BINDING_TRANSFORM_TYPE_INVALID', `${path}.transform`,
        'Binding transform is incompatible with its variable type.',
      ))
    }
    if (binding.numericTransform !== undefined && !validateNumericTransform({
      transform: binding.numericTransform,
      bindingValueType: binding.valueType,
      mediaTransform: binding.transform,
      definition,
      definitions,
      targetValue: nodeExists && inputPathValid
        ? readDottedPath(graph[binding.nodeId as string].inputs, binding.inputPath as string)
        : undefined,
    })) {
      issues.push(issue(
        'COMFY_BINDING_NUMERIC_TRANSFORM_INVALID', `${path}.numericTransform`,
        'Binding numeric transform is invalid.',
      ))
    }
    if (binding.transform === 'bernini_image_slots' && nodeIdValid) {
      const target = graph[binding.nodeId as string]
      if (target?.class_type !== 'BerniniStudio' || binding.inputPath !== 'image0') {
        issues.push(issue(
          'COMFY_BINDING_TRANSFORM_TARGET_INVALID', `${path}.transform`,
          'Bernini image slots require a BerniniStudio.image0 binding.',
        ))
      }
    }
    if (!missingPolicyValid) {
      issues.push(issue(
        'COMFY_BINDING_MISSING_POLICY_INVALID', `${path}.missingValuePolicy`,
        'Binding missing value policy is unsupported.',
      ))
    }
    if (!valueIndexValid) {
      issues.push(issue(
        'COMFY_BINDING_VALUE_INDEX_INVALID', `${path}.valueIndex`,
        'filename_at bindings require a nonnegative valueIndex within maxItems.',
      ))
    }
  })

  rawDefinitions.forEach((rawDefinition, index) => {
    if (!isObject(rawDefinition)) return
    const definition = rawDefinition
    if (
      typeof definition.name !== 'string'
      || !isValidVariableName(definition.name)
      || typeof definition.required !== 'boolean'
      || !VARIABLE_TYPES.has(definition.type as ComfyVariableType)
    ) return
    if (definition.required || definition.defaultValue !== undefined
      || definition.missingValuePolicy === 'preserve_original') return
    const relatedBindings = rawBindings.filter((rawBinding) =>
      isObject(rawBinding) && rawBinding.variable === definition.name)
    const bindingsPreserveOriginal = relatedBindings.length > 0
      && relatedBindings.every(
        (rawBinding) => isObject(rawBinding)
          && rawBinding.missingValuePolicy === 'preserve_original',
      )
    if (placeholders.has(definition.name) || !bindingsPreserveOriginal) {
      issues.push(issue(
        'COMFY_VARIABLE_MISSING_POLICY_REQUIRED', `variableDefinitions.${index}`,
        'Optional variables need a default or preserve_original policy.',
      ))
    }
  })

  if (rawOutputs.length === 0) {
    issues.push(issue('COMFY_OUTPUT_REQUIRED', 'outputs', 'At least one output is required.'))
  }
  if (rawOutputs.length > 64) {
    issues.push(issue('COMFY_OUTPUT_LIMIT_EXCEEDED', 'outputs', 'At most 64 outputs are allowed.'))
  }
  const validOutputs = rawOutputs.filter(isObject)
  if (validOutputs.filter((output) => output.primary === true).length !== 1) {
    issues.push(issue(
      'COMFY_OUTPUT_PRIMARY_INVALID', 'outputs', 'Exactly one output must be primary.',
    ))
  }
  rawOutputs.forEach((rawOutput, index) => {
    const path = `outputs.${index}`
    if (!isObject(rawOutput)) {
      issues.push(issue('COMFY_OUTPUT_INVALID', path, 'Output binding must be an object.'))
      return
    }
    const output = rawOutput
    if (typeof output.nodeId !== 'string' || !Object.hasOwn(graph, output.nodeId)) {
      issues.push(issue('COMFY_OUTPUT_NODE_MISSING', `${path}.nodeId`, 'Output node is missing.'))
    }
    if (!isSafeDottedPath(output.fieldPath)) {
      issues.push(issue('COMFY_OUTPUT_PATH_UNSAFE', `${path}.fieldPath`, 'Output path is unsafe.'))
    }
    if (output.mediaType !== 'image' && output.mediaType !== 'video') {
      issues.push(issue('COMFY_OUTPUT_MEDIA_TYPE_INVALID', `${path}.mediaType`, 'Media type is invalid.'))
    }
  })

  if (purpose === 'upscale') {
    validateUpscaleContract(rawDefinitions, rawBindings, rawOutputs, issues)
  }

  return issues
}

function validateNumericTransform(input: {
  transform: unknown
  bindingValueType: unknown
  mediaTransform: unknown
  definition: ComfyVariableDefinition | undefined
  definitions: Map<string, ComfyVariableDefinition>
  targetValue: unknown
}): boolean {
  const transform = input.transform
  if (!isObject(transform) || !hasOnlyKeys(transform, NUMERIC_TRANSFORM_KEYS)) return false
  if (
    input.bindingValueType !== 'number'
    || input.definition?.type !== 'number'
    || input.mediaTransform !== undefined
    || !isFiniteNumericScalarLiteral(input.targetValue)
  ) return false

  const legalPair = (transform.sourceUnit === 'seconds'
      && (transform.targetUnit === 'seconds' || transform.targetUnit === 'frames'))
    || (transform.sourceUnit === 'fps' && transform.targetUnit === 'fps')
  if (!legalPair || (transform.output !== 'number' && transform.output !== 'numeric_string')) {
    return false
  }

  if (transform.targetUnit === 'frames') {
    if (!isObject(transform.fps) || !hasOnlyKeys(transform.fps, NUMERIC_FPS_KEYS)) return false
    if (
      transform.fps.source !== 'runtime_then_fallback'
      || transform.fps.variable !== 'fps'
      || input.definitions.get('fps')?.type !== 'number'
      || typeof transform.fps.fallback !== 'number'
      || !Number.isFinite(transform.fps.fallback)
      || transform.fps.fallback <= 0
      || typeof transform.rounding !== 'string'
      || !NUMERIC_ROUNDING.has(transform.rounding)
      || (transform.frameOffset !== 0 && transform.frameOffset !== 1)
    ) return false
  } else if (
    Object.hasOwn(transform, 'fps')
    || Object.hasOwn(transform, 'rounding')
    || Object.hasOwn(transform, 'frameOffset')
  ) {
    return false
  }

  if (transform.allowedTargetValues === undefined) return true
  if (!Array.isArray(transform.allowedTargetValues)
    || transform.allowedTargetValues.length === 0) return false

  const allowed = transform.allowedTargetValues
  for (const value of allowed) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return false
    if (transform.targetUnit === 'frames' && !Number.isSafeInteger(value)) return false
  }
  const sorted = [...allowed].sort((left, right) => left - right)
  return sorted.every((value, index) => index === 0 || (
    transform.targetUnit === 'frames'
      ? sorted[index - 1] !== value
      : !decimalEquals(sorted[index - 1], value)
  ))
}

function isFiniteNumericScalarLiteral(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return trimmed.length > 0
    && NUMERIC_LINK_INDEX.test(trimmed)
    && Number.isFinite(Number(trimmed))
}

function readDottedPath(root: Record<string, unknown>, path: string): unknown {
  let current: unknown = root
  for (const segment of path.split('.')) {
    if ((!isObject(current) && !Array.isArray(current)) || !Object.hasOwn(current, segment)) {
      return undefined
    }
    current = current[segment as keyof typeof current]
  }
  return current
}

function hasOnlyKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key))
}

export function resolveComfyWorkflowPurpose(value: unknown): ComfyWorkflowPurpose | null {
  if (value === undefined || value === null) return 'generation'
  return value === 'generation' || value === 'upscale' ? value : null
}

function validateUpscaleContract(
  definitions: unknown[],
  bindings: unknown[],
  outputs: unknown[],
  issues: WorkflowValidationIssue[],
) {
  const mediaDefinitions = definitions.filter((definition) => isObject(definition)
    && ['image_ref', 'image_ref_list', 'video_ref'].includes(String(definition.type)))
  const requiredImageDefinitions = mediaDefinitions.filter((definition) => isObject(definition)
    && definition.type === 'image_ref' && definition.required === true)
  const requiredImageNames = new Set(requiredImageDefinitions
    .map((definition) => isObject(definition) ? definition.name : undefined)
    .filter((name): name is string => typeof name === 'string'))
  const mediaBindings = bindings.filter((binding) => isObject(binding)
    && ['image_ref', 'image_ref_list', 'video_ref'].includes(String(binding.valueType)))
  const imageBindings = mediaBindings.filter((binding) => isObject(binding)
    && binding.valueType === 'image_ref'
    && typeof binding.variable === 'string'
    && requiredImageNames.has(binding.variable)
    && (binding.transform === 'filename' || binding.transform === 'image_ref'))

  if (mediaDefinitions.length === 0 && imageBindings.length === 0) {
    issues.push(issue(
      'COMFY_UPSCALE_INPUT_REQUIRED', 'bindings',
      'Upscale workflows require one bound image input.',
    ))
  } else if (
    mediaDefinitions.length !== 1
    || requiredImageDefinitions.length !== 1
    || mediaBindings.length !== 1
    || imageBindings.length !== 1
  ) {
    issues.push(issue(
      'COMFY_UPSCALE_BINDINGS_INVALID', 'bindings',
      'Upscale workflows require exactly one required image input binding.',
    ))
  }

  if (outputs.length === 0) {
    issues.push(issue(
      'COMFY_UPSCALE_OUTPUT_REQUIRED', 'outputs',
      'Upscale workflows require one image output.',
    ))
  } else if (
    outputs.length !== 1
    || !isObject(outputs[0])
    || outputs[0].mediaType !== 'image'
  ) {
    issues.push(issue(
      'COMFY_UPSCALE_BINDINGS_INVALID', 'outputs',
      'Upscale workflows require exactly one image output.',
    ))
  }
}

export function isComfyTransformCompatible(
  transform: string,
  type: ComfyVariableType,
): boolean {
  if (transform === 'filename_list') return type === 'image_ref_list'
  if (transform === 'filename_at') return type === 'image_ref_list'
  if (transform === 'bernini_image_slots') return type === 'image_ref_list'
  return (transform === 'filename' || transform === 'image_ref')
    && (type === 'image_ref' || type === 'video_ref')
}

/*
 * Paths are interpreted relative to node.inputs or a declared node history output.
 * Keeping this predicate defensive avoids leaking TypeErrors from JSON-authored contracts.
 */
export function isSafeDottedPath(path: unknown): path is string {
  if (typeof path !== 'string') return false
  const segments = path.split('.')
  return segments.length > 0 && segments.every((segment) =>
    SAFE_PATH_SEGMENT.test(segment) && !BLOCKED_PATH_SEGMENTS.has(segment))
}

function validateDefinitions(
  variableDefinitions: unknown[],
  issues: WorkflowValidationIssue[],
): Map<string, ComfyVariableDefinition> {
  const definitions = new Map<string, ComfyVariableDefinition>()
  const seenNames = new Set<string>()
  variableDefinitions.forEach((rawDefinition, index) => {
    const path = `variableDefinitions.${index}`
    if (!isObject(rawDefinition)) {
      issues.push(issue(
        'COMFY_VARIABLE_DEFINITION_INVALID', path, 'Variable definition must be an object.',
      ))
      return
    }
    const definition = rawDefinition
    const nameValid = isValidVariableName(definition.name)
    const duplicateName = nameValid && seenNames.has(definition.name as string)
    if (!nameValid) {
      issues.push(issue('COMFY_VARIABLE_NAME_INVALID', `${path}.name`, 'Variable name is invalid.'))
    } else if (duplicateName) {
      issues.push(issue(
        'COMFY_VARIABLE_DUPLICATE', `${path}.name`, 'Variable name must be unique.',
      ))
      definitions.delete(definition.name as string)
    } else {
      seenNames.add(definition.name as string)
    }
    const typeValid = typeof definition.type === 'string'
      && VARIABLE_TYPES.has(definition.type as ComfyVariableType)
    if (!typeValid) {
      issues.push(issue('COMFY_VARIABLE_TYPE_INVALID', `${path}.type`, 'Variable type is invalid.'))
    }
    const requiredValid = typeof definition.required === 'boolean'
    if (!requiredValid) {
      issues.push(issue(
        'COMFY_VARIABLE_REQUIRED_INVALID', `${path}.required`, 'Variable required must be boolean.',
      ))
    }
    const missingPolicyValid = definition.missingValuePolicy === undefined
      || definition.missingValuePolicy === 'preserve_original'
    if (!missingPolicyValid) {
      issues.push(issue(
        'COMFY_VARIABLE_MISSING_POLICY_INVALID', `${path}.missingValuePolicy`,
        'Variable missing value policy is unsupported.',
      ))
    }
    const maxItemsValid = definition.maxItems === undefined
      || (definition.type === 'image_ref_list'
        && Number.isInteger(definition.maxItems)
        && (definition.maxItems as number) > 0
        && (definition.maxItems as number) <= COMFY_REFERENCE_UPLOAD_LIMIT)
    if (!maxItemsValid) {
      issues.push(issue(
        'COMFY_VARIABLE_MAX_ITEMS_INVALID', `${path}.maxItems`,
        `maxItems must be an integer from 1 to ${COMFY_REFERENCE_UPLOAD_LIMIT} for image_ref_list variables.`,
      ))
    }
    if (
      definition.defaultValue !== undefined
      && (!typeValid || !matchesComfyVariableType(
        definition.defaultValue,
        definition.type as ComfyVariableType,
      ))
    ) {
      issues.push(issue(
        'COMFY_VARIABLE_DEFAULT_TYPE_INVALID', `${path}.defaultValue`,
        'Variable default does not match its declared type.',
      ))
    }
    if (definition.options !== undefined && (
      !Array.isArray(definition.options)
      || definition.options.length === 0
      || definition.options.length > 128
      || definition.options.some((value) => !typeValid
        || !matchesComfyVariableType(value, definition.type as ComfyVariableType))
    )) {
      issues.push(issue(
        'COMFY_VARIABLE_OPTIONS_INVALID', `${path}.options`,
        'Variable options must be a bounded list matching the declared scalar type.',
      ))
    }
    if (nameValid && !duplicateName && !definitions.has(definition.name as string)
      && typeValid && requiredValid && missingPolicyValid && maxItemsValid) {
      definitions.set(definition.name as string, definition as unknown as ComfyVariableDefinition)
    }
  })
  return definitions
}

export function matchesComfyVariableType(
  value: unknown,
  type: ComfyVariableType,
): value is ComfyVariableValue {
  if (type === 'string') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'image_ref_list') return Array.isArray(value) && value.every(isMediaRef)
  return isMediaRef(value)
}

function isMediaRef(value: unknown): boolean {
  return isObject(value) && typeof value.storageKey === 'string'
}

function isValidVariableName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function issue(code: string, path: string, message: string): WorkflowValidationIssue {
  return { code, path, message }
}

function collectFormatIssues(raw: unknown): WorkflowValidationIssue[] {
  if (isUiFormat(raw)) {
    return [
      {
        code: 'COMFY_UI_FORMAT_UNSUPPORTED',
        path: '$',
        message: 'ComfyUI UI Format is not supported; export the workflow in API Format.',
      },
    ]
  }

  if (!isObject(raw)) {
    return [formatIssue('$', 'Workflow must be a non-array API Format object.')]
  }

  const entries = Object.entries(raw)
  if (entries.length === 0) {
    return [formatIssue('$', 'Workflow must contain at least one API Format node.')]
  }

  const issues: WorkflowValidationIssue[] = []
  const nodeIds = new Set(entries.map(([nodeId]) => nodeId))
  for (const [nodeId, value] of entries) {
    if (nodeId.trim().length === 0) {
      issues.push(formatIssue('$', 'Workflow node IDs must be nonempty strings.'))
      continue
    }
    if (!isObject(value)) {
      issues.push(formatIssue(nodeId, 'Workflow nodes must be objects.'))
      continue
    }

    validateNode(nodeId, value, nodeIds, issues)
  }
  return issues
}

function validateNode(
  nodeId: string,
  value: Record<string, unknown>,
  nodeIds: Set<string>,
  issues: WorkflowValidationIssue[],
): void {
  if (typeof value.class_type !== 'string' || value.class_type.trim().length === 0) {
    issues.push(formatIssue(`${nodeId}.class_type`, 'Node class_type must be a nonempty string.'))
  }
  if (!isObject(value.inputs)) {
    issues.push(formatIssue(`${nodeId}.inputs`, 'Node inputs must be an object.'))
    return
  }

  visitValues(value.inputs, (nestedValue, path) => {
    if (!isPotentialLink(nestedValue, nodeIds)) return
    const [linkedNodeId, outputIndex] = nestedValue
    if (!nodeIds.has(linkedNodeId)) {
      issues.push(formatIssue(path, `Link references unknown node "${linkedNodeId}".`))
    }
    if (typeof outputIndex !== 'number' || !Number.isInteger(outputIndex) || outputIndex < 0) {
      issues.push(formatIssue(path, 'Link output index must be a nonnegative integer.'))
    }
  }, `${nodeId}.inputs`)
}

function isPotentialLink(value: unknown, nodeIds: Set<string>): value is [string, unknown] {
  if (!Array.isArray(value) || value.length !== 2
    || typeof value[0] !== 'string' || value[0].length === 0) return false
  return typeof value[1] === 'number'
    || (nodeIds.has(value[0])
      && typeof value[1] === 'string'
      && NUMERIC_LINK_INDEX.test(value[1]))
}

function isUiFormat(value: unknown): boolean {
  return isObject(value) && Array.isArray(value.nodes)
    && (Array.isArray(value.links) || 'last_node_id' in value || 'last_link_id' in value)
}

function formatIssue(path: string, message: string): WorkflowValidationIssue {
  return { code: 'COMFY_API_FORMAT_INVALID', path, message }
}

function visitStrings(value: unknown, visitor: (value: string) => void): void {
  if (typeof value === 'string') {
    visitor(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) visitStrings(item, visitor)
    return
  }
  if (isObject(value)) {
    for (const nestedValue of Object.values(value)) visitStrings(nestedValue, visitor)
  }
}

function visitValues(
  value: unknown,
  visitor: (value: unknown, path: string) => void,
  path: string,
): void {
  visitor(value, path)
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitValues(item, visitor, `${path}.${index}`))
    return
  }
  if (isObject(value)) {
    for (const [key, nestedValue] of Object.entries(value)) {
      visitValues(nestedValue, visitor, `${path}.${key}`)
    }
  }
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T
  if (!isObject(value)) return value

  const cloned: Record<string, unknown> = {}
  for (const [key, nestedValue] of Object.entries(value)) {
    Object.defineProperty(cloned, key, {
      value: cloneValue(nestedValue),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return cloned as T
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
