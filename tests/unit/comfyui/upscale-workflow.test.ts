import { describe, expect, it } from 'vitest'

import type { WorkflowContractInput } from '@/lib/comfyui/types'
import { validateWorkflowContract } from '@/lib/comfyui/workflow-schema'
import { renderComfyWorkflow } from '@/lib/comfyui/workflow-renderer'

function upscaleContract(overrides: Partial<WorkflowContractInput> = {}): WorkflowContractInput {
  return {
    purpose: 'upscale',
    graph: {
      load: { class_type: 'LoadImage', inputs: { image: 'input.png' } },
      upscale: { class_type: 'UpscaleModelLoader', inputs: { image: ['load', 0] } },
      save: { class_type: 'SaveImage', inputs: { images: ['upscale', 0] } },
    },
    variableDefinitions: [
      { name: 'source_image', type: 'image_ref', required: true },
    ],
    bindings: [{
      nodeId: 'load', inputPath: 'image', variable: 'source_image',
      valueType: 'image_ref', transform: 'filename',
    }],
    outputs: [{
      name: 'result', nodeId: 'save', fieldPath: 'images', mediaType: 'image', primary: true,
    }],
    ...overrides,
  }
}

describe('ComfyUI upscale workflow contract', () => {
  it('accepts exactly one bound required image input and one image output', () => {
    expect(validateWorkflowContract(upscaleContract())).toEqual([])
  })

  it('binds the single uploaded source image into the compiled ComfyUI graph', () => {
    const contract = upscaleContract()
    const rendered = renderComfyWorkflow({
      graph: contract.graph as Record<string, { class_type: string; inputs: Record<string, unknown> }>,
      variables: { source_image: { storageKey: 'owned/source.png' } },
      variableDefinitions: contract.variableDefinitions,
      bindings: contract.bindings,
      uploads: {
        source_image: { name: 'source.png', subfolder: 'waoowaoo', type: 'input' },
      },
    })

    expect(rendered.load.inputs.image).toBe('source.png')
  })

  it('fails closed with a stable issue when the image input is missing', () => {
    const issues = validateWorkflowContract(upscaleContract({
      variableDefinitions: [{ name: 'prompt', type: 'string', required: true }],
      bindings: [{
        nodeId: 'load', inputPath: 'image', variable: 'prompt', valueType: 'string',
      }],
    }))

    expect(issues).toContainEqual(expect.objectContaining({
      code: 'COMFY_UPSCALE_INPUT_REQUIRED', path: 'bindings',
    }))
  })

  it('fails closed with a stable issue when the image output is missing', () => {
    const issues = validateWorkflowContract(upscaleContract({ outputs: [] }))

    expect(issues).toContainEqual(expect.objectContaining({
      code: 'COMFY_UPSCALE_OUTPUT_REQUIRED', path: 'outputs',
    }))
  })

  it.each([
    ['a missing media transform', undefined],
    ['an incompatible media transform', 'filename_list'],
  ])('rejects %s instead of writing an owned storage ref into the graph', (_name, transform) => {
    const issues = validateWorkflowContract(upscaleContract({
      bindings: [{
        nodeId: 'load', inputPath: 'image', variable: 'source_image',
        valueType: 'image_ref',
        ...(transform ? { transform: transform as 'filename_list' } : {}),
      }],
    }))

    expect(issues).toContainEqual(expect.objectContaining({
      code: 'COMFY_UPSCALE_BINDINGS_INVALID', path: 'bindings',
    }))
  })

  it.each([
    ['duplicate image inputs', {
      variableDefinitions: [
        { name: 'source_image', type: 'image_ref' as const, required: true },
        { name: 'second_image', type: 'image_ref' as const, required: true },
      ],
      bindings: [
        { nodeId: 'load', inputPath: 'image', variable: 'source_image', valueType: 'image_ref' as const },
        { nodeId: 'upscale', inputPath: 'image', variable: 'second_image', valueType: 'image_ref' as const },
      ],
    }],
    ['wrong image input type', {
      variableDefinitions: [{ name: 'source_images', type: 'image_ref_list' as const, required: true }],
      bindings: [{ nodeId: 'load', inputPath: 'image', variable: 'source_images', valueType: 'image_ref_list' as const }],
    }],
    ['duplicate outputs', {
      outputs: [
        { name: 'result', nodeId: 'save', fieldPath: 'images', mediaType: 'image' as const, primary: true },
        { name: 'preview', nodeId: 'upscale', fieldPath: 'images', mediaType: 'image' as const, primary: false },
      ],
    }],
    ['wrong output media type', {
      outputs: [{ name: 'result', nodeId: 'save', fieldPath: 'images', mediaType: 'video' as const, primary: true }],
    }],
  ])('rejects %s as invalid upscale bindings', (_name, overrides) => {
    const issues = validateWorkflowContract(upscaleContract(overrides))

    expect(issues).toContainEqual(expect.objectContaining({
      code: 'COMFY_UPSCALE_BINDINGS_INVALID',
    }))
  })

  it('keeps generation validation backward compatible when purpose is missing', () => {
    const contract = upscaleContract()
    delete contract.purpose
    contract.variableDefinitions = [{ name: 'prompt', type: 'string', required: true }]
    contract.bindings = [{
      nodeId: 'load', inputPath: 'image', variable: 'prompt', valueType: 'string',
    }]

    expect(validateWorkflowContract(contract)).toEqual([])
  })

  it('does not impose the upscale transform rule on generation image inputs', () => {
    const contract = upscaleContract()
    contract.purpose = 'generation'
    contract.bindings = [{
      nodeId: 'load', inputPath: 'image', variable: 'source_image', valueType: 'image_ref',
    }]

    expect(validateWorkflowContract(contract)).toEqual([])
  })
})
