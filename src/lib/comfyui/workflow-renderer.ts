import { COMFY_ERROR_CODE, ComfyError } from './errors'
import {
  discoverComfyPlaceholders,
  isSafeDottedPath,
  matchesComfyVariableType,
  validateComfyApiWorkflow,
} from './workflow-schema'
import type {
  ComfyApiWorkflow,
  ComfyInputBinding,
  ComfyUploadedFile,
  ComfyVariableValue,
  RenderWorkflowInput,
} from './types'

const WHOLE_PLACEHOLDER = /^\$\{([^{}]+)\}$/
const EMBEDDED_PLACEHOLDER = /\$\{([^{}]+)\}/g

export function renderComfyWorkflow(input: RenderWorkflowInput): ComfyApiWorkflow {
  const rendered = validateComfyApiWorkflow(input.graph)
  const variables = resolveVariables(input, rendered)

  for (const node of Object.values(rendered)) {
    node.inputs = renderValue(node.inputs, variables) as Record<string, unknown>
  }

  for (const binding of input.bindings) {
    assertSafeBinding(rendered, binding)
    const value = variables[binding.variable]
    if (value !== undefined) {
      const transformed = transformBindingValue(binding, value, input.uploads)
      setPath(rendered[binding.nodeId].inputs, binding.inputPath, transformed)
    }
  }

  return rendered
}

function assertSafeBinding(graph: ComfyApiWorkflow, binding: ComfyInputBinding): void {
  if (!Object.hasOwn(graph, binding.nodeId)) {
    throw bindingError(binding, `Binding references unknown node "${binding.nodeId}".`)
  }
  if (!isSafeDottedPath(binding.inputPath)) {
    throw bindingError(binding, `Unsafe input path "${binding.inputPath}".`)
  }
  if (
    binding.transform !== undefined
    && !['filename', 'image_ref', 'filename_list'].includes(binding.transform)
  ) {
    throw bindingError(binding, `Unsupported transform "${String(binding.transform)}".`)
  }
}

function transformBindingValue(
  binding: ComfyInputBinding,
  value: ComfyVariableValue,
  uploads: RenderWorkflowInput['uploads'],
): unknown {
  if (!binding.transform) return cloneValue(value)

  const upload = uploads[binding.variable]
  if (binding.transform === 'filename_list') {
    if (!Array.isArray(upload)) {
      throw bindingError(binding, `Upload list for "${binding.variable}" is missing.`)
    }
    return upload.map((file) => file.name)
  }
  if (!isUploadedFile(upload)) {
    throw bindingError(binding, `Upload for "${binding.variable}" is missing.`)
  }
  if (binding.transform === 'filename') return upload.name
  return {
    filename: upload.name,
    subfolder: upload.subfolder,
    type: upload.type,
  }
}

function isUploadedFile(value: unknown): value is ComfyUploadedFile {
  return isObject(value)
    && typeof value.name === 'string'
    && typeof value.subfolder === 'string'
    && typeof value.type === 'string'
}

function bindingError(binding: ComfyInputBinding, message: string): ComfyError {
  return new ComfyError(COMFY_ERROR_CODE.WORKFLOW_BINDING_INVALID, message, {
    details: { nodeId: binding.nodeId, inputPath: binding.inputPath },
  })
}

