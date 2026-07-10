import { COMFY_ERROR_CODE, ComfyError } from './errors'
import type {
  ComfyApiWorkflow,
  ComfyVariableDefinition,
  ComfyVariableType,
  ComfyVariableValue,
  WorkflowContractInput,
  WorkflowValidationIssue,
} from './types'

const PLACEHOLDER_PATTERN = /\$\{([^{}]+)\}/g
const NUMERIC_LINK_INDEX = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const BLOCKED_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/
const VARIABLE_TYPES = new Set<ComfyVariableType>([
  'string', 'number', 'boolean', 'image_ref', 'image_ref_list', 'video_ref',
])
const BINDING_TRANSFORMS = new Set(['filename', 'image_ref', 'filename_list'])

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
  const definitions = validateDefinitions(input.variableDefinitions, issues)
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

  input.bindings.forEach((binding, index) => {
    const path = `bindings.${index}`
    const definition = definitions.get(binding.variable)
    if (!Object.hasOwn(graph, binding.nodeId)) {
      issues.push(issue('COMFY_BINDING_NODE_MISSING', `${path}.nodeId`, 'Binding node is missing.'))
    }
    if (!isSafeDottedPath(binding.inputPath)) {
      issues.push(issue('COMFY_BINDING_PATH_UNSAFE', `${path}.inputPath`, 'Binding path is unsafe.'))
    }
    if (!definition) {
      issues.push(issue(
        'COMFY_VARIABLE_UNDECLARED', `${path}.variable`, 'Binding variable is undeclared.',
      ))
    } else if (definition.type !== binding.valueType) {
      issues.push(issue(
        'COMFY_BINDING_TYPE_MISMATCH', `${path}.valueType`,
        'Binding valueType does not match its variable definition.',
      ))
    }
    if (binding.transform !== undefined && !BINDING_TRANSFORMS.has(binding.transform)) {
      issues.push(issue(
        'COMFY_BINDING_TRANSFORM_INVALID', `${path}.transform`, 'Binding transform is unsupported.',
      ))
    }
    if (
      binding.missingValuePolicy !== undefined
      && binding.missingValuePolicy !== 'preserve_original'
    ) {
      issues.push(issue(
        'COMFY_BINDING_MISSING_POLICY_INVALID', `${path}.missingValuePolicy`,
        'Binding missing value policy is unsupported.',
      ))
    }
  })

  input.variableDefinitions.forEach((definition, index) => {
    if (definition.required || definition.defaultValue !== undefined
      || definition.missingValuePolicy === 'preserve_original') return
    const relatedBindings = input.bindings.filter((binding) => binding.variable === definition.name)
    const bindingsPreserveOriginal = relatedBindings.length > 0
      && relatedBindings.every((binding) => binding.missingValuePolicy === 'preserve_original')
    if (placeholders.has(definition.name) || !bindingsPreserveOriginal) {
      issues.push(issue(
        'COMFY_VARIABLE_MISSING_POLICY_REQUIRED', `variableDefinitions.${index}`,
        'Optional variables need a default or preserve_original policy.',
      ))
    }
  })

  if (input.outputs.length === 0) {
    issues.push(issue('COMFY_OUTPUT_REQUIRED', 'outputs', 'At least one output is required.'))
  }
  if (input.outputs.filter((output) => output.primary).length !== 1) {
    issues.push(issue(
      'COMFY_OUTPUT_PRIMARY_INVALID', 'outputs', 'Exactly one output must be primary.',
    ))
  }
  input.outputs.forEach((output, index) => {
    const path = `outputs.${index}`
    if (!Object.hasOwn(graph, output.nodeId)) {
      issues.push(issue('COMFY_OUTPUT_NODE_MISSING', `${path}.nodeId`, 'Output node is missing.'))
    }
    if (!isSafeDottedPath(output.fieldPath)) {
      issues.push(issue('COMFY_OUTPUT_PATH_UNSAFE', `${path}.fieldPath`, 'Output path is unsafe.'))
    }
    if (output.mediaType !== 'image' && output.mediaType !== 'video') {
      issues.push(issue('COMFY_OUTPUT_MEDIA_TYPE_INVALID', `${path}.mediaType`, 'Media type is invalid.'))
    }
  })

  return issues
}

export function isSafeDottedPath(path: string): boolean {
  const segments = path.split('.')
  return segments.length > 0 && segments.every((segment) =>
    SAFE_PATH_SEGMENT.test(segment) && !BLOCKED_PATH_SEGMENTS.has(segment))
}

function validateDefinitions(
  variableDefinitions: ComfyVariableDefinition[],
  issues: WorkflowValidationIssue[],
): Map<string, ComfyVariableDefinition> {
  const definitions = new Map<string, ComfyVariableDefinition>()
  variableDefinitions.forEach((definition, index) => {
    const path = `variableDefinitions.${index}`
    if (definition.name.trim().length === 0 || definitions.has(definition.name)) {
      issues.push(issue('COMFY_VARIABLE_NAME_INVALID', `${path}.name`, 'Variable name is invalid.'))
      return
    }
    definitions.set(definition.name, definition)
    if (!VARIABLE_TYPES.has(definition.type)) {
      issues.push(issue('COMFY_VARIABLE_TYPE_INVALID', `${path}.type`, 'Variable type is invalid.'))
    }
    if (
      definition.defaultValue !== undefined
      && !matchesComfyVariableType(definition.defaultValue, definition.type)
    ) {
      issues.push(issue(
        'COMFY_VARIABLE_DEFAULT_TYPE_INVALID', `${path}.defaultValue`,
        'Variable default does not match its declared type.',
      ))
    }
  })
  return definitions
}

export function matchesComfyVariableType(
  value: ComfyVariableValue,
  type: ComfyVariableType,
): boolean {
  if (type === 'string') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'image_ref_list') return Array.isArray(value) && value.every(isMediaRef)
  return isMediaRef(value)
}

function isMediaRef(value: unknown): boolean {
  return isObject(value) && typeof value.storageKey === 'string'
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
