import { COMFY_ERROR_CODE, ComfyError } from './errors'
import { convertComfyNumericBinding } from './numeric-binding'
import {
  discoverComfyPlaceholders,
  isComfyTransformCompatible,
  isSafeDottedPath,
  matchesComfyVariableType,
  validateComfyApiWorkflow,
} from './workflow-schema'
import type {
  ComfyApiWorkflow,
  ComfyInputBinding,
  ComfyUploadedFile,
  ComfyVariableDefinition,
  ComfyVariableValue,
  RenderWorkflowInput,
} from './types'
import { parseLtxDirectorTimelineSpec, renderLtxDirectorTimeline } from './ltx-director'

const WHOLE_PLACEHOLDER = /^\$\{([^{}]+)\}$/
const EMBEDDED_PLACEHOLDER = /\$\{([^{}]+)\}/g
const SKIP_BINDING = Symbol('skip-binding')

export function renderComfyWorkflow(input: RenderWorkflowInput): ComfyApiWorkflow {
  const rendered = validateComfyApiWorkflow(input.graph)
  const definitions = buildDefinitionMap(input.variableDefinitions)
  for (const placeholder of discoverComfyPlaceholders(rendered)) {
    if (!definitions.has(placeholder)) throw undeclaredVariable(placeholder)
  }
  for (const binding of input.bindings) {
    assertSafeBinding(rendered, binding)
    const definition = definitions.get(binding.variable)
    if (!definition) throw undeclaredVariable(binding.variable)
    if (definition.type !== binding.valueType) {
      throw new ComfyError(
        COMFY_ERROR_CODE.WORKFLOW_BINDING_INVALID,
        `Binding type for workflow variable "${binding.variable}" does not match its definition.`,
        { details: { variable: binding.variable, reason: 'binding_type' } },
      )
    }
    if (
      binding.transform !== undefined
      && !isComfyTransformCompatible(binding.transform, definition.type)
    ) {
      throw new ComfyError(
        COMFY_ERROR_CODE.WORKFLOW_BINDING_INVALID,
        `Transform for workflow variable "${binding.variable}" is incompatible with its type.`,
        { details: { variable: binding.variable, reason: 'transform_type' } },
      )
    }
    if (binding.numericTransform !== undefined
      && (binding.valueType !== 'number' || binding.transform !== undefined)) {
      throw bindingError(
        binding,
        `Numeric transform for workflow variable "${binding.variable}" is incompatible.`,
      )
    }
  }
  const variables = resolveVariables(input, rendered)

  for (const node of Object.values(rendered)) {
    node.inputs = renderValue(node.inputs, variables) as Record<string, unknown>
  }

  for (const binding of input.bindings) {
    const value = variables[binding.variable]
    if (value !== undefined) {
      if (binding.transform === 'bernini_image_slots') {
        applyBerniniImageSlots(rendered, binding, value, input.uploads)
        continue
      }
      if (binding.transform === 'ltx_director_timeline') {
        applyLtxDirectorTimeline(rendered, binding, value, variables, input.uploads)
        continue
      }
      const transformed = transformBindingValue(
        binding,
        value,
        variables,
        input.uploads,
        input.onNumericConversion,
      )
      if (transformed !== SKIP_BINDING) {
        setPath(rendered[binding.nodeId].inputs, binding.inputPath, transformed)
      }
    }
  }

  return validateComfyApiWorkflow(rendered)
}

function buildDefinitionMap(
  variableDefinitions: ComfyVariableDefinition[],
): Map<string, ComfyVariableDefinition> {
  const definitions = new Map<string, ComfyVariableDefinition>()
  for (const definition of variableDefinitions) {
    if (definitions.has(definition.name)) {
      throw new ComfyError(
        COMFY_ERROR_CODE.WORKFLOW_BINDING_INVALID,
        `Workflow variable definition "${definition.name}" is duplicated.`,
        { details: { variable: definition.name, reason: 'duplicate_definition' } },
      )
    }
    definitions.set(definition.name, definition)
  }
  return definitions
}

function undeclaredVariable(variable: string): ComfyError {
  return new ComfyError(
    COMFY_ERROR_CODE.WORKFLOW_BINDING_INVALID,
    `Workflow variable "${variable}" is undeclared.`,
    { details: { variable, reason: 'undeclared' } },
  )
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
    && ![
      'filename', 'image_ref', 'filename_list', 'filename_at', 'bernini_image_slots',
      'ltx_director_timeline',
    ].includes(binding.transform)
  ) {
    throw bindingError(binding, `Unsupported transform "${String(binding.transform)}".`)
  }
  if (binding.transform === 'bernini_image_slots'
    && (graph[binding.nodeId].class_type !== 'BerniniStudio' || binding.inputPath !== 'image0')) {
    throw bindingError(binding, 'Bernini image slots require a BerniniStudio.image0 binding.')
  }
  if (binding.transform === 'ltx_director_timeline'
    && (graph[binding.nodeId].class_type !== 'LTXDirector'
      || binding.inputPath !== 'timeline_data')) {
    throw bindingError(
      binding,
      'LTX Director timeline requires an LTXDirector.timeline_data binding.',
    )
  }
}

