import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  discoverPlaceholderNames,
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
      id: 'wf-1', name: 'Portrait', mediaType: 'image', status: 'draft', currentVersionId: null,
      currentVersion: null, validation: { valid: true, issues: [] }, versions: [{
        id: 'v1', version: 1, apiFormatJson: { 1: { class_type: 'X', inputs: {} } },
        variableDefinitions: [{ name: 'prompt', type: 'string', required: true }], bindings: [], outputs: [],
        contentHash: 'hash', publishedAt: null, lastSuccessfulTestAt: null, validation: { valid: true, issues: [] },
      }],
    } satisfies WorkflowView
    const draft = draftFromWorkflow(workflow)
    draft.variableDefinitions[0].name = 'changed'
    expect(workflow.versions[0].variableDefinitions[0].name).toBe('prompt')
  })

  it('mounts a separate workflow library beside the connection pool', () => {
    const source = read(`${base}/ComfyUiSettings.tsx`)
    expect(source).toContain('WorkflowLibraryPanel')
    expect(source).toContain('ConnectionPoolPanel')
    expect(source).toContain('aria-label')
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
    expect(mapping).toContain("['filename', 'image_ref', 'filename_list']")
    expect(mapping).toContain('setPrimaryOutput')
  })

  it('keeps the author form separate from saved versions and exposes draft actions', () => {
    const source = read(`${base}/WorkflowLibraryPanel.tsx`)
    expect(source).toContain('authorDraft')
    expect(source).toContain('savedVersion')
    expect(source).toContain('saveDraft')
    expect(source).toContain('publishVersion')
    expect(source).toContain('testVersion')
    expect(source).toContain('lastSuccessfulTestAt')
  })

  it('collects typed live-test values and bounded media uploads instead of fixed empty objects', () => {
    const form = read(`${base}/WorkflowTestForm.tsx`)
    const library = read(`${base}/WorkflowLibraryPanel.tsx`)
    expect(form).toContain('buildWorkflowTestPayload')
    expect(form).toContain('fileToLiveTestUpload')
    expect(form).toContain('variable.options')
    expect(form).toContain('type="file"')
    expect(form).toContain('required')
    expect(library).toContain('testPayload.variables')
    expect(library).toContain('testPayload.uploads')
    expect(library).not.toContain('variables: {}, uploads: {}')
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
      expect(messages.workflows.projectDefaultsSaveFailed).toBeTruthy()
    }
  })
})