function resolveVariables(
  input: RenderWorkflowInput,
  graph: ComfyApiWorkflow,
): Record<string, ComfyVariableValue | undefined> {
  const resolved = cloneValue(input.variables)
  const placeholders = new Set(discoverComfyPlaceholders(graph))
  for (const definition of input.variableDefinitions) {
    const value = Object.hasOwn(resolved, definition.name)
      ? resolved[definition.name]
      : undefined
    if (value !== undefined) {
      if (!matchesComfyVariableType(value, definition.type)) {
        throw new ComfyError(
          COMFY_ERROR_CODE.WORKFLOW_BINDING_INVALID,
          `Workflow variable "${definition.name}" has the wrong type.`,
          { details: { variable: definition.name, reason: 'type' } },
        )
      }
      continue
    }
    if (definition.required) {
      throw new ComfyError(
        COMFY_ERROR_CODE.WORKFLOW_BINDING_INVALID,
        `Required workflow variable "${definition.name}" is missing.`,
        { details: { variable: definition.name, reason: 'required' } },
      )
    }
    if (definition.defaultValue !== undefined) {
      if (!matchesComfyVariableType(definition.defaultValue, definition.type)) {
        throw new ComfyError(
          COMFY_ERROR_CODE.WORKFLOW_BINDING_INVALID,
          `Default for workflow variable "${definition.name}" has the wrong type.`,
          { details: { variable: definition.name, reason: 'type' } },
        )
      }
      resolved[definition.name] = cloneValue(definition.defaultValue)
      continue
    }
    if (definition.missingValuePolicy === 'preserve_original') continue

    const relatedBindings = input.bindings.filter(
      (binding) => binding.variable === definition.name,
    )
    const bindingsPreserveOriginal = relatedBindings.length > 0
      && relatedBindings.every(
        (binding) => binding.missingValuePolicy === 'preserve_original',
      )
    if (placeholders.has(definition.name) || !bindingsPreserveOriginal) {
      throw new ComfyError(
        COMFY_ERROR_CODE.WORKFLOW_BINDING_INVALID,
        `Optional workflow variable "${definition.name}" has no missing value policy.`,
        { details: { variable: definition.name, reason: 'missing_policy' } },
      )
    }
  }
  return resolved
}

function renderValue(
  value: unknown,
  variables: Record<string, ComfyVariableValue | undefined>,
): unknown {
  if (typeof value === 'string') {
    const wholeMatch = WHOLE_PLACEHOLDER.exec(value)
    if (wholeMatch) {
      const replacement = Object.hasOwn(variables, wholeMatch[1])
        ? variables[wholeMatch[1]]
        : undefined
      return replacement === undefined ? value : cloneValue(replacement)
    }

    return value.replace(EMBEDDED_PLACEHOLDER, (placeholder, name: string) => {
      const replacement = Object.hasOwn(variables, name) ? variables[name] : undefined
      return replacement === undefined ? placeholder : String(replacement)
    })
  }

  if (Array.isArray(value)) {
    return value.map((item) => renderValue(item, variables))
  }

  if (isObject(value)) {
    const rendered: Record<string, unknown> = {}
    for (const [key, nestedValue] of Object.entries(value)) {
      defineValue(rendered, key, renderValue(nestedValue, variables))
    }
    return rendered
  }

  return value
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.')
  let cursor: Record<string, unknown> | unknown[] = target
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]
    const nested: unknown = readContainerValue(cursor, segment)
    if (isObject(nested) || Array.isArray(nested)) {
      cursor = nested
      continue
    }
    const container: Record<string, unknown> | unknown[] = /^\d+$/.test(segments[index + 1])
      ? []
      : {}
    writeContainerValue(cursor, segment, container)
    cursor = container
  }
  writeContainerValue(cursor, segments.at(-1) as string, value)
}

function readContainerValue(
  container: Record<string, unknown> | unknown[],
  segment: string,
): unknown {
  return Array.isArray(container) ? container[Number(segment)] : container[segment]
}

function writeContainerValue(
  container: Record<string, unknown> | unknown[],
  segment: string,
  value: unknown,
): void {
  if (Array.isArray(container)) {
    const index = Number(segment)
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new ComfyError(
        COMFY_ERROR_CODE.WORKFLOW_BINDING_INVALID,
        `Array input path segment "${segment}" must be a nonnegative integer.`,
      )
    }
    container[index] = value
    return
  }
  container[segment] = value
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T
  if (!isObject(value)) return value

  const cloned: Record<string, unknown> = {}
  for (const [key, nestedValue] of Object.entries(value)) {
    defineValue(cloned, key, cloneValue(nestedValue))
  }
  return cloned as T
}

function defineValue(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
