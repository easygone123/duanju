import { describe, expect, it } from 'vitest'

import {
  addGuidedInput,
  addGuidedOutput,
  createGuidedMappingDraft,
  effectiveGuidedAnalysis,
  guidedInputCandidates,
  guidedMappingDraftIssues,
  removeGuidedInput,
  removeGuidedOutput,
  setGuidedPrimaryOutput,
  updateGuidedInputRole,
  updateGuidedOutput,
} from '@/app/[locale]/profile/components/comfyui/guided-workflow-mapping-draft'
import type { WorkflowAutoMappingResult } from '@/lib/comfyui/workflow-auto-mapping-types'

function analysis(overrides: Partial<WorkflowAutoMappingResult> = {}): WorkflowAutoMappingResult {
  return {
    graph: {
      text: {
        class_type: 'PrimitiveString',
        inputs: { value: 'describe the shot' },
        _meta: { title: 'Text value' },
      },
      image: {
        class_type: 'LoadImage',
        inputs: { image: 'frame.png' },
        _meta: { title: 'Reference frame' },
      },
      video: {
        class_type: 'LoadVideo',
        inputs: { video: 'clip.mp4' },
        _meta: { title: 'Source video' },
      },
      size: {
        class_type: 'EmptyLatentImage',
        inputs: { width: 832, height: 480 },
      },
      output: {
        class_type: 'VHS_VideoCombine',
        inputs: { images: ['image', 0] },
        _meta: { title: 'Video output' },
      },
      custom: {
        class_type: 'CustomRemoteVideoSaver',
        inputs: { source: ['output', 0] },
        _meta: { title: 'Custom output' },
      },
    },
    mediaType: 'video',
    purpose: 'generation',
    proposals: [{
      id: 'automatic-prompt',
      canonicalName: 'prompt',
      nodeId: 'text',
      inputPath: 'value',
      valueType: 'string',
      confidence: 'high',
      reasonCode: 'COMFY_MAPPING_PROMPT_POSITIVE_LABEL',
      required: true,
      nodeTitle: 'Text value',
    }],
    outputs: [{
      name: 'output_output',
      nodeId: 'output',
      fieldPath: 'gifs',
      mediaType: 'video',
      primary: true,
    }],
    issues: [],
    referenceCapacity: 0,
    ...overrides,
  }
}

describe('guided ComfyUI mapping draft', () => {
  it('offers compatible scalar, image, and video inputs from the uploaded graph', () => {
    const draft = createGuidedMappingDraft(analysis())
    const withoutPrompt = removeGuidedInput(draft, 'automatic-prompt')
    const candidates = guidedInputCandidates(withoutPrompt.analysis, withoutPrompt.inputs)

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'text', inputPath: 'value', roles: expect.arrayContaining(['prompt', 'negativePrompt']),
      }),
      expect.objectContaining({
        nodeId: 'image', inputPath: 'image',
        roles: expect.arrayContaining(['sourceImage', 'referenceImages', 'firstFrame', 'lastFrame']),
      }),
      expect.objectContaining({ nodeId: 'video', inputPath: 'video', roles: ['sourceVideo'] }),
      expect.objectContaining({ nodeId: 'size', inputPath: 'width', roles: ['width'] }),
      expect.objectContaining({ nodeId: 'size', inputPath: 'height', roles: ['height'] }),
    ]))
  })

  it('removes an automatic input and adds a graph-verified replacement', () => {
    const initial = createGuidedMappingDraft(analysis())
    const removed = removeGuidedInput(initial, 'automatic-prompt')
    const candidate = guidedInputCandidates(removed.analysis, removed.inputs)
      .find((item) => item.nodeId === 'text' && item.inputPath === 'value')

    expect(candidate).toBeTruthy()
    const repaired = addGuidedInput(removed, candidate!.id, 'negativePrompt')
    const effective = effectiveGuidedAnalysis(repaired)

    expect(effective.proposals).toEqual([
      expect.objectContaining({
        nodeId: 'text', inputPath: 'value', canonicalName: 'negativePrompt', confidence: 'high',
      }),
    ])
  })

  it('changes an ambiguous input role into an explicit confirmed role', () => {
    const draft = createGuidedMappingDraft(analysis({
      proposals: [{
        ...analysis().proposals[0]!,
        confidence: 'ambiguous',
        canonicalName: 'prompt',
      }],
    }))

    const updated = updateGuidedInputRole(draft, 'automatic-prompt', 'negativePrompt')

    expect(updated.inputs[0]).toMatchObject({
      canonicalName: 'negativePrompt', confidence: 'high', required: true,
    })
  })

  it('rejects a forged or type-incompatible input candidate', () => {
    const draft = createGuidedMappingDraft(analysis())

    expect(() => addGuidedInput(draft, 'missing-node.missing-field', 'sourceVideo'))
      .toThrow('workflowGuidedMappingInvalid')
    const imageCandidate = guidedInputCandidates(draft.analysis, draft.inputs)
      .find((item) => item.nodeId === 'image')
    expect(imageCandidate).toBeTruthy()
    expect(() => addGuidedInput(draft, imageCandidate!.id, 'sourceVideo'))
      .toThrow('workflowGuidedMappingInvalid')
  })

  it('adds and edits graph-bound outputs while validating the history field', () => {
    const initial = createGuidedMappingDraft(analysis({ outputs: [], issues: [{
      code: 'COMFY_WORKFLOW_OUTPUT_REQUIRED', message: 'missing output',
    }] }))
    const added = addGuidedOutput(initial, 'custom')

    expect(added.outputs).toEqual([expect.objectContaining({
      nodeId: 'custom', fieldPath: '', mediaType: 'video', primary: true,
    })])
    expect(guidedMappingDraftIssues(added)).toContain('unsafeField')

    const updated = updateGuidedOutput(added, 0, { fieldPath: 'videos', name: 'custom_video' })
    expect(guidedMappingDraftIssues(updated)).toEqual([])
    expect(effectiveGuidedAnalysis(updated)).toMatchObject({
      outputs: [{ nodeId: 'custom', fieldPath: 'videos', name: 'custom_video', primary: true }],
      issues: [],
    })
  })

  it('allows zero outputs for repair but blocks readiness until one primary output is valid', () => {
    const draft = createGuidedMappingDraft(analysis())
    const empty = removeGuidedOutput(draft, 0)

    expect(empty.outputs).toEqual([])
    expect(guidedMappingDraftIssues(empty)).toContain('outputRequired')

    const first = updateGuidedOutput(addGuidedOutput(empty, 'output'), 0, { fieldPath: 'gifs' })
    const second = updateGuidedOutput(addGuidedOutput(first, 'custom'), 1, { fieldPath: 'videos' })
    const selected = setGuidedPrimaryOutput(second, 1)

    expect(selected.outputs.map((output) => output.primary)).toEqual([false, true])
    expect(guidedMappingDraftIssues(selected)).toEqual([])
  })

  it('rejects missing output nodes, unsafe paths, and duplicate output targets', () => {
    const draft = createGuidedMappingDraft(analysis())

    expect(() => addGuidedOutput(draft, 'missing-node')).toThrow('workflowGuidedMappingInvalid')
    expect(guidedMappingDraftIssues(updateGuidedOutput(draft, 0, { fieldPath: '__proto__.files' })))
      .toContain('unsafeField')

    const duplicate = updateGuidedOutput(addGuidedOutput(draft, 'custom'), 1, {
      nodeId: 'output', fieldPath: 'gifs', name: 'other',
    })
    expect(guidedMappingDraftIssues(duplicate)).toContain('duplicateTarget')
  })
})
