import { describe, expect, it } from 'vitest'

import { renderLtxDirectorTimeline } from '@/lib/comfyui/ltx-director'
import { augmentLtxDirectorContract } from '@/lib/comfyui/ltx-director-contract'
import { analyzeComfyApiWorkflow } from '@/lib/comfyui/workflow-auto-mapper'
import { renderComfyWorkflow } from '@/lib/comfyui/workflow-renderer'
import { confirmWorkflowAnalysis } from '@/app/[locale]/profile/components/comfyui/workflow-ui'

const directorGraph = {
  '10': {
    class_type: 'LTXDirector',
    inputs: {
      global_prompt: '',
      start_second: 0,
      end_second: 5,
      duration_seconds: 5,
      start_frame: 0,
      end_frame: 120,
      duration_frames: 120,
      timeline_data: '',
      local_prompts: '',
      segment_lengths: '',
      guide_strength: '',
      frame_rate: 24,
    },
    _meta: { title: 'LTX Director' },
  },
  '20': {
    class_type: 'VHS_VideoCombine',
    inputs: { filename_prefix: 'director', images: ['10', 2] },
  },
}

describe('LTX Director adapter', () => {
  it('upgrades an already-published workflow contract at runtime', () => {
    const contract = augmentLtxDirectorContract({
      graph: directorGraph,
      variableDefinitions: [{ name: 'prompt', type: 'string', required: true }],
      bindings: [],
    })
    expect(contract.variableDefinitions).toContainEqual({
      name: 'referenceImages', type: 'image_ref_list', required: true, maxItems: 8,
    })
    expect(contract.bindings).toContainEqual({
      nodeId: '10', inputPath: 'timeline_data', variable: 'referenceImages',
      valueType: 'image_ref_list', transform: 'ltx_director_timeline',
    })
  })

  it('discovers a required timeline image binding during workflow import', () => {
    const graphWithoutOptionalPrompt = structuredClone(directorGraph)
    delete (graphWithoutOptionalPrompt['10'].inputs as { global_prompt?: string }).global_prompt
    const analysis = analyzeComfyApiWorkflow({
      graph: graphWithoutOptionalPrompt,
      kind: 'video_generation',
    })
    expect(analysis.referenceCapacity).toBe(8)
    expect(analysis.proposals).toContainEqual(expect.objectContaining({
      nodeId: '10',
      inputPath: 'global_prompt',
      canonicalName: 'prompt',
      required: true,
    }))
    expect(analysis.proposals).toContainEqual(expect.objectContaining({
      nodeId: '10',
      inputPath: 'timeline_data',
      canonicalName: 'referenceImages',
      transform: 'ltx_director_timeline',
      required: true,
    }))
    const confirmed = confirmWorkflowAnalysis(analysis, {
      roles: {},
      primaryOutputNodeId: '20',
      requiredInputs: ['prompt'],
    })
    expect(confirmed.variableDefinitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'prompt', required: true }),
      expect.objectContaining({ name: 'referenceImages', required: true, maxItems: 8 }),
    ]))
  })

  it('converts shot prompts and durations into remote ComfyUI timeline filenames', () => {
    const spec = JSON.stringify({
      version: 1,
      fps: 24,
      globalPrompt: 'same characters and location',
      segments: [
        { prompt: 'walks into frame', durationSeconds: 2 },
        { panelId: 'panel-2', prompt: 'turns and answers', durationSeconds: 3, guideStrength: 1.25 },
      ],
    })
    const rendered = renderLtxDirectorTimeline({
      promptValue: spec,
      files: [
        { name: 'first.png', subfolder: 'waoowaoo/1', type: 'input' },
        { name: 'last.png', subfolder: 'waoowaoo/1', type: 'input' },
      ],
    })
    expect(rendered.durationFrames).toBe(120)
    expect(rendered.localPrompts).toBe('walks into frame|turns and answers')
    expect(rendered.guideStrength).toBe('1,1.25')
    expect(JSON.parse(rendered.timelineData).segments).toEqual([
      expect.objectContaining({ start: 0, length: 48, imageFile: 'waoowaoo/1/first.png' }),
      expect.objectContaining({ start: 48, length: 72, imageFile: 'waoowaoo/1/last.png' }),
    ])
  })

  it('fills all LTX Director timeline inputs while rendering a published workflow', () => {
    const prompt = JSON.stringify({
      version: 1,
      fps: 24,
      globalPrompt: 'consistent cast',
      segments: [
        { prompt: 'shot one', durationSeconds: 1.5 },
        { prompt: 'shot two', durationSeconds: 2.5 },
      ],
    })
    const graph = renderComfyWorkflow({
      graph: directorGraph,
      variables: {
        prompt,
        referenceImages: [
          { storageKey: 'images/one.png' },
          { storageKey: 'images/two.png' },
        ],
      },
      variableDefinitions: [
        { name: 'prompt', type: 'string', required: true },
        { name: 'referenceImages', type: 'image_ref_list', required: true, maxItems: 8 },
      ],
      bindings: [{
        nodeId: '10', inputPath: 'timeline_data', variable: 'referenceImages',
        valueType: 'image_ref_list', transform: 'ltx_director_timeline',
      }],
      uploads: {
        referenceImages: [
          { name: 'one.png', subfolder: 'wdc', type: 'input' },
          { name: 'two.png', subfolder: 'wdc', type: 'input' },
        ],
      },
    })
    expect(graph['10'].inputs).toMatchObject({
      global_prompt: 'consistent cast',
      duration_seconds: 4,
      duration_frames: 96,
      end_frame: 96,
      local_prompts: 'shot one|shot two',
      segment_lengths: '36,60',
      frame_rate: 24,
    })
  })
})
