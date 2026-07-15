import { describe, expect, it } from 'vitest'
import type { WorkflowAutoMappingResult } from '@/lib/comfyui/workflow-auto-mapping-types'
import {
  buildGuidedWorkflowReview,
  createWorkflowAnalysisCoordinator,
  deriveWorkflowName,
  guidedCompatibleRoles,
  isGuidedWorkflowReady,
} from '@/app/[locale]/profile/components/comfyui/guided-workflow-creation'

const analysis = (patch: Partial<WorkflowAutoMappingResult> = {}): WorkflowAutoMappingResult => ({
  graph: { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'portrait' } } },
  mediaType: 'image', purpose: 'generation', referenceCapacity: 0, issues: [],
  proposals: [
    { id: 'prompt', canonicalName: 'prompt', nodeId: '1', inputPath: 'text', valueType: 'string', confidence: 'high', reasonCode: 'COMFY_MAPPING_PROMPT_POSITIVE_LABEL', required: true, nodeTitle: 'Positive prompt' },
    { id: 'seed', canonicalName: 'seed', nodeId: '2', inputPath: 'seed', valueType: 'number', confidence: 'preserve_original', reasonCode: 'COMFY_MAPPING_SEED_INPUT', required: false, nodeTitle: 'Sampler' },
  ],
  outputs: [{ name: 'image', nodeId: '9', fieldPath: 'images', mediaType: 'image', primary: true }],
  ...patch,
})