function applyLtxDirectorTimeline(
  graph: ComfyApiWorkflow,
  binding: ComfyInputBinding,
  value: ComfyVariableValue,
  variables: Record<string, ComfyVariableValue | undefined>,
  uploads: RenderWorkflowInput['uploads'],
) {
  const upload = uploads[binding.variable]
  if (!Array.isArray(value) || !Array.isArray(upload)
    || upload.length !== value.length || !upload.every(isUploadedFile) || upload.length === 0) {
    throw bindingError(binding, `LTX Director images for "${binding.variable}" are missing or malformed.`)
  }
  const target = graph[binding.nodeId]
  const parsedSpec = parseLtxDirectorTimelineSpec(variables.prompt)
  const motionFiles = Array.isArray(uploads.directorVideos)
    ? uploads.directorVideos.filter(isUploadedFile)
    : []
  const audioFiles = Array.isArray(uploads.directorAudios)
    ? uploads.directorAudios.filter(isUploadedFile)
    : []
  const retakeFiles = Array.isArray(uploads.directorRetakeVideos)
    ? uploads.directorRetakeVideos.filter(isUploadedFile)
    : []
  if ((parsedSpec?.motionSegments?.length ?? 0) !== motionFiles.length
    || (parsedSpec?.audioSegments?.length ?? 0) !== audioFiles.length
    || (parsedSpec?.retakeVideoMediaId ? 1 : 0) !== retakeFiles.length) {
    throw bindingError(binding, 'LTX Director auxiliary timeline media are missing or malformed.')
  }
  const rendered = renderLtxDirectorTimeline({
    files: upload,
    motionFiles,
    audioFiles,
    retakeFile: retakeFiles[0],
    promptValue: variables.prompt,
    baseTimelineData: target.inputs.timeline_data,
    fallbackDurationSeconds: typeof variables.duration === 'number'
      ? variables.duration
      : typeof variables.duration_seconds === 'number'
        ? variables.duration_seconds
        : typeof target.inputs.duration_seconds === 'number'
          ? target.inputs.duration_seconds
          : undefined,
    fallbackFps: typeof variables.fps === 'number'
      ? variables.fps
      : typeof target.inputs.frame_rate === 'number'
        ? target.inputs.frame_rate
        : undefined,
  })
  target.inputs.timeline_data = rendered.timelineData
  target.inputs.local_prompts = rendered.localPrompts
  target.inputs.segment_lengths = rendered.segmentLengths
  target.inputs.guide_strength = rendered.guideStrength
  target.inputs.global_prompt = parseLtxDirectorTimelineSpec(variables.prompt)?.globalPrompt
    ?? (typeof variables.prompt === 'string' ? variables.prompt : target.inputs.global_prompt)
  target.inputs.start_second = rendered.startSecond
  target.inputs.end_second = rendered.endSecond
  target.inputs.duration_seconds = rendered.durationSeconds
  target.inputs.start_frame = rendered.startFrame
  target.inputs.end_frame = rendered.endFrame
  target.inputs.duration_frames = rendered.durationFrames
  target.inputs.frame_rate = rendered.durationFrames / rendered.durationSeconds
  if (Object.hasOwn(target.inputs, 'custom_width')) target.inputs.custom_width = rendered.width
  if (Object.hasOwn(target.inputs, 'custom_height')) target.inputs.custom_height = rendered.height
  if (Object.hasOwn(target.inputs, 'resize_method')) target.inputs.resize_method = rendered.resizeMethod
  if (Object.hasOwn(target.inputs, 'display_mode')) target.inputs.display_mode = rendered.displayMode
  if (Object.hasOwn(target.inputs, 'divisible_by')) target.inputs.divisible_by = rendered.divisibleBy
  if (Object.hasOwn(target.inputs, 'img_compression')) target.inputs.img_compression = rendered.imageCompression
  if (Object.hasOwn(target.inputs, 'epsilon') && rendered.epsilon !== undefined) target.inputs.epsilon = rendered.epsilon
  if (Object.hasOwn(target.inputs, 'use_custom_audio')) target.inputs.use_custom_audio = rendered.useCustomAudio
  if (Object.hasOwn(target.inputs, 'inpaint_audio')) target.inputs.inpaint_audio = rendered.inpaintAudio
  if (Object.hasOwn(target.inputs, 'use_custom_motion')) target.inputs.use_custom_motion = rendered.useCustomMotion
  if (Object.hasOwn(target.inputs, 'override_audio')) target.inputs.override_audio = rendered.overrideAudio
}

