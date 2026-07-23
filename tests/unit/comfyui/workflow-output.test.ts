import { describe, expect, it } from 'vitest'

import { extractComfyOutputs } from '@/lib/comfyui/workflow-output'

describe('ComfyUI workflow history outputs', () => {
  it('extracts an mp4 returned by VideoHelperSuite under the gifs field', () => {
    const outputs = extractComfyOutputs({
      promptId: {
        outputs: {
          '8': {
            gifs: [{
              filename: 'ComfyUI_00069_.mp4',
              subfolder: 'video/jobs',
              type: 'output',
            }],
          },
        },
      },
    }, [{
      name: 'video',
      nodeId: '8',
      fieldPath: 'gifs',
      mediaType: 'video',
      primary: true,
    }])

    expect(outputs).toEqual([{
      name: 'video',
      nodeId: '8',
      mediaType: 'video',
      primary: true,
      filename: 'ComfyUI_00069_.mp4',
      subfolder: 'video/jobs',
      type: 'output',
    }])
  })

  it('accepts an mp4 returned by SaveVideo under images when the saved binding says videos', () => {
    const outputs = extractComfyOutputs({
      promptId: {
        outputs: {
          '103': {
            images: [{
              filename: 'ComfyUI_00001_.mp4',
              subfolder: 'video',
              type: 'output',
            }],
          },
        },
      },
    }, [{
      name: 'video',
      nodeId: '103',
      fieldPath: 'videos',
      mediaType: 'video',
      primary: true,
    }])

    expect(outputs).toEqual([{
      name: 'video',
      nodeId: '103',
      mediaType: 'video',
      primary: true,
      filename: 'ComfyUI_00001_.mp4',
      subfolder: 'video',
      type: 'output',
    }])
  })
})
