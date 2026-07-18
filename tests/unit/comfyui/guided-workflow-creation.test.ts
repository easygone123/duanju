import { describe, expect, it } from 'vitest'
import type { WorkflowAutoMappingResult } from '@/lib/comfyui/workflow-auto-mapping-types'
import {
  buildGuidedWorkflowReview,
  createWorkflowAnalysisCoordinator,
  deriveWorkflowName,
  guidedCompatibleRoles,
  isGuidedWorkflowReady,
} from '@/app/[locale]/profile/components/comfyui/guided-workflow-creation'
import { confirmWorkflowAnalysis } from '@/app/[locale]/profile/components/comfyui/workflow-ui'

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

  it('does not count an unresolved ambiguous proposal as a completed required mapping', () => {
    const review = buildGuidedWorkflowReview('image_edit', analysis({ proposals: [
      { id: 'prompt', canonicalName: 'prompt', nodeId: '1', inputPath: 'text', valueType: 'string', confidence: 'high', reasonCode: 'prompt', required: true },
      { id: 'source', canonicalName: 'sourceImage', nodeId: '3', inputPath: 'image', valueType: 'image_ref', confidence: 'ambiguous', reasonCode: 'source', required: true },
    ] }), {}, '')

    expect(review.questions.map((item) => item.id)).toEqual(['source'])
    expect(review.missingRequiredInputs).toEqual(['sourceImage'])
    expect(isGuidedWorkflowReady({ name: 'demo', review, busy: false })).toBe(false)
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

  it('compiles frame conversion into an independently copied workflow contract', () => {
    const numericTransform = {
      sourceUnit: 'seconds' as const,
      targetUnit: 'frames' as const,
      output: 'numeric_string' as const,
      fps: { source: 'runtime_then_fallback' as const, variable: 'fps' as const, fallback: 16 },
      rounding: 'round' as const,
      frameOffset: 1 as const,
      allowedTargetValues: [81, 161],
    }
    const analyzed = analysis({
      graph: {
        video: { class_type: 'VideoLengthNode', inputs: { length: '81' } },
        out: { class_type: 'SaveVideo', inputs: { filename_prefix: 'out' } },
      },
      mediaType: 'video',
      proposals: [{
        id: 'video:length:duration', canonicalName: 'duration', nodeId: 'video',
        inputPath: 'length', valueType: 'number', confidence: 'high',
        reasonCode: 'COMFY_MAPPING_DURATION_INPUT', required: false, numericTransform,
      }],
      outputs: [{
        name: 'video', nodeId: 'out', fieldPath: 'videos', mediaType: 'video', primary: true,
      }],
    })

    const confirmed = confirmWorkflowAnalysis(analyzed, { roles: {} })

    expect(confirmed.variableDefinitions).toEqual([
      expect.objectContaining({ name: 'duration', type: 'number' }),
      { name: 'fps', type: 'number', required: false, defaultValue: 16 },
    ])
    expect(confirmed.bindings).toEqual([expect.objectContaining({
      nodeId: 'video', inputPath: 'length', variable: 'duration',
      numericTransform,
    })])
    expect(confirmed.variableDefinitions.find((item) => item.name === 'duration')?.options)
      .toBeUndefined()

    numericTransform.fps.fallback = 24
    numericTransform.allowedTargetValues.push(241)
    expect(confirmed.bindings[0]?.numericTransform).toMatchObject({
      fps: { fallback: 16 }, allowedTargetValues: [81, 161],
    })
  })
})
