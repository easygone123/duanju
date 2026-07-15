import { describe, expect, it } from 'vitest'
import { COMFY_ERROR_CODE, ComfyError } from '@/lib/comfyui/errors'
import { renderComfyWorkflow } from '@/lib/comfyui/workflow-renderer'
import { extractComfyOutputs } from '@/lib/comfyui/workflow-output'
import { deriveComfyRequirements } from '@/lib/comfyui/workflow-requirements'
import {
  discoverComfyPlaceholders,
  validateComfyApiWorkflow,
  validateWorkflowContract,
} from '@/lib/comfyui/workflow-schema'

describe('ComfyUI workflow compiler', () => {
  it('renders typed placeholders before explicit binding overrides', () => {
    const graph = {
      '1': { class_type: 'CLIPTextEncode', inputs: { text: '${prompt}' } },
      '2': {
        class_type: 'EmptyLatentImage',
        inputs: { width: '${width}', height: 512 },
      },
      '3': {
        class_type: 'SaveImage',
        inputs: { images: ['2', 0], filename_prefix: 'shot-${seed}' },
      },
    }

    const rendered = renderComfyWorkflow({
      graph,
      variables: { prompt: 'rain', width: 768, seed: 42 },
      variableDefinitions: [
        { name: 'prompt', type: 'string', required: true },
        { name: 'width', type: 'number', required: true },
        { name: 'seed', type: 'number', required: true },
      ],
      bindings: [
        {
          nodeId: '2',
          inputPath: 'height',
          variable: 'width',
          valueType: 'number',
        },
      ],
      uploads: {},
    })

    expect(rendered['1'].inputs.text).toBe('rain')
    expect(rendered['2'].inputs).toMatchObject({ width: 768, height: 768 })
    expect(rendered['3'].inputs.filename_prefix).toBe('shot-42')
    expect(graph['2'].inputs).toEqual({ width: '${width}', height: 512 })
  })

  it('validates API Format links and returns an isolated graph', () => {
    const raw = {
      source: { class_type: 'LoadImage', inputs: { image: 'in.png' } },
      sink: { class_type: 'PreviewImage', inputs: { images: ['source', 0] } },
    }

    const validated = validateComfyApiWorkflow(raw)

    expect(validated).toEqual(raw)
    expect(validated).not.toBe(raw)
    expect(validated.source.inputs).not.toBe(raw.source.inputs)
  })

  it('rejects missing link nodes and malformed node contracts', () => {
    const missingLinkError = captureError(() =>
      validateComfyApiWorkflow({
        sink: { class_type: 'PreviewImage', inputs: { images: ['missing', 0] } },
      }),
    )
    const malformedNodeError = captureError(() =>
      validateComfyApiWorkflow({ node: { class_type: '', inputs: [] } }),
    )

    expect(missingLinkError).toMatchObject({
      code: COMFY_ERROR_CODE.WORKFLOW_FORMAT_INVALID,
    })
    expect(malformedNodeError).toMatchObject({
      code: COMFY_ERROR_CODE.WORKFLOW_FORMAT_INVALID,
    })
  })

  it.each([
    ['numeric string output index', ['1', '0']],
    ['missing node with numeric output index', ['missing', 0]],
    ['negative output index', ['1', -1]],
    ['fractional output index', ['1', 0.5]],
  ])('rejects malformed link tuples: %s', (_case, link) => {
    const error = captureError(() =>
      validateComfyApiWorkflow({
        '1': { class_type: 'Source', inputs: {} },
        sink: { class_type: 'Sink', inputs: { images: link } },
      }),
    ) as ComfyError

    expect(error.code).toBe(COMFY_ERROR_CODE.WORKFLOW_FORMAT_INVALID)
    expect(error.details).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'COMFY_API_FORMAT_INVALID',
        path: 'sink.inputs.images',
      }),
    ]))
  })

  it('accepts valid links and ambiguous two-string input arrays', () => {
    expect(validateComfyApiWorkflow({
      '1': { class_type: 'Source', inputs: {} },
      sink: {
        class_type: 'Sink',
        inputs: {
          images: ['1', 0],
          filenames: ['image-a.png', 'image-b.png'],
          draftVersion: ['draft', '2'],
          dimensions: ['1920', '1080'],
          unknownReference: ['missing', '0'],
        },
      },
    })).toEqual({
      '1': { class_type: 'Source', inputs: {} },
      sink: {
        class_type: 'Sink',
        inputs: {
          images: ['1', 0],
          filenames: ['image-a.png', 'image-b.png'],
          draftVersion: ['draft', '2'],
          dimensions: ['1920', '1080'],
          unknownReference: ['missing', '0'],
        },
      },
    })
  })

  it('rejects UI Format with an actionable stable issue', () => {
    const error = captureError(() =>
      validateComfyApiWorkflow({
        last_node_id: 1,
        nodes: [{ id: 1, type: 'SaveImage' }],
        links: [],
      }),
    ) as ComfyError

    expect(error.code).toBe(COMFY_ERROR_CODE.WORKFLOW_FORMAT_INVALID)
    expect(error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'COMFY_UI_FORMAT_UNSUPPORTED' }),
      ]),
    )
    expect(error.message).toContain('API Format')
  })

  it('discovers unique placeholders recursively in strings', () => {
    const graph = validateComfyApiWorkflow({
      '1': {
        class_type: 'Node',
        inputs: {
          nested: { prompt: '${prompt}', labels: ['shot-${seed}', '${prompt}'] },
        },
      },
    })

    expect(discoverComfyPlaceholders(graph)).toEqual(['prompt', 'seed'])
  })

  it('supports nonempty variable names containing hyphens and dots', () => {
    const graph = validateComfyApiWorkflow({
      '1': {
        class_type: 'Node',
        inputs: { label: '${style-name}', nested: 'look-${prompt.style}' },
      },
    })
    const contract = {
      graph,
      variableDefinitions: [
        { name: 'style-name', type: 'string' as const, required: true },
        { name: 'prompt.style', type: 'string' as const, required: true },
      ],
      bindings: [
        {
          nodeId: '1', inputPath: 'nested', variable: 'prompt.style',
          valueType: 'string' as const,
        },
      ],
      outputs: [
        {
          name: 'result', nodeId: '1', fieldPath: 'images',
          mediaType: 'image' as const, primary: true,
        },
      ],
    }

    expect(discoverComfyPlaceholders(graph)).toEqual(['style-name', 'prompt.style'])
    expect(validateWorkflowContract(contract)).toEqual([])
    expect(renderComfyWorkflow({
      ...contract,
      variables: { 'style-name': 'ink', 'prompt.style': 'cinematic' },
      uploads: {},
    })['1'].inputs).toEqual({ label: 'ink', nested: 'cinematic' })
  })

  it('throws a deterministic error for a missing required variable', () => {
    const error = captureError(() =>
      renderComfyWorkflow({
        graph: {
          '1': { class_type: 'CLIPTextEncode', inputs: { text: '${prompt}' } },
        },
        variables: {},
        variableDefinitions: [{ name: 'prompt', type: 'string', required: true }],
        bindings: [],
        uploads: {},
      }),
    ) as ComfyError

    expect(error.code).toBe(COMFY_ERROR_CODE.WORKFLOW_BINDING_INVALID)
    expect(error.details).toEqual(
      expect.objectContaining({ variable: 'prompt', reason: 'required' }),
    )
  })

  it('uses optional defaults and preserves original targets when declared', () => {
    const graph = {
      '1': {
        class_type: 'Node',
        inputs: { width: '${width}', caption: '${caption}', height: 512 },
      },
    }

    const rendered = renderComfyWorkflow({
      graph,
      variables: {},
      variableDefinitions: [
        { name: 'width', type: 'number', required: false, defaultValue: 640 },
        {
          name: 'caption',
          type: 'string',
          required: false,
          missingValuePolicy: 'preserve_original',
        },
      ],
      bindings: [
        {
          nodeId: '1',
          inputPath: 'height',
          variable: 'caption',
          valueType: 'string',
          missingValuePolicy: 'preserve_original',
        },
      ],
      uploads: {},
    })

    expect(rendered['1'].inputs).toEqual({
      width: 640,
      caption: '${caption}',
      height: 512,
    })
    expect(graph['1'].inputs).toEqual({
      width: '${width}',
      caption: '${caption}',
      height: 512,
    })
  })

  it.each(['__proto__.polluted', 'nested.constructor.value', '../height']) (
    'rejects unsafe binding path %s without prototype pollution',
    (inputPath) => {
      const error = captureError(() =>
        renderComfyWorkflow({
          graph: { '1': { class_type: 'Node', inputs: { height: 512 } } },
          variables: { width: 768 },
          variableDefinitions: [{ name: 'width', type: 'number', required: true }],
          bindings: [
            { nodeId: '1', inputPath, variable: 'width', valueType: 'number' },
          ],
          uploads: {},
        }),
      ) as ComfyError

      expect(error.code).toBe(COMFY_ERROR_CODE.WORKFLOW_BINDING_INVALID)
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    },
  )

  it('applies only enumerated upload transforms without mutating uploads', () => {
    const upload = { name: 'input.png', subfolder: 'waoowaoo', type: 'input' }
    const secondUpload = { name: 'mask.png', subfolder: '', type: 'input' }
    const uploads = { image: upload, images: [upload, secondUpload] }

    const rendered = renderComfyWorkflow({
      graph: {
        '1': {
          class_type: 'LoadImage',
          inputs: { filename: '', image_ref: {}, filenames: [] },
        },
      },
      variables: {
        image: { storageKey: 'image-key' },
        images: [{ storageKey: 'image-key' }, { storageKey: 'mask-key' }],
      },
      variableDefinitions: [
        { name: 'image', type: 'image_ref', required: true },
        { name: 'images', type: 'image_ref_list', required: true },
      ],
      bindings: [
        {
          nodeId: '1', inputPath: 'filename', variable: 'image',
          valueType: 'image_ref', transform: 'filename',
        },
        {
          nodeId: '1', inputPath: 'image_ref', variable: 'image',
          valueType: 'image_ref', transform: 'image_ref',
        },
        {
          nodeId: '1', inputPath: 'filenames', variable: 'images',
          valueType: 'image_ref_list', transform: 'filename_list',
        },
      ],
      uploads,
    })

    expect(rendered['1'].inputs).toEqual({
      filename: 'input.png',
      image_ref: { filename: 'input.png', subfolder: 'waoowaoo', type: 'input' },
      filenames: ['input.png', 'mask.png'],
    })
    expect(uploads).toEqual({ image: upload, images: [upload, secondUpload] })
  })

  it('maps indexed reference images into separate scalar loader inputs', () => {
    const firstUpload = { name: 'reference-1.png', subfolder: 'refs', type: 'input' }
    const secondUpload = { name: 'reference-2.png', subfolder: 'refs', type: 'input' }
    const contract = {
      graph: {
        '1': { class_type: 'LoadImage', inputs: { image: 'original-1.png' } },
        '2': { class_type: 'LoadImage', inputs: { image: 'original-2.png' } },
      },
      variableDefinitions: [{
        name: 'referenceImages', type: 'image_ref_list' as const, required: false,
        maxItems: 2, missingValuePolicy: 'preserve_original' as const,
      }],
      bindings: [
        {
          nodeId: '1', inputPath: 'image', variable: 'referenceImages',
          valueType: 'image_ref_list' as const, transform: 'filename_at' as const,
          valueIndex: 0, missingValuePolicy: 'preserve_original' as const,
        },
        {
          nodeId: '2', inputPath: 'image', variable: 'referenceImages',
          valueType: 'image_ref_list' as const, transform: 'filename_at' as const,
          valueIndex: 1, missingValuePolicy: 'preserve_original' as const,
        },
      ],
      outputs: [{
        name: 'image', nodeId: '2', fieldPath: 'images', mediaType: 'image' as const, primary: true,
      }],
    }

    expect(validateWorkflowContract(contract)).toEqual([])
    expect(renderComfyWorkflow({
      ...contract,
      variables: {
        referenceImages: [{ storageKey: 'ref-1' }, { storageKey: 'ref-2' }],
      },
      uploads: { referenceImages: [firstUpload, secondUpload] },
    })).toMatchObject({
      '1': { inputs: { image: 'reference-1.png' } },
      '2': { inputs: { image: 'reference-2.png' } },
    })
  })

  it('preserves original reference loader filenames when optional references are absent', () => {
    const rendered = renderComfyWorkflow({
      graph: {
        '1': { class_type: 'LoadImage', inputs: { image: 'original-1.png' } },
        '2': { class_type: 'LoadImage', inputs: { image: 'original-2.png' } },
      },
      variables: {},
      variableDefinitions: [{
        name: 'referenceImages', type: 'image_ref_list', required: false, maxItems: 2,
        missingValuePolicy: 'preserve_original',
      }],
      bindings: [0, 1].map((valueIndex) => ({
        nodeId: String(valueIndex + 1), inputPath: 'image', variable: 'referenceImages',
        valueType: 'image_ref_list' as const, transform: 'filename_at' as const,
        valueIndex, missingValuePolicy: 'preserve_original' as const,
      })),
      uploads: {},
    })

    expect(rendered['1'].inputs.image).toBe('original-1.png')
    expect(rendered['2'].inputs.image).toBe('original-2.png')
  })

  it('rejects invalid indexed reference-image contract fields', () => {
    const issues = validateWorkflowContract({
      graph: { '1': { class_type: 'LoadImage', inputs: { image: 'original.png' } } },
      variableDefinitions: [{
        name: 'referenceImages', type: 'image_ref_list', required: false,
        maxItems: 0, missingValuePolicy: 'preserve_original',
      }],
      bindings: [{
        nodeId: '1', inputPath: 'image', variable: 'referenceImages',
        valueType: 'image_ref_list', transform: 'filename_at', valueIndex: -1,
        missingValuePolicy: 'preserve_original',
      }],
      outputs: [{
        name: 'image', nodeId: '1', fieldPath: 'images', mediaType: 'image', primary: true,
      }],
    })

    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'COMFY_VARIABLE_MAX_ITEMS_INVALID',
      'COMFY_BINDING_VALUE_INDEX_INVALID',
    ]))
  })

  it('rejects reference capacity above the bounded upload limit', () => {
    const issues = validateWorkflowContract({
      graph: { '1': { class_type: 'SaveImage', inputs: {} } },
      variableDefinitions: [{
        name: 'referenceImages', type: 'image_ref_list', required: false,
        maxItems: 9, missingValuePolicy: 'preserve_original',
      }],
      bindings: [],
      outputs: [{
        name: 'image', nodeId: '1', fieldPath: 'images', mediaType: 'image', primary: true,
      }],
    })

    expect(issues).toContainEqual(expect.objectContaining({
      code: 'COMFY_VARIABLE_MAX_ITEMS_INVALID',
    }))
  })

  it('rejects transform/type incompatibility during rendering', () => {
    const error = captureError(() =>
      renderComfyWorkflow({
        graph: { '1': { class_type: 'Node', inputs: { filename: '' } } },
        variables: { label: 'not-media' },
        variableDefinitions: [{ name: 'label', type: 'string', required: true }],
        bindings: [
          {
            nodeId: '1', inputPath: 'filename', variable: 'label',
            valueType: 'string', transform: 'filename',
          },
        ],
        uploads: {
          label: { name: 'input.png', subfolder: '', type: 'input' },
        },
      }),
    ) as ComfyError

    expect(error).toMatchObject({
      code: COMFY_ERROR_CODE.WORKFLOW_BINDING_INVALID,
      details: { variable: 'label', reason: 'transform_type' },
    })
  })

  it.each([
    [
      'malformed upload entry',
      [
        { name: 'input.png', subfolder: '', type: 'input' },
        { name: undefined, subfolder: '', type: 'input' },
      ],
    ],
    [
      'partial upload list',
      [{ name: 'input.png', subfolder: '', type: 'input' }],
    ],
    ['empty upload list', []],
  ])('rejects filename_list with %s', (_case, uploads) => {
    const error = captureError(() =>
      renderComfyWorkflow({
        graph: { '1': { class_type: 'Node', inputs: { filenames: [] } } },
        variables: {
          images: [{ storageKey: 'one' }, { storageKey: 'two' }],
        },
        variableDefinitions: [
          { name: 'images', type: 'image_ref_list', required: true },
        ],
        bindings: [
          {
            nodeId: '1', inputPath: 'filenames', variable: 'images',
            valueType: 'image_ref_list', transform: 'filename_list',
          },
        ],
        uploads: { images: uploads },
      } as unknown as Parameters<typeof renderComfyWorkflow>[0]),
    ) as ComfyError

    expect(error.code).toBe(COMFY_ERROR_CODE.WORKFLOW_BINDING_INVALID)
    expect(error.message).toContain('images')
  })

  it('validates the complete publication contract without mutating it', () => {
    const graph = {
      '1': { class_type: 'Node', inputs: { prompt: '${prompt}', width: 512 } },
    }
    const variableDefinitions = [
      { name: 'prompt', type: 'string' as const, required: true },
    ]
    const bindings = [
      {
        nodeId: '1', inputPath: 'prompt', variable: 'prompt',
        valueType: 'string' as const,
      },
    ]
    const outputs = [
      {
        name: 'image', nodeId: '1', fieldPath: 'images',
        mediaType: 'image' as const, primary: true,
      },
    ]

    expect(validateWorkflowContract({
      graph, variableDefinitions, bindings, outputs,
    })).toEqual([])
    expect(graph['1'].inputs.prompt).toBe('${prompt}')
    expect(bindings[0].inputPath).toBe('prompt')
  })

  it('returns stable issues for undeclared variables and invalid output contracts', () => {
    const issues = validateWorkflowContract({
      graph: {
        '1': { class_type: 'Node', inputs: { prompt: '${undeclared}' } },
      },
      variableDefinitions: [],
      bindings: [
        {
          nodeId: 'missing', inputPath: '__proto__.bad', variable: 'unknown',
          valueType: 'string', transform: 'eval' as 'filename',
        },
      ],
      outputs: [
        {
          name: 'first', nodeId: '1', fieldPath: 'images',
          mediaType: 'image', primary: true,
        },
        {
          name: 'second', nodeId: 'missing', fieldPath: 'constructor.value',
          mediaType: 'video', primary: true,
        },
      ],
    })

    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'COMFY_VARIABLE_UNDECLARED',
      'COMFY_BINDING_NODE_MISSING',
      'COMFY_BINDING_PATH_UNSAFE',
      'COMFY_BINDING_TRANSFORM_INVALID',
      'COMFY_OUTPUT_PRIMARY_INVALID',
      'COMFY_OUTPUT_NODE_MISSING',
      'COMFY_OUTPUT_PATH_UNSAFE',
    ]))
  })

  it('requires at least one output and an explicit optional missing policy', () => {
    const issues = validateWorkflowContract({
      graph: { '1': { class_type: 'Node', inputs: {} } },
      variableDefinitions: [
        { name: 'optional', type: 'string', required: false },
      ],
      bindings: [],
      outputs: [],
    })

    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'COMFY_VARIABLE_MISSING_POLICY_REQUIRED',
      'COMFY_OUTPUT_REQUIRED',
      'COMFY_OUTPUT_PRIMARY_INVALID',
    ]))
  })

  it('returns deterministic issues for malformed variable definitions', () => {
    const issues = validateWorkflowContract({
      graph: { '1': { class_type: 'Node', inputs: {} } },
      variableDefinitions: [
        null,
        { name: 42, type: 'string', required: true },
        { name: '   ', type: 'string', required: true },
        { name: 'bad.name', type: 'string', required: true },
        { name: 'wrongType', type: 'expression', required: true },
        { name: 'wrongRequired', type: 'string', required: 'yes' },
        { name: 'wrongDefault', type: 'number', required: false, defaultValue: 'wide' },
        {
          name: 'wrongPolicy', type: 'string', required: false,
          missingValuePolicy: 'delete_original',
        },
        { name: 'duplicate', type: 'expression', required: true },
        { name: 'duplicate', type: 'string', required: true },
      ],
      bindings: [],
      outputs: [
        {
          name: 'result', nodeId: '1', fieldPath: 'images',
          mediaType: 'image', primary: true,
        },
      ],
    } as unknown as Parameters<typeof validateWorkflowContract>[0])

    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'COMFY_VARIABLE_DEFINITION_INVALID',
      'COMFY_VARIABLE_NAME_INVALID',
      'COMFY_VARIABLE_TYPE_INVALID',
      'COMFY_VARIABLE_REQUIRED_INVALID',
      'COMFY_VARIABLE_DEFAULT_TYPE_INVALID',
      'COMFY_VARIABLE_MISSING_POLICY_INVALID',
      'COMFY_VARIABLE_DUPLICATE',
    ]))
  })

  it('defensively validates binding fields and transform compatibility', () => {
    const issues = validateWorkflowContract({
      graph: { '1': { class_type: 'Node', inputs: {} } },
      variableDefinitions: [
        { name: 'label', type: 'string', required: true },
        { name: 'image', type: 'image_ref', required: true },
        { name: 'images', type: 'image_ref_list', required: true },
      ],
      bindings: [
        null,
        {
          nodeId: 3, inputPath: 42, variable: null, valueType: 'expression',
          missingValuePolicy: 'delete_original', transform: 'eval',
        },
        {
          nodeId: '1', inputPath: 'label', variable: 'label',
          valueType: 'string', transform: 'filename',
        },
        {
          nodeId: '1', inputPath: 'images', variable: 'image',
          valueType: 'image_ref', transform: 'filename_list',
        },
        {
          nodeId: '1', inputPath: 'image', variable: 'images',
          valueType: 'image_ref_list', transform: 'image_ref',
        },
      ],
      outputs: [
        {
          name: 'result', nodeId: '1', fieldPath: 'images',
          mediaType: 'image', primary: true,
        },
      ],
    } as unknown as Parameters<typeof validateWorkflowContract>[0])

    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'COMFY_BINDING_INVALID',
      'COMFY_BINDING_NODE_INVALID',
      'COMFY_BINDING_PATH_UNSAFE',
      'COMFY_BINDING_VARIABLE_INVALID',
      'COMFY_BINDING_VALUE_TYPE_INVALID',
      'COMFY_BINDING_MISSING_POLICY_INVALID',
      'COMFY_BINDING_TRANSFORM_INVALID',
      'COMFY_BINDING_TRANSFORM_TYPE_INVALID',
    ]))
    expect(issues.filter((issue) => issue.code === 'COMFY_BINDING_TRANSFORM_TYPE_INVALID'))
      .toHaveLength(3)
  })

  it('extracts arrays only from explicitly declared history fields', () => {
    const history = {
      'prompt-1': {
        outputs: {
          save: {
            images: [
              { filename: 'one.png', subfolder: 'out', type: 'output' },
              { filename: 'two.png', subfolder: 'out', type: 'output' },
            ],
            undeclared: [{ filename: 'secret.png', subfolder: '', type: 'output' }],
          },
          video: {
            files: [{ filename: 'clip.mp4', subfolder: 'video', type: 'output' }],
          },
        },
      },
    }

    const outputs = extractComfyOutputs(history, [
      {
        name: 'frames', nodeId: 'save', fieldPath: 'images',
        mediaType: 'image', primary: true,
      },
      {
        name: 'clip', nodeId: 'video', fieldPath: 'files',
        mediaType: 'video', primary: false,
      },
    ])

    expect(outputs).toEqual([
      {
        name: 'frames', nodeId: 'save', mediaType: 'image', primary: true,
        filename: 'one.png', subfolder: 'out', type: 'output',
      },
      {
        name: 'frames', nodeId: 'save', mediaType: 'image', primary: true,
        filename: 'two.png', subfolder: 'out', type: 'output',
      },
      {
        name: 'clip', nodeId: 'video', mediaType: 'video', primary: false,
        filename: 'clip.mp4', subfolder: 'video', type: 'output',
      },
    ])
    expect(outputs.some((output) => output.filename === 'secret.png')).toBe(false)
  })

  it('throws a stable output-missing error instead of guessing', () => {
    const error = captureError(() =>
      extractComfyOutputs(
        { outputs: { other: { images: [{ filename: 'guess.png' }] } } },
        [{
          name: 'result', nodeId: 'declared', fieldPath: 'images',
          mediaType: 'image', primary: true,
        }],
      ),
    ) as ComfyError

    expect(error.code).toBe(COMFY_ERROR_CODE.OUTPUT_MISSING)
    expect(error.details).toEqual({ nodeId: 'declared', fieldPath: 'images' })
  })

  it('derives sorted node classes and candidate string loader inputs', () => {
    const graph = validateComfyApiWorkflow({
      '9': {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: 'z-model.safetensors', dynamic: '${checkpoint}' },
      },
      '2': {
        class_type: 'VAELoader',
        inputs: { vae_name: 'vae.safetensors' },
      },
      '1': {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: 'a-model.safetensors' },
      },
    })

    expect(deriveComfyRequirements(graph)).toEqual({
      nodeClasses: ['CheckpointLoaderSimple', 'VAELoader'],
      candidateLoaderInputs: [
        { nodeId: '1', inputName: 'ckpt_name', value: 'a-model.safetensors' },
        { nodeId: '2', inputName: 'vae_name', value: 'vae.safetensors' },
        { nodeId: '9', inputName: 'ckpt_name', value: 'z-model.safetensors' },
      ],
    })
    expect(graph['9'].inputs.ckpt_name).toBe('z-model.safetensors')
  })

  it('rejects runtime values that do not match declared variable types', () => {
    const error = captureError(() =>
      renderComfyWorkflow({
        graph: { '1': { class_type: 'Node', inputs: { width: '${width}' } } },
        variables: { width: '768' },
        variableDefinitions: [{ name: 'width', type: 'number', required: true }],
        bindings: [],
        uploads: {},
      }),
    ) as ComfyError

    expect(error.code).toBe(COMFY_ERROR_CODE.WORKFLOW_BINDING_INVALID)
    expect(error.details).toEqual({ variable: 'width', reason: 'type' })
  })

  it('rejects undeclared placeholder and binding variables at render time', () => {
    const placeholderError = captureError(() =>
      renderComfyWorkflow({
        graph: { '1': { class_type: 'Node', inputs: { text: '${prompt}' } } },
        variables: { prompt: 'rain' },
        variableDefinitions: [],
        bindings: [],
        uploads: {},
      }),
    ) as ComfyError
    const bindingError = captureError(() =>
      renderComfyWorkflow({
        graph: { '1': { class_type: 'Node', inputs: { width: 512 } } },
        variables: { width: 'not-a-number' },
        variableDefinitions: [],
        bindings: [
          { nodeId: '1', inputPath: 'width', variable: 'width', valueType: 'number' },
        ],
        uploads: {},
      }),
    ) as ComfyError

    expect(placeholderError).toMatchObject({
      code: COMFY_ERROR_CODE.WORKFLOW_BINDING_INVALID,
      details: { variable: 'prompt', reason: 'undeclared' },
    })
    expect(bindingError).toMatchObject({
      code: COMFY_ERROR_CODE.WORKFLOW_BINDING_INVALID,
      details: { variable: 'width', reason: 'undeclared' },
    })
  })

  it('enforces binding valueType against the unique variable definition', () => {
    const bindingTypeError = captureError(() =>
      renderComfyWorkflow({
        graph: { '1': { class_type: 'Node', inputs: { width: 512 } } },
        variables: { width: 'not-a-number' },
        variableDefinitions: [
          { name: 'width', type: 'string', required: true },
        ],
        bindings: [
          { nodeId: '1', inputPath: 'width', variable: 'width', valueType: 'number' },
        ],
        uploads: {},
      }),
    ) as ComfyError
    const runtimeTypeError = captureError(() =>
      renderComfyWorkflow({
        graph: { '1': { class_type: 'Node', inputs: { width: 512 } } },
        variables: { width: 'not-a-number' },
        variableDefinitions: [
          { name: 'width', type: 'number', required: true },
        ],
        bindings: [
          { nodeId: '1', inputPath: 'width', variable: 'width', valueType: 'number' },
        ],
        uploads: {},
      } as unknown as Parameters<typeof renderComfyWorkflow>[0]),
    ) as ComfyError

    expect(bindingTypeError).toMatchObject({
      code: COMFY_ERROR_CODE.WORKFLOW_BINDING_INVALID,
      details: { variable: 'width', reason: 'binding_type' },
    })
    expect(runtimeTypeError).toMatchObject({
      code: COMFY_ERROR_CODE.WORKFLOW_BINDING_INVALID,
      details: { variable: 'width', reason: 'type' },
    })
  })

  it('revalidates links generated by placeholder substitution', () => {
    const error = captureError(() =>
      renderComfyWorkflow({
        graph: {
          '1': { class_type: 'Source', inputs: {} },
          sink: {
            class_type: 'Sink',
            inputs: { images: ['${linkedNode}', '${outputIndex}'] },
          },
        },
        variables: { linkedNode: 'missing', outputIndex: 0 },
        variableDefinitions: [
          { name: 'linkedNode', type: 'string', required: true },
          { name: 'outputIndex', type: 'number', required: true },
        ],
        bindings: [],
        uploads: {},
      }),
    ) as ComfyError

    expect(error.code).toBe(COMFY_ERROR_CODE.WORKFLOW_FORMAT_INVALID)
    expect(error.message).toContain('unknown node "missing"')
  })

  it('allows preserve-original policy to be declared on an explicit binding', () => {
    const contract = {
      graph: { '1': { class_type: 'Node', inputs: { height: 512 } } },
      variableDefinitions: [
        { name: 'height', type: 'number' as const, required: false },
      ],
      bindings: [
        {
          nodeId: '1', inputPath: 'height', variable: 'height',
          valueType: 'number' as const, missingValuePolicy: 'preserve_original' as const,
        },
      ],
      outputs: [
        {
          name: 'result', nodeId: '1', fieldPath: 'images',
          mediaType: 'image' as const, primary: true,
        },
      ],
    }

    expect(validateWorkflowContract(contract)).toEqual([])
    expect(renderComfyWorkflow({ ...contract, variables: {}, uploads: {} })['1'].inputs.height)
      .toBe(512)
  })

  it('supports safe numeric path segments inside node inputs', () => {
    const rendered = renderComfyWorkflow({
      graph: { '1': { class_type: 'Node', inputs: { size: [512, 512] } } },
      variables: { height: 768 },
      variableDefinitions: [{ name: 'height', type: 'number', required: true }],
      bindings: [
        { nodeId: '1', inputPath: 'size.1', variable: 'height', valueType: 'number' },
      ],
      uploads: {},
    })

    expect(rendered['1'].inputs.size).toEqual([512, 768])
  })
})

function captureError(callback: () => unknown): unknown {
  try {
    callback()
  } catch (error) {
    return error
  }

  return undefined
}