function applyBerniniImageSlots(
  graph: ComfyApiWorkflow,
  binding: ComfyInputBinding,
  value: ComfyVariableValue,
  uploads: RenderWorkflowInput['uploads'],
) {
  const upload = uploads[binding.variable]
  if (!Array.isArray(value)) {
    throw bindingError(binding, `Upload list for "${binding.variable}" is malformed.`)
  }
  if (value.length > 0 && (!Array.isArray(upload)
    || upload.length !== value.length || !upload.every(isUploadedFile))) {
    throw bindingError(
      binding,
      `Upload list for "${binding.variable}" is missing, partial, or malformed.`,
    )
  }
  const files = value.length === 0 ? [] : upload as ComfyUploadedFile[]
  const target = graph[binding.nodeId]
  for (const inputName of Object.keys(target.inputs)) {
    if (/^image[0-7]$/.test(inputName)) delete target.inputs[inputName]
  }
  files.forEach((file, index) => {
    const loaderId = allocateBerniniLoaderId(graph, binding.nodeId, index)
    graph[loaderId] = {
      class_type: 'LoadImage',
      inputs: { image: comfyUploadedImagePath(file) },
      _meta: { title: `Waoowaoo Bernini Reference ${index}` },
    }
    target.inputs[`image${index}`] = [loaderId, 0]
  })
}

function allocateBerniniLoaderId(
  graph: ComfyApiWorkflow,
  targetNodeId: string,
  index: number,
) {
  const safeTarget = targetNodeId.replace(/[^A-Za-z0-9_-]+/g, '_') || 'node'
  const base = `waoowaoo_bernini_${safeTarget}_${index}`
  let candidate = base
  let suffix = 1
  while (Object.hasOwn(graph, candidate)) candidate = `${base}_${suffix++}`
  return candidate
}

function comfyUploadedImagePath(file: ComfyUploadedFile) {
  const subfolder = file.subfolder.replace(/^\/+|\/+$/g, '')
  if (!subfolder || file.name.startsWith(`${subfolder}/`)) return file.name
  return `${subfolder}/${file.name}`
}

function transformBindingValue(
  binding: ComfyInputBinding,
  value: ComfyVariableValue,
  variables: Record<string, ComfyVariableValue | undefined>,
  uploads: RenderWorkflowInput['uploads'],
  onNumericConversion: RenderWorkflowInput['onNumericConversion'],
): unknown {
  if (binding.numericTransform) {
    const { encodedValue, ...diagnostic } = convertComfyNumericBinding({
      variable: binding.variable,
      value,
      variables,
      transform: binding.numericTransform,
    })
    onNumericConversion?.(diagnostic)
    return encodedValue
  }
  if (!binding.transform) return cloneValue(value)

  const upload = uploads[binding.variable]
  if (binding.transform === 'filename_at') {
    const valueIndex = binding.valueIndex
    if (!Number.isInteger(valueIndex) || (valueIndex as number) < 0) {
      throw bindingError(binding, `Indexed upload binding for "${binding.variable}" is invalid.`)
    }
    if (!Array.isArray(value) || !Array.isArray(upload)) {
      throw bindingError(binding, `Upload list for "${binding.variable}" is missing or malformed.`)
    }
    const indexedValue = value[valueIndex as number]
    const indexedUpload = upload[valueIndex as number]
    if (indexedValue === undefined && indexedUpload === undefined
      && binding.missingValuePolicy === 'preserve_original') {
      return SKIP_BINDING
    }
    if (indexedValue === undefined || !isUploadedFile(indexedUpload)) {
      throw bindingError(
        binding,
        `Upload at index ${String(valueIndex)} for "${binding.variable}" is missing or malformed.`,
      )
    }
    return comfyUploadedImagePath(indexedUpload)
  }
  if (binding.transform === 'filename_list') {
    if (
      !Array.isArray(value)
      || !Array.isArray(upload)
      || upload.length !== value.length
      || !upload.every(isUploadedFile)
    ) {
      throw bindingError(
        binding,
        `Upload list for "${binding.variable}" is missing, partial, or malformed.`,
      )
    }
    return upload.map((file) => comfyUploadedImagePath(file))
  }
  if (!isUploadedFile(upload)) {
    throw bindingError(binding, `Upload for "${binding.variable}" is missing.`)
  }
  if (binding.transform === 'filename') return comfyUploadedImagePath(upload)
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
      if (definition.type === 'image_ref_list' && definition.maxItems !== undefined
        && Array.isArray(value) && value.length > definition.maxItems) {
        throw new ComfyError(
          COMFY_ERROR_CODE.WORKFLOW_BINDING_INVALID,
          `Workflow variable "${definition.name}" exceeds its configured maximum.`,
          { details: { variable: definition.name, reason: 'max_items' } },
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
