import { describe, expect, it } from 'vitest'

import { analyzeComfyApiWorkflow } from '@/lib/comfyui/workflow-auto-mapper'

const apiGraph = {
  '1': {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'portrait' },
    _meta: { title: 'Positive Prompt' },
  },
  '2': { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
  '3': { class_type: 'KSampler', inputs: { seed: 7 } },
}

function scalarGraph(title: string, inputName: string) {
  return {
    '1': {
      class_type: title.replaceAll(' ', ''),
      inputs: { [inputName]: inputName === 'text' ? 'value' : 1 },
      _meta: { title },
    },
    '9': { class_type: 'VHS_VideoCombine', inputs: { images: ['1', 0] } },
  }
}

function multiReferenceGraph() {
  return {
    '2': {
      class_type: 'LoadImage', inputs: { image: 'style.png' },
      _meta: { title: 'Style Reference 2' },
    },
    '1': {
      class_type: 'LoadImage', inputs: { image: 'character.png' },
      _meta: { title: 'Character Reference 1' },
    },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
  }
}

function ambiguousLoaderGraph() {
  return {
    '1': { class_type: 'LoadImage', inputs: { image: 'input.png' } },
    '9': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
  }
}

describe('ComfyUI API workflow auto mapper', () => {
  it('unwraps the common object-valued prompt API payload', () => {
    const result = analyzeComfyApiWorkflow({
      graph: { prompt: apiGraph },
      kind: 'image_generation',
    })

    expect(result.graph).toEqual(apiGraph)
    expect(result.graph).not.toBe(apiGraph)
  })

  it('does not unwrap a prompt graph embedded in normal UI Workflow JSON', () => {
    expect(() => analyzeComfyApiWorkflow({
      graph: { nodes: [], links: [], prompt: apiGraph },
      kind: 'image_generation',
    })).toThrow('COMFY_WORKFLOW_API_FORMAT_REQUIRED')
  })

  it('keeps a legitimate top-level API graph whose node id is prompt', () => {
    const graph = {
      prompt: {
        class_type: 'CLIPTextEncode',
        inputs: { text: 'portrait' },
        _meta: { title: 'Positive Prompt' },
      },
      output: { class_type: 'SaveImage', inputs: { images: ['prompt', 0] } },
    }

    const result = analyzeComfyApiWorkflow({ graph, kind: 'image_generation' })

    expect(result.graph).toEqual(graph)
    expect(result.proposals).toContainEqual(expect.objectContaining({
      nodeId: 'prompt', canonicalName: 'prompt', confidence: 'high',
    }))
  })

  it.each([
    { nodes: [], links: [] },
    [],
  ])('rejects normal Workflow JSON with an API Format export diagnostic', (graph) => {
    expect(() => analyzeComfyApiWorkflow({ graph, kind: 'image_generation' }))
      .toThrow('COMFY_WORKFLOW_API_FORMAT_REQUIRED')
  })

  it('rejects malformed API Format nodes', () => {
    expect(() => analyzeComfyApiWorkflow({
      graph: { '1': { class_type: '', inputs: [] } },
      kind: 'image_generation',
    })).toThrow('COMFY_WORKFLOW_API_FORMAT_INVALID')
  })

  it('returns immutable graph data and canonical proposal metadata', () => {
    const result = analyzeComfyApiWorkflow({ graph: apiGraph, kind: 'image_generation' })

    expect(result.graph).toEqual(apiGraph)
    expect(result.graph).not.toBe(apiGraph)
    expect(result.graph['1']).not.toBe(apiGraph['1'])
    expect(result.proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonicalName: 'prompt', confidence: 'high' }),
    ]))
    expect(result.outputs).toEqual([
      expect.objectContaining({
        nodeId: '2', fieldPath: 'images', mediaType: 'image', primary: true,
      }),
    ])
    expect(result.issues).toEqual([])
  })

  it('reports a blocking issue when no compatible output exists', () => {
    const result = analyzeComfyApiWorkflow({
      graph: {
        '1': { class_type: 'CLIPTextEncode', inputs: { text: 'portrait' } },
      },
      kind: 'image_generation',
    })

    expect(result.outputs).toEqual([])
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'COMFY_WORKFLOW_OUTPUT_REQUIRED',
    }))
  })

  it('requires selection when several compatible outputs exist', () => {
    const result = analyzeComfyApiWorkflow({
      graph: {
        '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
        '3': { class_type: 'PreviewImage', inputs: { images: ['1', 0] } },
      },
      kind: 'image_generation',
    })

    expect(result.outputs).toHaveLength(2)
    expect(result.outputs.every((output) => !output.primary)).toBe(true)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'COMFY_WORKFLOW_OUTPUT_AMBIGUOUS',
    }))
  })

  it('recognizes a unique video output for video workflows', () => {
    const result = analyzeComfyApiWorkflow({
      graph: {
        '8': { class_type: 'VHS_VideoCombine', inputs: { images: ['1', 0] } },
      },
      kind: 'video_generation',
    })

    expect(result.outputs).toEqual([
      expect.objectContaining({
        nodeId: '8', fieldPath: 'gifs', mediaType: 'video', primary: true,
      }),
    ])
  })

  it.each([
    ['Positive Prompt', 'text', 'prompt'],
    ['Negative Prompt', 'text', 'negativePrompt'],
    ['Empty Latent Image', 'width', 'width'],
    ['Empty Latent Image', 'height', 'height'],
    ['KSampler', 'seed', 'seed'],
    ['Video Settings', 'duration', 'duration'],
    ['Video Settings', 'fps', 'fps'],
  ] as const)('maps %s.%s to %s', (title, inputName, canonicalName) => {
    const result = analyzeComfyApiWorkflow({
      graph: scalarGraph(title, inputName),
      kind: 'video_generation',
    })

    expect(result.proposals).toContainEqual(expect.objectContaining({
      canonicalName,
      confidence: 'high',
      inputPath: inputName,
    }))
  })

  it.each([
    ['duration', 5.5, 'seconds', 'number'],
    ['seconds', '5.5', 'seconds', 'numeric_string'],
    ['duration_seconds', 5.5, 'seconds', 'number'],
    ['num_frames', 81, 'frames', 'number'],
    ['frame_count', '81', 'frames', 'numeric_string'],
    ['video_length', 81, 'frames', 'number'],
  ] as const)(
    'proposes duration semantics for %s',
    (inputPath, value, targetUnit, output) => {
      const result = analyzeComfyApiWorkflow({
        kind: 'video_generation',
        graph: {
          video: {
            class_type: 'VideoLengthNode',
            inputs: { [inputPath]: value },
          },
          prompt: { class_type: 'CLIPTextEncode', inputs: { text: 'move' } },
          out: { class_type: 'SaveVideo', inputs: { filename_prefix: 'out' } },
        },
      })

      expect(result.proposals).toEqual(expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'video',
          inputPath,
          canonicalName: 'duration',
          numericTransform: expect.objectContaining({ targetUnit, output }),
        }),
      ]))
    },
  )

  it('keeps a video length field confirmable but does not infer an unrelated length field', () => {
    const video = analyzeComfyApiWorkflow({
      kind: 'video_generation',
      graph: {
        timing: { class_type: 'VideoTiming', inputs: { length: 81 } },
        out: { class_type: 'SaveVideo', inputs: { filename_prefix: 'out' } },
      },
    })
    const unrelated = analyzeComfyApiWorkflow({
      kind: 'video_generation',
      graph: {
        text: { class_type: 'StringUtility', inputs: { length: 81 } },
        out: { class_type: 'SaveVideo', inputs: { filename_prefix: 'out' } },
      },
    })

    expect(video.proposals).toContainEqual(expect.objectContaining({
      nodeId: 'timing', inputPath: 'length', canonicalName: 'duration',
      confidence: 'ambiguous',
      numericTransform: expect.objectContaining({ targetUnit: 'frames' }),
    }))
    expect(unrelated.proposals.some((item) => (
      item.nodeId === 'text' && item.canonicalName === 'duration'
    ))).toBe(false)
  })

  it.each([NaN, Infinity, -Infinity, ' ', 'NaN', 'Infinity'])(
    'does not expose a non-finite duration scalar: %s',
    (value) => {
      const result = analyzeComfyApiWorkflow({
        kind: 'video_generation',
        graph: {
          video: { class_type: 'VideoLengthNode', inputs: { duration: value } },
          out: { class_type: 'SaveVideo', inputs: { filename_prefix: 'out' } },
        },
      })
      expect(result.proposals.some((item) => item.canonicalName === 'duration')).toBe(false)
    },
  )

  it('does not treat a non-decimal numeric-looking string as duration', () => {
    const result = analyzeComfyApiWorkflow({
      kind: 'video_generation',
      graph: {
        video: { class_type: 'VideoLengthNode', inputs: { duration: '0x10' } },
        out: { class_type: 'SaveVideo', inputs: { filename_prefix: 'out' } },
      },
    })

    expect(result.proposals.some((item) => item.canonicalName === 'duration')).toBe(false)
  })

  it('marks an unlabelled text encoder as ambiguous instead of silently positive', () => {
    const result = analyzeComfyApiWorkflow({
      graph: {
        '1': { class_type: 'CLIPTextEncode', inputs: { text: 'value' } },
        '9': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
      },
      kind: 'image_generation',
    })

    expect(result.proposals).toContainEqual(expect.objectContaining({
      canonicalName: 'prompt',
      confidence: 'ambiguous',
    }))
    expect(result.proposals).not.toContainEqual(expect.objectContaining({
      canonicalName: 'prompt',
      confidence: 'high',
    }))
  })

  it('never exposes workflow-owned model or sampler parameters', () => {
    const result = analyzeComfyApiWorkflow({
      graph: {
        '1': {
          class_type: 'KSampler',
          inputs: {
            model: ['2', 0], lora: 'style.safetensors', sampler_name: 'euler',
            scheduler: 'normal', steps: 20, cfg: 7,
          },
        },
        '2': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
        '9': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
      },
      kind: 'image_generation',
    })

    expect(result.proposals).toEqual([])
  })

  it('orders all existing reference inputs without inventing nodes', () => {
    const graph = multiReferenceGraph()
    const result = analyzeComfyApiWorkflow({ graph, kind: 'image_edit' })
    const references = result.proposals.filter((row) => row.canonicalName === 'referenceImages')

    expect(references).toMatchObject([
      { nodeId: '1', referenceIndex: 0, valueType: 'image_ref_list', transform: 'filename_at' },
      { nodeId: '2', referenceIndex: 1, valueType: 'image_ref_list', transform: 'filename_at' },
    ])
    expect(result.referenceCapacity).toBe(2)
    expect(Object.keys(result.graph)).toEqual(Object.keys(graph))
    expect(result.graph).toEqual(graph)
  })

  it('requires confirmation for an unlabeled image loader', () => {
    const result = analyzeComfyApiWorkflow({
      graph: ambiguousLoaderGraph(),
      kind: 'image_edit',
    })

    expect(result.proposals).toContainEqual(expect.objectContaining({
      canonicalName: 'sourceImage',
      valueType: 'image_ref',
      transform: 'filename',
      confidence: 'ambiguous',
      required: true,
    }))
  })

  it('keeps an unlabeled reference loader ambiguous until the user confirms its role', () => {
    const result = analyzeComfyApiWorkflow({
      graph: ambiguousLoaderGraph(),
      kind: 'image_generation',
    })

    expect(result.proposals).toContainEqual(expect.objectContaining({
      canonicalName: 'referenceImages',
      confidence: 'ambiguous',
      reasonCode: 'COMFY_MAPPING_IMAGE_ROLE_AMBIGUOUS',
    }))
  })

  it.each([
    ['Source Image', 'image_edit', 'sourceImage'],
    ['Img2Img Init Image', 'image_edit', 'sourceImage'],
    ['First Frame', 'video_generation', 'firstFrame'],
    ['Start Image', 'video_generation', 'firstFrame'],
    ['Last Frame', 'video_generation', 'lastFrame'],
    ['End Image', 'video_generation', 'lastFrame'],
  ] as const)('maps %s loader to %s', (title, kind, canonicalName) => {
    const outputClass = kind === 'video_generation' ? 'VHS_VideoCombine' : 'SaveImage'
    const result = analyzeComfyApiWorkflow({
      graph: {
        '1': { class_type: 'LoadImage', inputs: { image: 'input.png' }, _meta: { title } },
        '9': { class_type: outputClass, inputs: { images: ['1', 0] } },
      },
      kind,
    })

    expect(result.proposals).toContainEqual(expect.objectContaining({
      canonicalName,
      valueType: 'image_ref',
      transform: 'filename',
      confidence: 'high',
    }))
  })

  it('maps an existing source video loader for video-to-video', () => {
    const result = analyzeComfyApiWorkflow({
      graph: {
        '1': {
          class_type: 'VHS_LoadVideo', inputs: { video: 'source.mp4' },
          _meta: { title: 'Source Video' },
        },
        '9': { class_type: 'VHS_VideoCombine', inputs: { images: ['1', 0] } },
      },
      kind: 'video_to_video',
    })

    expect(result.proposals).toContainEqual(expect.objectContaining({
      canonicalName: 'sourceVideo',
      valueType: 'video_ref',
      transform: 'filename',
      confidence: 'high',
      required: true,
    }))
  })

  it('uses one bounded list binding only when the existing loader accepts a list', () => {
    const result = analyzeComfyApiWorkflow({
      graph: {
        '1': {
          class_type: 'LoadImageList', inputs: { images: ['a.png', 'b.png', 'c.png'] },
          _meta: { title: 'Reference Images' },
        },
        '9': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
      },
      kind: 'image_generation',
    })

    expect(result.proposals).toContainEqual(expect.objectContaining({
      canonicalName: 'referenceImages',
      inputPath: 'images',
      valueType: 'image_ref_list',
      transform: 'filename_list',
      referenceIndex: 0,
    }))
    expect(result.referenceCapacity).toBe(3)
  })

  it('maps BerniniStudio prompts and one compact eight-slot reference family', () => {
    const result = analyzeComfyApiWorkflow({
      graph: {
        '30': {
          class_type: 'LoadImage',
          inputs: { image: 'placeholder.png' },
        },
        '38': {
          class_type: 'BerniniStudio',
          inputs: {
            prompt: 'image0 walks into a cafe',
            negative_prompt: 'low quality',
            image0: ['30', 0],
          },
        },
        '51': { class_type: 'PreviewImage', inputs: { images: ['38', 0] } },
      },
      kind: 'image_generation',
    })

    expect(result.proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: '38', inputPath: 'prompt', canonicalName: 'prompt', confidence: 'high',
      }),
      expect.objectContaining({
        nodeId: '38', inputPath: 'negative_prompt', canonicalName: 'negativePrompt',
        confidence: 'high',
      }),
    ]))
    expect(result.proposals.filter((proposal) => proposal.canonicalName === 'referenceImages'))
      .toEqual([expect.objectContaining({
        nodeId: '38', inputPath: 'image0', valueType: 'image_ref_list',
        transform: 'bernini_image_slots', referenceIndex: 0, confidence: 'high',
      })])
    expect(result.referenceCapacity).toBe(8)
    expect(result.proposals).not.toContainEqual(expect.objectContaining({ nodeId: '30' }))
  })

  it('offers Bernini dynamic references even when the authored graph has no image socket', () => {
    const result = analyzeComfyApiWorkflow({
      graph: {
        '38': {
          class_type: 'BerniniStudio',
          inputs: { prompt: 'a quiet cafe', negative_prompt: 'low quality' },
        },
        '51': { class_type: 'PreviewImage', inputs: { images: ['38', 0] } },
      },
      kind: 'image_generation',
    })

    expect(result.proposals).toContainEqual(expect.objectContaining({
      nodeId: '38', inputPath: 'image0', canonicalName: 'referenceImages',
      transform: 'bernini_image_slots', confidence: 'high',
    }))
    expect(result.referenceCapacity).toBe(8)
  })
})
