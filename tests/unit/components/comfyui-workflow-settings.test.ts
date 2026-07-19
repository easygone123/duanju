import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  discoverPlaceholderNames,
  confirmWorkflowAnalysis,
  createWorkflowCompatibilityCoordinator,
  draftFromWorkflow,
  mapWorkflowCompatibility,
  removeWorkflowOutput,
  parseWorkflowImportText,
  safeWorkflowErrorKey,
  setPrimaryOutput,
  WorkflowRequestError,
  type WorkflowView,
} from '@/app/[locale]/profile/components/comfyui/workflow-ui'
import {
  buildWorkflowTestPayload,
  createWorkflowUploadSelectionController,
  type LiveTestUploadPayload,
} from '@/app/[locale]/profile/components/comfyui/WorkflowTestForm'

const read = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : ''
const base = 'src/app/[locale]/profile/components/comfyui'

describe('ComfyUI workflow settings UI contract', () => {
  it('parses API Format objects and discovers unique placeholders', () => {
    expect(parseWorkflowImportText('{"1":{"class_type":"X","inputs":{"text":"${prompt} ${prompt}","seed":"${seed}"}}}'))
      .toHaveProperty('1.class_type', 'X')
    expect(discoverPlaceholderNames('{"text":"${seed} ${prompt} ${seed}"}')).toEqual(['prompt', 'seed'])
    expect(() => parseWorkflowImportText('[]')).toThrow('workflowInvalidJson')
    expect(() => parseWorkflowImportText('{oops')).toThrow('workflowInvalidJson')
  })

  it('changes exactly one primary output without mutating saved data', () => {
    const outputs = [
      { name: 'a', nodeId: '1', fieldPath: 'images', mediaType: 'image' as const, primary: true },
      { name: 'b', nodeId: '2', fieldPath: 'images', mediaType: 'image' as const, primary: false },
    ]
    const updated = setPrimaryOutput(outputs, 1)
    expect(updated.map((item) => item.primary)).toEqual([false, true])
    expect(outputs.map((item) => item.primary)).toEqual([true, false])
  })

  it('preserves the current primary unless that output is removed and keeps the last output', () => {
    const outputs = [
      { name: 'a', nodeId: '1', fieldPath: 'images', mediaType: 'image' as const, primary: true },
      { name: 'b', nodeId: '2', fieldPath: 'images', mediaType: 'image' as const, primary: false },
    ]
    expect(removeWorkflowOutput(outputs, 1)).toEqual([outputs[0]])
    expect(removeWorkflowOutput(outputs, 0)).toEqual([{ ...outputs[1], primary: true }])
    expect(removeWorkflowOutput([outputs[0]], 0)).toEqual([outputs[0]])
  })

  it('clears stale uploads immediately and lets only the latest async selection commit', async () => {
    const pending = new Map<string, (value: LiveTestUploadPayload[]) => void>()
    const commits: LiveTestUploadPayload[][] = []
    const controller = createWorkflowUploadSelectionController((files) => new Promise((resolve) => {
      pending.set(files[0].name, resolve)
    }))
    const fileA = new File(['a'], 'a.png', { type: 'image/png' })
    const fileB = new File(['b'], 'b.png', { type: 'image/png' })
    const first = controller.select('image', [fileA], 'image_ref', (value) => commits.push(value), vi.fn())
    const second = controller.select('image', [fileB], 'image_ref', (value) => commits.push(value), vi.fn())
    expect(commits).toEqual([[], []])
    pending.get('a.png')!([{ filename: 'a.png', contentType: 'image/png', base64: 'YQ==' }])
    await first
    pending.get('b.png')!([{ filename: 'b.png', contentType: 'image/png', base64: 'Yg==' }])
    await second
    expect(commits).toEqual([[], [], [{ filename: 'b.png', contentType: 'image/png', base64: 'Yg==' }]])
  })

  it('does not commit a completed upload after unmount', async () => {
    let finish!: (value: LiveTestUploadPayload[]) => void
    const commit = vi.fn()
    const controller = createWorkflowUploadSelectionController(() => new Promise((resolve) => { finish = resolve }))
    const selecting = controller.select('image', [new File(['a'], 'a.png', { type: 'image/png' })], 'image_ref', commit, vi.fn())
    controller.dispose()
    finish([{ filename: 'a.png', contentType: 'image/png', base64: 'YQ==' }])
    await selecting
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenLastCalledWith([])
  })

  it('copies a saved version into an independent author draft', () => {
    const workflow = {
      id: 'wf-1', name: 'Portrait', mediaType: 'image', purpose: 'generation', status: 'draft', currentVersionId: null,
      currentVersion: null, validation: { valid: true, issues: [] }, versions: [{
        id: 'v1', version: 1, purpose: 'generation', apiFormatJson: { 1: { class_type: 'X', inputs: {} } },
        variableDefinitions: [{ name: 'prompt', type: 'string', required: true }], bindings: [], outputs: [],
        contentHash: 'hash', publishedAt: null, lastSuccessfulTestAt: null, validation: { valid: true, issues: [] },
      }],
    } satisfies WorkflowView
    const draft = draftFromWorkflow(workflow)
    draft.variableDefinitions[0].name = 'changed'
    expect(workflow.versions[0].variableDefinitions[0].name).toBe('prompt')
    expect(draft.purpose).toBe('generation')
  })

  it('mounts a separate workflow library beside the connection pool', () => {
    const source = read(`${base}/ComfyUiSettings.tsx`)
    expect(source).toContain('WorkflowLibraryPanel')
    expect(source).toContain('ConnectionPoolPanel')
    expect(source).toContain('aria-label')
  })

  it('keeps the workflow authoring pane within its fixed profile surface', () => {
    const settings = read(`${base}/ComfyUiSettings.tsx`)
    const library = read(`${base}/WorkflowLibraryPanel.tsx`)
    const editor = read(`${base}/WorkflowEditor.tsx`)
    const mapping = read(`${base}/WorkflowMappingTable.tsx`)

    expect(settings).toContain('h-full min-h-0 min-w-0')
    expect(settings).toContain('min-w-0 min-h-[32rem]')
    expect(library).toContain('h-full min-h-0 min-w-0')
    expect(editor).toContain('className="min-w-0 space-y-5"')
    expect(editor).not.toContain('xl:grid-cols-5')
    expect(mapping).not.toContain('2xl:grid-cols-5')
  })

  it('supports bounded file and paste import without a graph canvas', () => {
    const source = read(`${base}/WorkflowEditor.tsx`)
    expect(source).toContain('MAX_WORKFLOW_JSON_BYTES')
    expect(source).toContain('readWorkflowImportFile')
    expect(source).toContain('parseWorkflowImportText')
    expect(source).toContain('type="file"')
    expect(source).toContain('api-format-json')
    expect(source).not.toMatch(/graph.?canvas/i)
  })

  it('authors typed variables, explicit node paths, enumerated transforms and one primary output', () => {
    const editor = read(`${base}/WorkflowEditor.tsx`)
    const mapping = read(`${base}/WorkflowMappingTable.tsx`)
    expect(editor).toContain('variableDefinitions')
    expect(editor).toContain('required')
    expect(editor).toContain('defaultValue')
    expect(mapping).toContain('nodeId')
    expect(mapping).toContain('inputPath')
    expect(mapping).toContain("['filename', 'image_ref', 'filename_list', 'bernini_image_slots']")
    expect(mapping).toContain('setPrimaryOutput')
    expect(editor).toContain("value.purpose === 'upscale'")
    expect(editor).toContain('purposeImmutable')
  })

  it('converts confirmed automatic proposals into the existing workflow overlay', () => {
    const result = confirmWorkflowAnalysis({
      graph: {
        '1': { class_type: 'CLIPTextEncode', inputs: { text: 'portrait' } },
        '2': { class_type: 'LoadImage', inputs: { image: 'reference.png' } },
        '9': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
      },
      mediaType: 'image',
      purpose: 'generation',
      proposals: [
        { id: '1:text:prompt', canonicalName: 'prompt', nodeId: '1', inputPath: 'text', valueType: 'string', confidence: 'high', reasonCode: 'prompt', required: true },
        { id: '2:image:reference', canonicalName: 'referenceImages', nodeId: '2', inputPath: 'image', valueType: 'image_ref', transform: 'filename_at', confidence: 'ambiguous', reasonCode: 'reference', required: false, referenceIndex: 0 },
      ],
      outputs: [{ name: 'output_9', nodeId: '9', fieldPath: 'images', mediaType: 'image', primary: true }],
      issues: [],
      referenceCapacity: 1,
    }, {
      roles: { '2:image:reference': 'referenceImages' },
      primaryOutputNodeId: '9',
    })

    expect(result).toMatchObject({
      variableDefinitions: [
        { name: 'prompt', type: 'string', required: true },
        { name: 'referenceImages', type: 'image_ref_list', required: false, maxItems: 1 },
      ],
      bindings: [
        { variable: 'prompt', nodeId: '1', inputPath: 'text' },
        { variable: 'referenceImages', nodeId: '2', inputPath: 'image', transform: 'filename_at', valueIndex: 0 },
      ],
      outputs: [{ nodeId: '9', primary: true }],
    })
  })

  it('keeps Bernini dynamic slots optional with an empty-list default', () => {
    const result = confirmWorkflowAnalysis({
      graph: {
        '30': { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } },
        '38': {
          class_type: 'BerniniStudio',
          inputs: { prompt: 'portrait', image0: ['30', 0] },
        },
        '51': { class_type: 'PreviewImage', inputs: { images: ['38', 0] } },
      },
      mediaType: 'image',
      purpose: 'generation',
      proposals: [{
        id: '38:image0:referenceImages', canonicalName: 'referenceImages',
        nodeId: '38', inputPath: 'image0', valueType: 'image_ref_list',
        transform: 'bernini_image_slots', confidence: 'high',
        reasonCode: 'COMFY_MAPPING_BERNINI_REFERENCE_SLOTS', required: false,
        referenceIndex: 0,
      }],
      outputs: [{
        name: 'output_51', nodeId: '51', fieldPath: 'images',
        mediaType: 'image', primary: true,
      }],
      issues: [],
      referenceCapacity: 8,
    }, { roles: {} })

    expect(result.variableDefinitions).toEqual([{
      name: 'referenceImages', type: 'image_ref_list', required: false,
      maxItems: 8, defaultValue: [],
    }])
    expect(result.bindings).toEqual([{
      nodeId: '38', inputPath: 'image0', variable: 'referenceImages',
      valueType: 'image_ref_list', transform: 'bernini_image_slots',
    }])
  })

  it('expands reference capacity when ambiguous image inputs are confirmed as references', () => {
    const proposals = ['2', '3'].map((nodeId) => ({
      id: `${nodeId}:image:sourceImage`, canonicalName: 'sourceImage' as const,
      nodeId, inputPath: 'image', valueType: 'image_ref' as const,
      transform: 'filename' as const, confidence: 'ambiguous' as const,
      reasonCode: 'ambiguous', required: false,
    }))
    const result = confirmWorkflowAnalysis({
      graph: {
        '2': { class_type: 'LoadImage', inputs: { image: 'one.png' } },
        '3': { class_type: 'LoadImage', inputs: { image: 'two.png' } },
        '9': { class_type: 'SaveImage', inputs: { images: ['2', 0] } },
      },
      mediaType: 'image', purpose: 'generation', proposals,
      outputs: [{ name: 'out', nodeId: '9', fieldPath: 'images', mediaType: 'image', primary: true }],
      issues: [], referenceCapacity: 0,
    }, {
      roles: {
        '2:image:sourceImage': 'referenceImages',
        '3:image:sourceImage': 'referenceImages',
      },
    })

    expect(result.variableDefinitions).toContainEqual(expect.objectContaining({
      name: 'referenceImages', maxItems: 2,
    }))
    expect(result.bindings.map((binding) => binding.valueIndex)).toEqual([0, 1])
  })

  it('preserves unresolved optional ambiguity but blocks required ambiguity', () => {
    const base = {
      graph: { '9': { class_type: 'SaveImage', inputs: {} } },
      mediaType: 'image' as const, purpose: 'generation' as const,
      outputs: [{ name: 'output', nodeId: '9', fieldPath: 'images', mediaType: 'image' as const, primary: true }],
      issues: [], referenceCapacity: 1,
    }
    const optional = confirmWorkflowAnalysis({ ...base, proposals: [{
      id: 'optional', canonicalName: 'referenceImages' as const, nodeId: '2', inputPath: 'image', valueType: 'image_ref' as const,
      confidence: 'ambiguous' as const, reasonCode: 'COMFY_MAPPING_IMAGE_ROLE_AMBIGUOUS', required: false,
    }] }, { roles: {} })
    expect(optional.variableDefinitions).toEqual([])
    expect(optional.bindings).toEqual([])

    expect(() => confirmWorkflowAnalysis({ ...base, proposals: [{
      id: 'required', canonicalName: 'sourceImage' as const, nodeId: '2', inputPath: 'image', valueType: 'image_ref' as const,
      confidence: 'ambiguous' as const, reasonCode: 'COMFY_MAPPING_IMAGE_ROLE_AMBIGUOUS', required: true,
    }] }, { roles: {} })).toThrow('workflowMappingConfirmationRequired')

    expect(() => confirmWorkflowAnalysis({ ...base, proposals: [{
      id: 'required', canonicalName: 'sourceImage' as const, nodeId: '2', inputPath: 'image', valueType: 'image_ref' as const,
      confidence: 'ambiguous' as const, reasonCode: 'COMFY_MAPPING_IMAGE_ROLE_AMBIGUOUS', required: true,
    }] }, { roles: { required: 'preserve_original' } })).toThrow('workflowMappingConfirmationRequired')
  })

  it('keeps creation and saved editing in dedicated guided windows', () => {
    const editor = read(`${base}/WorkflowEditor.tsx`)
    const settings = read(`${base}/ComfyUiSettings.tsx`)
    expect(existsSync(`${base}/WorkflowUploadStep.tsx`)).toBe(false)
    expect(settings).toContain('WorkflowCreationWizard')
    expect(settings).toContain('WorkflowEditWizard')
    expect(settings).toContain('createWorkflowDraft')
    expect(editor).not.toContain('WorkflowUploadStep')
    expect(editor).not.toContain('WorkflowEditorStage')
    expect(editor).toContain('api-format-json')
    expect(editor).toContain('WorkflowMappingTable')
  })

  it('keeps the workflow library saved-only and delegates new creation to its parent shell', () => {
    const library = read(`${base}/WorkflowLibraryPanel.tsx`)
    expect(library).toContain('initialWorkflowId')
    expect(library).toContain('onCreateNew')
    expect(library).not.toContain("selectedId === 'new'")
    expect(library).not.toContain("method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...contract")
    expect(library).not.toContain('emptyWorkflowDraft')
  })

  it('keeps the workflow overview compact and delegates mapping changes to edit mode', () => {
    const library = read(`${base}/WorkflowLibraryPanel.tsx`)
    const editor = read(`${base}/WorkflowEditWizard.tsx`)
    expect(library).toContain('onEditWorkflow')
    expect(library).not.toContain('<WorkflowEditor')
    expect(library).not.toContain('saveDraft')
    expect(editor).toContain('WorkflowGuidedMappingEditor')
    expect(editor).toContain('onPrepareTest')
  })

  it('collects typed live-test values and bounded media uploads instead of fixed empty objects', () => {
    const form = read(`${base}/WorkflowTestForm.tsx`)
    const activation = read(`${base}/WorkflowActivationPanel.tsx`)
    expect(form).toContain('buildWorkflowTestPayload')
    expect(form).toContain('fileToLiveTestUpload')
    expect(form).toContain('variable.options')
    expect(form).toContain('type="file"')
    expect(form).toContain('required')
    expect(activation).toContain('testPayload.variables')
    expect(activation).toContain('testPayload.uploads')
    expect(activation).not.toContain('variables: {}, uploads: {}')
  })

  it('builds typed test variables and media payloads while failing closed on missing required values', () => {
    const upload = { filename: 'input.png', contentType: 'image/png', base64: 'YQ==' }
    const definitions = [
      { name: 'prompt', type: 'string' as const, required: true },
      { name: 'steps', type: 'number' as const, required: true, options: [20, 30] },
      { name: 'enabled', type: 'boolean' as const, required: true },
      { name: 'image', type: 'image_ref' as const, required: true },
    ]
    expect(buildWorkflowTestPayload(definitions, { prompt: '', steps: '20', enabled: 'false' }, {}))
      .toMatchObject({ payload: null, missing: expect.arrayContaining(['prompt', 'image']) })
    expect(buildWorkflowTestPayload(definitions, { prompt: 'portrait', steps: '20', enabled: 'false' }, { image: [upload] })).toEqual({
      missing: [], payload: {
        variables: { prompt: 'portrait', steps: 20, enabled: false, image: { storageKey: 'input.png', filename: 'input.png', mimeType: 'image/png' } },
        uploads: { image: upload },
      },
    })
  })

  it('builds the prepared one-second video test duration', () => {
    expect(buildWorkflowTestPayload(
      [{ name: 'duration', type: 'number', required: true, defaultValue: 1 }],
      { duration: '1' },
      {},
      { positiveNumberVariables: new Set(['duration']) },
    )).toEqual({
      missing: [],
      payload: { variables: { duration: 1 }, uploads: {} },
    })
  })

  it.each(['0', '-1', 'NaN'])('rejects invalid video test duration %s', (raw) => {
    expect(buildWorkflowTestPayload(
      [{ name: 'duration', type: 'number', required: true, defaultValue: 1 }],
      { duration: raw },
      {},
      { positiveNumberVariables: new Set(['duration']) },
    )).toMatchObject({ payload: null, missing: ['duration'] })
  })

  it('renders path-aware static validation and owned-instance compatibility without secrets', () => {
    const source = read(`${base}/WorkflowCompatibilityTable.tsx`)
    expect(source).toContain('missingNodes')
    expect(source).toContain('missingModels')
    expect(source).toContain('issue.path')
    expect(source).not.toMatch(/authorization|bearer|password|rawPrompt/i)
  })

  it('maps a disabled instance to an explicit unknown compatibility row without fake gaps', () => {
    expect(mapWorkflowCompatibility({
      connectionId: 'disabled-1', connectionName: 'Paused GPU', status: 'disabled', compatible: false,
    })).toEqual({
      connectionId: 'disabled-1', connectionName: 'Paused GPU', state: 'disabled',
      missingNodes: [], missingModels: [],
    })
  })

  it('drops and aborts a stale load-more response after workflow or version selection changes', async () => {
    const coordinator = createWorkflowCompatibilityCoordinator()
    coordinator.select('workflow-a', 'version-1')
    const initialA = coordinator.beginInitial()
    expect(initialA).not.toBeNull()
    expect(coordinator.accept(initialA!, 'cursor-a')).toBe(true)
    const loadMoreA = coordinator.beginLoadMore('cursor-a')
    expect(loadMoreA).not.toBeNull()
    expect(coordinator.beginLoadMore('cursor-a')).toBeNull()

    let resolveA!: (rows: string[]) => void
    const delayedA = new Promise<string[]>((resolve) => { resolveA = resolve })
    let rows: string[] = []
    const appendA = delayedA.then((next) => {
      if (coordinator.accept(loadMoreA!, null)) rows = [...rows, ...next]
    })

    coordinator.select('workflow-b', 'version-2')
    expect(loadMoreA!.controller.signal.aborted).toBe(true)
    const initialB = coordinator.beginInitial()!
    if (coordinator.accept(initialB, null)) rows = ['b']
    resolveA(['a-stale'])
    await appendA
    expect(rows).toEqual(['b'])

    const versionB2 = coordinator.select('workflow-b', 'version-3')
    expect(versionB2.generation).toBeGreaterThan(initialB.generation)
    expect(coordinator.accept(initialB, null)).toBe(false)
  })

  it('maps only trusted API codes to localized errors and never renders raw server text', () => {
    expect(safeWorkflowErrorKey(new WorkflowRequestError('INVALID_PARAMS'))).toBe('workflowRequestInvalid')
    expect(safeWorkflowErrorKey(new WorkflowRequestError('GENERATION_TIMEOUT'))).toBe('workflowTimedOut')
    expect(safeWorkflowErrorKey(new Error('<script>server secret</script>'))).toBe('requestFailed')
  })

  it('localizes the responsive workflow controls in both languages', () => {
    const en = JSON.parse(readFileSync('messages/en/comfyui.json', 'utf8'))
    const zh = JSON.parse(readFileSync('messages/zh/comfyui.json', 'utf8'))
    for (const messages of [en, zh]) {
      expect(messages.workflows.importFile).toBeTruthy()
      expect(messages.workflows.importPaste).toBeTruthy()
      expect(messages.workflows.publish).toBeTruthy()
      expect(messages.workflows.test).toBeTruthy()
      expect(messages.workflows.primaryOutput).toBeTruthy()
      expect(messages.workflows.compatibility).toBeTruthy()
      expect(messages.workflows.compatibilityStates.disabled).toBeTruthy()
      expect(messages.workflows.workflowRequestInvalid).toBeTruthy()
      expect(messages.workflows.deleteWorkflow).toBeTruthy()
      expect(messages.workflows.deleteWorkflowConfirm).toBeTruthy()
      expect(messages.workflows.workflowProjectDefaultConflict).toBeTruthy()
      expect(messages.workflows.projectDefaultsSaveFailed).toBeTruthy()
      expect(messages.workflows.purposes.upscale).toBeTruthy()
      expect(messages.workflows.upscaleContractHint).toBeTruthy()
    }
  })
})
