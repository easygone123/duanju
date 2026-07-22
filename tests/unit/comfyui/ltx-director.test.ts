import { describe, expect, it } from 'vitest'

import {
  normalizeLtxDirectorGlobalPrompt,
  parseLtxDirectorTimelineSpec,
  renderLtxDirectorTimeline,
  resolveLtxDirectorDimensions,
} from '@/lib/comfyui/ltx-director'
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
      custom_width: 768,
      custom_height: 512,
      resize_method: 'maintain aspect ratio',
    },
    _meta: { title: 'LTX Director' },
  },
  '20': {
    class_type: 'VHS_VideoCombine',
    inputs: { filename_prefix: 'director', images: ['10', 2] },
  },
}

describe('LTX Director adapter', () => {
  it('preserves freely arranged panel and uploaded-media sources', () => {
    const parsed = parseLtxDirectorTimelineSpec({
      version: 1,
      fps: 24,
      globalPrompt: 'continuous scene',
      segments: [
        {
          id: 'opening',
          sourcePanelId: 'panel-before',
          prompt: 'continue from the previous shot',
          durationSeconds: 2,
        },
        {
          id: 'insert',
          sourceMediaId: 'media-upload',
          sourceImageUrl: '/m/uploaded',
          prompt: 'insert shot',
          durationSeconds: 1.5,
        },
      ],
    })
    expect(parsed?.segments).toEqual([
      expect.objectContaining({ id: 'opening', sourcePanelId: 'panel-before' }),
      expect.objectContaining({ id: 'insert', sourceMediaId: 'media-upload', sourceImageUrl: '/m/uploaded' }),
    ])
  })

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
    expect(rendered).toMatchObject({
      startFrame: 0,
      endFrame: 120,
      fullDurationFrames: 120,
      width: 1280,
      height: 720,
    })
  })

  it('renders a selected range while preserving free timeline gaps and adaptive portrait resolution', () => {
    const rendered = renderLtxDirectorTimeline({
      promptValue: JSON.stringify({
        version: 1,
        fps: 24,
        globalPrompt: 'portrait continuity',
        aspectRatio: '9:16',
        resolutionPreset: '1080p',
        rangeStartSeconds: 1,
        rangeEndSeconds: 5,
        segments: [
          { prompt: 'opening', startSeconds: 0, durationSeconds: 2 },
          { prompt: 'arrival', startSeconds: 4, durationSeconds: 3 },
        ],
      }),
      files: [
        { name: 'opening.png', subfolder: 'wdc', type: 'input' },
        { name: 'arrival.png', subfolder: 'wdc', type: 'input' },
      ],
    })
    expect(rendered).toMatchObject({
      startSecond: 1,
      endSecond: 5,
      durationSeconds: 4,
      startFrame: 24,
      endFrame: 120,
      durationFrames: 96,
      fullDurationFrames: 168,
      width: 1080,
      height: 1920,
    })
    expect(rendered.segmentLengths).toBe('72,24')
    expect(JSON.parse(rendered.timelineData).segments).toEqual([
      expect.objectContaining({ start: 0, length: 48 }),
      expect.objectContaining({ start: 96, length: 72 }),
    ])
  })

  it('converts continuity metadata into readable global prompting', () => {
    expect(normalizeLtxDirectorGlobalPrompt(
      '{"groupId":"internal","sceneKey":"palace","incomingContinuity":"enters in rain"}\ncomic scene',
    )).toBe('palace\nenters in rain\ncomic scene')
    expect(resolveLtxDirectorDimensions('480p', '9:16')).toEqual({ width: 480, height: 854 })
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
      custom_width: 1280,
      custom_height: 720,
      local_prompts: 'shot one|shot two',
      segment_lengths: '36,60',
      frame_rate: 24,
    })
  })
})
