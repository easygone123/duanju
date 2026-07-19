import { describe, expect, it } from 'vitest'

import {
  buildEditedWorkflowDraft,
  createGuidedMappingDraftFromAuthorDraft,
  workflowImportKindForDraft,
} from '@/app/[locale]/profile/components/comfyui/guided-workflow-edit'
import {
  guidedMappingDraftIssues,
  updateGuidedInputRole,
} from '@/app/[locale]/profile/components/comfyui/guided-workflow-mapping-draft'
import type { WorkflowAuthorDraft } from '@/app/[locale]/profile/components/comfyui/workflow-ui'

function firstLastFrameDraft(): WorkflowAuthorDraft {
  return {
    name: 'LTX first and last frame',
    mediaType: 'video',
    purpose: 'generation',
    apiFormatJson: JSON.stringify({
      '269': {
        class_type: 'LoadImage',
        inputs: { image: 'first.png' },
        _meta: { title: 'First frame' },
      },
      '327': {
        class_type: 'Float',
        inputs: { Number: '2' },
        _meta: { title: 'Duration' },
      },
      '369': {
        class_type: 'VHS_VideoCombine',
        inputs: { images: ['269', 0] },
        _meta: { title: 'Video output' },
      },
      '370': {
        class_type: 'LoadImage',
        inputs: { image: 'last.png' },
        _meta: { title: 'Last frame' },
      },
    }, null, 2),
    variableDefinitions: [
      { name: 'firstFrame', type: 'image_ref', required: false, missingValuePolicy: 'preserve_original' },
      { name: 'lastFrame', type: 'image_ref', required: false, missingValuePolicy: 'preserve_original' },
      { name: 'duration', type: 'number', required: false, defaultValue: 2, options: [2, 4] },
    ],
    bindings: [
      {
        nodeId: '269', inputPath: 'image', variable: 'firstFrame', valueType: 'image_ref',
        transform: 'filename', missingValuePolicy: 'preserve_original',
      },
      {
        nodeId: '370', inputPath: 'image', variable: 'lastFrame', valueType: 'image_ref',
        transform: 'filename', missingValuePolicy: 'preserve_original',
      },
      {
        nodeId: '327', inputPath: 'Number', variable: 'duration', valueType: 'number',
        numericTransform: { sourceUnit: 'seconds', targetUnit: 'seconds', output: 'numeric_string' },
        missingValuePolicy: 'preserve_original',
      },
    ],
    outputs: [{
      name: 'video', nodeId: '369', fieldPath: 'gifs', mediaType: 'video', primary: true,
    }],
  }
}

describe('guided ComfyUI workflow editing', () => {
  it('reconstructs and prepares both frame mappings from the current author draft', () => {
    const original = firstLastFrameDraft()
    const mappingDraft = createGuidedMappingDraftFromAuthorDraft(original)

    expect(workflowImportKindForDraft(original)).toBe('video_generation')
    expect(mappingDraft.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonicalName: 'firstFrame', nodeId: '269', inputPath: 'image' }),
      expect.objectContaining({ canonicalName: 'lastFrame', nodeId: '370', inputPath: 'image' }),
    ]))

    const prepared = buildEditedWorkflowDraft(original, 'Updated LTX', mappingDraft)

    expect(prepared.name).toBe('Updated LTX')
    expect(prepared.variableDefinitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'firstFrame', type: 'image_ref' }),
      expect.objectContaining({ name: 'lastFrame', type: 'image_ref' }),
      expect.objectContaining({ name: 'duration', defaultValue: 2, options: [2, 4] }),
    ]))
    expect(prepared.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ variable: 'firstFrame', nodeId: '269' }),
      expect.objectContaining({ variable: 'lastFrame', nodeId: '370' }),
    ]))
  })

  it('surfaces the only unbound image loader as an explicitly confirmed missing first frame', () => {
    const original = firstLastFrameDraft()
    original.variableDefinitions = original.variableDefinitions.filter((item) => item.name !== 'firstFrame')
    original.bindings = original.bindings.filter((item) => item.variable !== 'firstFrame')

    const recovered = createGuidedMappingDraftFromAuthorDraft(original)
    const firstFrame = recovered.inputs.find((proposal) => proposal.nodeId === '269')
    expect(firstFrame).toMatchObject({
      canonicalName: 'firstFrame', confidence: 'ambiguous',
    })
    expect(guidedMappingDraftIssues(recovered)).toContain('unconfirmedInput')

    const confirmed = updateGuidedInputRole(recovered, firstFrame!.id, 'firstFrame')
    const prepared = buildEditedWorkflowDraft(original, original.name, confirmed)
    expect(prepared.variableDefinitions).toContainEqual(expect.objectContaining({ name: 'firstFrame' }))
    expect(prepared.bindings).toContainEqual(expect.objectContaining({
      variable: 'firstFrame', nodeId: '269', inputPath: 'image',
    }))
  })
})