describe('guided ComfyUI workflow creation model', () => {
  it('derives a name from only the final json suffix', () => {
    expect(deriveWorkflowName('portrait.v2.json')).toBe('portrait.v2')
    expect(deriveWorkflowName('  demo.JSON  ')).toBe('demo')
  })

  it('summarizes resolved capabilities and preserved optional values', () => {
    expect(buildGuidedWorkflowReview('image_generation', analysis(), {}, '')).toMatchObject({
      resolvedInputs: ['prompt'], preservedCount: 1, questions: [],
      primaryOutputNodeId: '9', missingRequiredInputs: [], blockingIssueCodes: [],
    })
  })

  it('asks only for required ambiguity', () => {
    const review = buildGuidedWorkflowReview('image_edit', analysis({ proposals: [
      { id: 'required', canonicalName: 'sourceImage', nodeId: '3', inputPath: 'image', valueType: 'image_ref', confidence: 'ambiguous', reasonCode: 'COMFY_MAPPING_IMAGE_ROLE_AMBIGUOUS', required: true },
      { id: 'optional', canonicalName: 'referenceImages', nodeId: '4', inputPath: 'image', valueType: 'image_ref', confidence: 'ambiguous', reasonCode: 'COMFY_MAPPING_IMAGE_ROLE_AMBIGUOUS', required: false },
    ] }), {}, '')
    expect(review.questions.map((item) => item.id)).toEqual(['required'])
    expect(review.preservedCount).toBe(1)
  })

  it('reports a required input missing after its proposal is remapped to the wrong role', () => {
    const review = buildGuidedWorkflowReview('image_edit', analysis({ proposals: [
      { id: 'prompt', canonicalName: 'prompt', nodeId: '1', inputPath: 'text', valueType: 'string', confidence: 'high', reasonCode: 'prompt', required: true },
      { id: 'source', canonicalName: 'sourceImage', nodeId: '3', inputPath: 'image', valueType: 'image_ref', confidence: 'ambiguous', reasonCode: 'source', required: true },
    ] }), { source: 'referenceImages' }, '')
    expect(review.resolvedInputs).toEqual(['prompt', 'referenceImages'])
    expect(review.questions).toEqual([])
    expect(review.missingRequiredInputs).toEqual(['sourceImage'])
    expect(isGuidedWorkflowReady({ name: 'demo', review, busy: false })).toBe(false)
  })

  it('keeps a required preserved proposal unresolved and missing', () => {
    const review = buildGuidedWorkflowReview('image_edit', analysis({ proposals: [
      { id: 'prompt', canonicalName: 'prompt', nodeId: '1', inputPath: 'text', valueType: 'string', confidence: 'high', reasonCode: 'prompt', required: true },
      { id: 'source', canonicalName: 'sourceImage', nodeId: '3', inputPath: 'image', valueType: 'image_ref', confidence: 'ambiguous', reasonCode: 'source', required: true },
    ] }), { source: 'preserve_original' }, '')
    expect(review.questions.map((item) => item.id)).toEqual(['source'])
    expect(review.missingRequiredInputs).toEqual(['sourceImage'])
    expect(isGuidedWorkflowReady({ name: 'demo', review, busy: false })).toBe(false)
  })

  it('recognizes high-confidence optional mappings while preserving their workflow defaults', () => {
    const review = buildGuidedWorkflowReview('image_generation', analysis({ proposals: [
      { id: 'prompt', canonicalName: 'prompt', nodeId: '1', inputPath: 'text', valueType: 'string', confidence: 'high', reasonCode: 'prompt', required: true },
      { id: 'width', canonicalName: 'width', nodeId: '2', inputPath: 'width', valueType: 'number', confidence: 'high', reasonCode: 'width', required: false },
    ] }), {}, '')
    expect(review.resolvedInputs).toEqual(['prompt', 'width'])
    expect(review.preservedCount).toBe(1)
  })

  it('requires one output choice when several outputs have no primary', () => {
    const review = buildGuidedWorkflowReview('image_generation', analysis({ outputs: [
      { name: 'preview', nodeId: '8', fieldPath: 'images', mediaType: 'image', primary: false },
      { name: 'save', nodeId: '9', fieldPath: 'images', mediaType: 'image', primary: false },
    ] }), {}, '')
    expect(review.needsPrimaryOutput).toBe(true)
    expect(isGuidedWorkflowReady({ name: 'demo', review, busy: false })).toBe(false)
  })

  it('rejects a stale primary output selection', () => {
    const review = buildGuidedWorkflowReview('image_generation', analysis({
      outputs: [
        { name: 'preview', nodeId: '8', fieldPath: 'images', mediaType: 'image', primary: false },
        { name: 'save', nodeId: '9', fieldPath: 'images', mediaType: 'image', primary: false },
      ],
      issues: [{ code: 'COMFY_WORKFLOW_OUTPUT_AMBIGUOUS', message: 'Select one output.', path: 'outputs' }],
    }), {}, 'stale-node')
    expect(review.primaryOutputNodeId).toBe('')
    expect(review.needsPrimaryOutput).toBe(true)
    expect(review.blockingIssueCodes).not.toContain('COMFY_WORKFLOW_OUTPUT_AMBIGUOUS')
    expect(isGuidedWorkflowReady({ name: 'demo', review, busy: false })).toBe(false)
  })

  it('clears output ambiguity after a valid primary output is selected', () => {
    const review = buildGuidedWorkflowReview('image_generation', analysis({
      outputs: [
        { name: 'preview', nodeId: '8', fieldPath: 'images', mediaType: 'image', primary: false },
        { name: 'save', nodeId: '9', fieldPath: 'images', mediaType: 'image', primary: false },
      ],
      issues: [{ code: 'COMFY_WORKFLOW_OUTPUT_AMBIGUOUS', message: 'Select one output.', path: 'outputs' }],
    }), {}, '9')
    expect(review.primaryOutputNodeId).toBe('9')
    expect(review.needsPrimaryOutput).toBe(false)
    expect(review.blockingIssueCodes).not.toContain('COMFY_WORKFLOW_OUTPUT_AMBIGUOUS')
    expect(isGuidedWorkflowReady({ name: 'demo', review, busy: false })).toBe(true)
  })

  it('offers only value-type-compatible roles', () => {
    expect(guidedCompatibleRoles({
      id: 'image', canonicalName: 'sourceImage', nodeId: '3', inputPath: 'image', valueType: 'image_ref', confidence: 'ambiguous', reasonCode: 'x', required: true,
    })).toEqual(['sourceImage', 'referenceImages', 'firstFrame', 'lastFrame'])
  })

  it('blocks creation when the selected type has no required source input', () => {
    const review = buildGuidedWorkflowReview('image_edit', analysis(), {}, '')
    expect(review.missingRequiredInputs).toEqual(['sourceImage'])
    expect(isGuidedWorkflowReady({ name: 'demo', review, busy: false })).toBe(false)
  })

  it('lets only the latest async analysis commit', () => {
    const controller = createWorkflowAnalysisCoordinator()
    const first = controller.begin()
    const second = controller.begin()
    expect(controller.isCurrent(first)).toBe(false)
    expect(controller.isCurrent(second)).toBe(true)
    controller.dispose()
    expect(controller.isCurrent(second)).toBe(false)
    expect(controller.isCurrent(controller.begin())).toBe(false)
  })
})
