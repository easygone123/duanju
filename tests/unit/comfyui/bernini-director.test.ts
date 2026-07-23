import { describe, expect, it } from 'vitest'

import {
  collectBerniniDirectorMediaOrders,
  parseBerniniDirectorSpec,
  renderBerniniDirectorNode,
} from '@/lib/comfyui/bernini-director'
import {
  augmentBerniniDirectorContract,
  hasBerniniDirectorNode,
} from '@/lib/comfyui/bernini-director-contract'
import { buildComfyWorkflowModelOption } from '@/lib/comfyui/workflow-model-option'
import { analyzeComfyApiWorkflow } from '@/lib/comfyui/workflow-auto-mapper'
import { mergeDirectorConfig } from '@/lib/comfyui/director-config-envelope'

const rawSpec = {
  kind: 'bernini-director',
  version: 4,
  taskType: 'rv2v',
  timelineMode: 'video',
  editMode: 'segment',
  globalPrompt: 'replace the person with image0',
  negativePrompt: 'bad video',
  sourceVideoMediaId: 'video-source',
  globalReferenceMediaIds: ['ref-0'],
  globalReferenceVideoMediaId: 'video-reference',
  continuousReference: true,
  frameRate: 24,
  width: 1280,
  height: 720,
  refMaxSize: 1280,
  outputMode: 'fixed',
  maxExportFrames: 0,
  exportMode: 'all',
  continuityEnabled: true,
  continuityOverlapFrames: 9,
  runSelectEnabled: true,
  runSelection: [1],
  steps: 6,
  splitStep: 3,
  sampler: 'euler',
  scheduler: 'simple',
  highNoiseCfg: 1,
  highNoiseSeed: 11,
  lowNoiseCfg: 1,
  lowNoiseSeed: 22,
  clearVramBetweenSegments: true,
  exportSourceImages: false,
  llmAutoEnhance: true,
  llmApiFormat: 'Ollama',
  llmOpenaiCompatMode: '标准',
  llmUrl: 'http://127.0.0.1:11434/v1',
  llmApiKey: '',
  llmModel: 'qwen3.5',
  llmOutputLanguage: '中文',
  llmCharacterFeatureEnhance: true,
  llmUnloadAfter: false,
  llmCustomTemplate: '',
  segments: [
    { id: 's0', startFrame: 0, frameCount: 48, prompt: 'first', sourcePanelId: 'panel-a' },
    {
      id: 's1', startFrame: 48, frameCount: 49, prompt: 'second image0',
      referenceMediaIds: ['ref-1'], referenceVideoMediaId: 'video-segment',
    },
  ],
}

describe('Bernini Director workflow compatibility', () => {
  it('parses the app spec and keeps deterministic media ordering', () => {
    const parsed = parseBerniniDirectorSpec(rawSpec)
    expect(parsed).not.toBeNull()
    expect(collectBerniniDirectorMediaOrders(parsed!)).toEqual({
      imageKeys: ['media:ref-0', 'panel:panel-a', 'media:ref-1'],
      videoMediaIds: ['video-source', 'video-reference', 'video-segment'],
    })
  })

  it('keeps Bernini and LTX settings in separate slots', () => {
    const ltx = { version: 1, fps: 24, globalPrompt: '', segments: [{ durationSeconds: 3 }] }
    const withLtx = mergeDirectorConfig(null, 'ltx', ltx)
    const envelope = mergeDirectorConfig(withLtx, 'bernini', rawSpec)
    expect(parseBerniniDirectorSpec(envelope)?.taskType).toBe('rv2v')
    expect(JSON.parse(envelope).ltx).toEqual(ltx)
  })

  it('renders version 4 timeline JSON and all node controls', () => {
    const spec = parseBerniniDirectorSpec(rawSpec)!
    const rendered = renderBerniniDirectorNode({
      spec,
      imageFiles: [
        { name: 'ref0.webp', subfolder: 'w', type: 'input' },
        { name: 'panel.webp', subfolder: 'w', type: 'input' },
        { name: 'ref1.webp', subfolder: 'w', type: 'input' },
      ],
      videoFiles: [
        { name: 'source.mp4', subfolder: 'w', type: 'input' },
        { name: 'global.mp4', subfolder: 'w', type: 'input' },
        { name: 'segment.mp4', subfolder: 'w', type: 'input' },
      ],
    })
    const timeline = JSON.parse(rendered.timelineData)
    expect(timeline.video.videoFile).toBe('w/source.mp4')
    expect(timeline.global.refs[0].imageFile).toBe('w/ref0.webp')
    expect(timeline.segments[0].genImage.imageFile).toBe('w/panel.webp')
    expect(timeline.segments[1].refs[0].imageFile).toBe('w/ref1.webp')
    expect(timeline.segments[1].referenceVideo.videoFile).toBe('w/segment.mp4')
    expect(timeline.runSelection).toEqual([1])
    expect(rendered.inputs).toMatchObject({
      task_type: 'rv2v — 参考素材改视频',
      total_frames: 97,
      frame_rate: 24,
      width: 1280,
      height: 720,
      steps: 6,
      split_step: 3,
      llm_auto_enhance: true,
    })
  })

  it('augments imported workflow contracts and advertises the dedicated tab', () => {
    const graph = {
      '4': { class_type: 'ComfyBerniniDirector', inputs: { timeline_data: '{}' } },
    }
    expect(hasBerniniDirectorNode(graph)).toBe(true)
    const contract = augmentBerniniDirectorContract({
      graph,
      variableDefinitions: [],
      bindings: [],
    })
    expect(contract.variableDefinitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'prompt', type: 'string' }),
      expect.objectContaining({ name: 'referenceImages', type: 'image_ref_list', maxItems: 64 }),
      expect.objectContaining({ name: 'berniniVideos', type: 'video_ref_list', maxItems: 16 }),
    ]))
    expect(contract.bindings).toContainEqual(expect.objectContaining({
      nodeId: '4', inputPath: 'timeline_data', transform: 'bernini_director_timeline',
    }))
    expect(buildComfyWorkflowModelOption({
      id: 'workflow', name: 'Bernini', mediaType: 'video',
      currentVersion: {
        id: 'version', purpose: 'generation', apiFormatJson: graph,
        variableDefinitions: [], bindingSpec: [],
      },
    }).workflowFeatures).toEqual({ berniniDirector: true })
    const analysis = analyzeComfyApiWorkflow({
      graph: {
        ...graph,
        '9': { class_type: 'VHS_VideoCombine', inputs: { images: ['4', 0] } },
      },
      kind: 'video_generation',
    })
    expect(analysis.proposals).toContainEqual(expect.objectContaining({
      nodeId: '4', inputPath: 'timeline_data',
      transform: 'bernini_director_timeline', referenceIndex: 0,
    }))
    expect(analysis.referenceCapacity).toBe(64)
  })
})
