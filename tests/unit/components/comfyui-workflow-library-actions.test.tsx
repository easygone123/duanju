// @vitest-environment jsdom

import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import WorkflowLibraryPanel from '@/app/[locale]/profile/components/comfyui/WorkflowLibraryPanel'
import {
  workflowRequestErrorFromPayload,
  type WorkflowView,
} from '@/app/[locale]/profile/components/comfyui/workflow-ui'
import enComfyui from '../../../messages/en/comfyui.json'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const apiFetchMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api-fetch', () => ({ apiFetch: apiFetchMock }))
vi.mock('@/lib/query/hooks/useUserModels', () => ({ invalidateUserModels: vi.fn() }))
vi.mock('@/app/[locale]/profile/components/comfyui/hooks', () => ({
  useComfyConnections: () => ({ data: { connections: [] } }),
}))
vi.mock('@/app/[locale]/profile/components/comfyui/WorkflowEditor', () => ({
  default: ({ value, disabled, mappingFocusRequestId }: {
    value: { name: string }
    disabled?: boolean
    mappingFocusRequestId?: number
  }) => <>
    <output aria-label="draft-name">{value.name}</output>
    <output aria-label="editor-disabled">{String(Boolean(disabled))}</output>
    <output aria-label="mapping-focus-request">{mappingFocusRequestId ?? 0}</output>
  </>,
}))
vi.mock('@/app/[locale]/profile/components/comfyui/WorkflowTestForm', () => ({
  default: () => null,
  emptyWorkflowTestPayload: () => null,
}))
vi.mock('@/app/[locale]/profile/components/comfyui/WorkflowCompatibilityTable', () => ({
  default: () => null,
}))
vi.mock('@/app/[locale]/profile/components/comfyui/WorkflowActivationPanel', () => ({
  default: ({ workflowId, onActivated, onEditMappings }: {
    workflowId: string
    onActivated?(): void | Promise<void>
    onEditMappings?(): void
  }) => <>
    <output aria-label="activation-workflow">{workflowId}</output>
    <button type="button" onClick={() => void onActivated?.()}>COMPLETE ACTIVATION</button>
    <button type="button" onClick={onEditMappings}>EDIT FAILED MAPPINGS</button>
  </>,
}))

const savedVersion = {
  id: 'version-1', version: 1, purpose: 'generation' as const,
  apiFormatJson: { '1': { class_type: 'SaveImage', inputs: {} } },
  variableDefinitions: [], bindings: [],
  outputs: [{ name: 'image', nodeId: '1', fieldPath: 'images', mediaType: 'image' as const, primary: true }],
  contentHash: 'hash', publishedAt: null, lastSuccessfulTestAt: null,
  validation: { valid: true, issues: [] },
}

const workflow: WorkflowView = {
  id: 'workflow/a b', name: 'Portrait', mediaType: 'image', purpose: 'generation', status: 'draft',
  currentVersionId: null, currentVersion: null, versions: [savedVersion],
  validation: { valid: true, issues: [] },
}
const workflowB: WorkflowView = {
  ...workflow,
  id: 'workflow-b',
  name: 'Landscape',
}

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

function renderLibrary(props: { initialWorkflowId?: string | null; activationWorkflowId?: string | null; onCreateNew?: () => void } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="en" messages={{ comfyui: enComfyui }} timeZone="UTC">
        <WorkflowLibraryPanel initialWorkflowId={props.initialWorkflowId} activationWorkflowId={props.activationWorkflowId} onCreateNew={props.onCreateNew ?? vi.fn()} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  )
}

async function selectSavedWorkflow(view: ReturnType<typeof renderLibrary>) {
  await waitFor(() => expect(view.getByRole('button', { name: /Portrait/ })).toBeTruthy())
  fireEvent.click(view.getByRole('button', { name: /Portrait/ }))
  await waitFor(() => expect(view.getByRole('button', { name: 'Delete workflow' })).toBeTruthy())
}

describe('ComfyUI workflow library removal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/comfyui/workflows') return response({ workflows: [workflow] })
      if (url.includes('/compatibility')) return response({ compatibility: [], nextCursor: null })
      throw new Error(`Unexpected request: ${url}`)
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('selects the first saved workflow when there is no valid preferred or current selection', async () => {
    const view = renderLibrary()

    await waitFor(() => expect(view.getByLabelText('draft-name').textContent).toBe('Portrait'))
    expect(view.getByRole('button', { name: /Portrait/ }).getAttribute('aria-current')).toBe('page')
    expect(view.getByRole('button', { name: 'Delete workflow' })).toBeTruthy()
  })

  it('opens the dedicated creation flow from New workflow', async () => {
    const onCreateNew = vi.fn()
    const view = renderLibrary({ onCreateNew })

    await waitFor(() => expect(view.getByRole('button', { name: /Portrait/ })).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'New workflow' }))

    expect(onCreateNew).toHaveBeenCalledTimes(1)
    expect(apiFetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })

  it('selects the newly-created workflow when its initial id becomes available', async () => {
    const view = renderLibrary({ initialWorkflowId: workflow.id })

    await waitFor(() => expect(view.getByLabelText('draft-name').textContent).toBe('Portrait'))
    expect(view.getByRole('button', { name: /Portrait/ }).getAttribute('aria-current')).toBe('page')
    expect(view.getByRole('button', { name: 'Delete workflow' })).toBeTruthy()
  })

  it('renders activation only after the created workflow version has loaded', async () => {
    const view = renderLibrary({ initialWorkflowId: workflow.id, activationWorkflowId: workflow.id })

    await waitFor(() => expect(view.getByLabelText('activation-workflow').textContent).toBe(workflow.id))
    expect(view.queryByRole('button', { name: 'Publish' })).toBeNull()
    expect(view.queryByRole('button', { name: 'Delete workflow' })).toBeNull()
  })

  it('returns from activation to an unlocked mapping repair draft', async () => {
    const view = renderLibrary()
    await selectSavedWorkflow(view)
    fireEvent.click(view.getByRole('button', { name: 'Test and enable' }))

    expect(view.getByLabelText('editor-disabled').textContent).toBe('true')
    fireEvent.click(view.getByRole('button', { name: 'EDIT FAILED MAPPINGS' }))

    expect(view.queryByLabelText('activation-workflow')).toBeNull()
    expect(view.getByLabelText('editor-disabled').textContent).toBe('false')
    expect(view.getByLabelText('draft-name').textContent).toBe('Portrait')
    expect(Number(view.getByLabelText('mapping-focus-request').textContent)).toBeGreaterThan(0)
    expect(view.getByText(/Repair the input or output mappings/)).toBeTruthy()
  })

  it('clears mapping repair guidance when another workflow is selected', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/comfyui/workflows') return response({ workflows: [workflow, workflowB] })
      if (url.includes('/compatibility')) return response({ compatibility: [], nextCursor: null })
      throw new Error(`Unexpected request: ${url}`)
    })
    const view = renderLibrary()
    await selectSavedWorkflow(view)
    fireEvent.click(view.getByRole('button', { name: 'Test and enable' }))
    fireEvent.click(view.getByRole('button', { name: 'EDIT FAILED MAPPINGS' }))
    expect(view.getByText(/Repair the input or output mappings/)).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: /Landscape/ }))

    expect(view.queryByText(/Repair the input or output mappings/)).toBeNull()
    expect(view.getByLabelText('mapping-focus-request').textContent).toBe('0')
  })

  it('keeps mapping repair guidance after save failure and clears it after save succeeds', async () => {
    const nextVersion = { ...savedVersion, id: 'version-2', version: 2, contentHash: 'hash-2' }
    const nextWorkflow = { ...workflow, versions: [nextVersion, savedVersion] }
    let versionCalls = 0
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/comfyui/workflows') {
        return response({ workflows: versionCalls > 1 ? [nextWorkflow] : [workflow] })
      }
      if (url.includes('/compatibility')) return response({ compatibility: [], nextCursor: null })
      if (url.endsWith('/versions') && init?.method === 'POST') {
        versionCalls += 1
        return versionCalls === 1
          ? response({ error: { code: 'UNKNOWN' } }, 500)
          : response({ version: nextVersion }, 201)
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const view = renderLibrary()
    await selectSavedWorkflow(view)
    fireEvent.click(view.getByRole('button', { name: 'Test and enable' }))
    fireEvent.click(view.getByRole('button', { name: 'EDIT FAILED MAPPINGS' }))

    fireEvent.click(view.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(view.getByRole('alert')).toBeTruthy())
    expect(view.getByText(/Repair the input or output mappings/)).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(versionCalls).toBe(2))
    await waitFor(() => expect(view.queryByText(/Repair the input or output mappings/)).toBeNull())
    expect(view.getByLabelText('Saved version').textContent).toContain('v2')
  })

  it('does not let a delayed activation reload steal a newer workflow selection', async () => {
    const reload = deferred<Response>()
    let listCalls = 0
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/comfyui/workflows') {
        listCalls += 1
        return listCalls === 1 ? response({ workflows: [workflow, workflowB] }) : reload.promise
      }
      if (url.includes('/compatibility')) return response({ compatibility: [], nextCursor: null })
      throw new Error(`Unexpected request: ${url}`)
    })
    const view = renderLibrary({ initialWorkflowId: workflow.id, activationWorkflowId: workflow.id })
    await waitFor(() => expect(view.getByLabelText('activation-workflow').textContent).toBe(workflow.id))

    fireEvent.click(view.getByRole('button', { name: 'COMPLETE ACTIVATION' }))
    await waitFor(() => expect(listCalls).toBe(2))
    fireEvent.click(view.getByRole('button', { name: /Landscape/ }))
    expect(view.getByLabelText('draft-name').textContent).toBe('Landscape')
    reload.resolve(response({ workflows: [workflow] }))

    await waitFor(() => expect(view.getByLabelText('draft-name').textContent).toBe('Landscape'))
    expect(view.getByRole('button', { name: /Landscape/ }).getAttribute('aria-current')).toBe('page')
  })

  it('does not send DELETE when removal confirmation is canceled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const view = renderLibrary()
    await selectSavedWorkflow(view)

    fireEvent.click(view.getByRole('button', { name: 'Delete workflow' }))

    expect(window.confirm).toHaveBeenCalledWith('Delete “Portrait”? This removes it from the workflow library.')
    expect(apiFetchMock).not.toHaveBeenCalledWith(expect.stringContaining('workflow%2Fa%20b'), expect.objectContaining({ method: 'DELETE' }))
  })

  it('archives the encoded workflow, resets selection, and reloads the library', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    let listCalls = 0
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/comfyui/workflows') {
        listCalls += 1
        return response({ workflows: listCalls === 1 ? [workflow] : [] })
      }
      if (url.includes('/compatibility')) return response({ compatibility: [], nextCursor: null })
      if (url === '/api/comfyui/workflows/workflow%2Fa%20b' && init?.method === 'DELETE') {
        return response({ success: true })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const view = renderLibrary()
    await selectSavedWorkflow(view)

    fireEvent.click(view.getByRole('button', { name: 'Delete workflow' }))

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/comfyui/workflows/workflow%2Fa%20b',
      { method: 'DELETE' },
    ))
    await waitFor(() => expect(listCalls).toBe(2))
    expect(view.queryByRole('button', { name: 'Delete workflow' })).toBeNull()
    expect(view.queryByLabelText('draft-name')).toBeNull()
    expect(document.activeElement).toBe(view.getByRole('button', { name: 'New workflow' }))
    expect(view.getByText('Workflow deleted.')).toBeTruthy()
  })

  it('sends only one DELETE when removal is clicked twice before the request settles', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const deletion = deferred<Response>()
    let listCalls = 0
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/comfyui/workflows') {
        listCalls += 1
        return response({ workflows: listCalls === 1 ? [workflow] : [] })
      }
      if (url.includes('/compatibility')) return response({ compatibility: [], nextCursor: null })
      if (url === '/api/comfyui/workflows/workflow%2Fa%20b' && init?.method === 'DELETE') {
        return deletion.promise
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const view = renderLibrary()
    await selectSavedWorkflow(view)
    const deleteButton = view.getByRole('button', { name: 'Delete workflow' })

    fireEvent.click(deleteButton)
    fireEvent.click(deleteButton)

    expect(apiFetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1)
    expect(window.confirm).toHaveBeenCalledTimes(1)
    deletion.resolve(response({ success: true }))
    await waitFor(() => expect(view.queryByRole('button', { name: 'Delete workflow' })).toBeNull())
  })

  it('does not reset a replacement selection when an earlier deletion finishes', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const deletion = deferred<Response>()
    let listCalls = 0
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/comfyui/workflows') {
        listCalls += 1
        return response({ workflows: listCalls === 1 ? [workflow, workflowB] : [workflowB] })
      }
      if (url.includes('/compatibility')) return response({ compatibility: [], nextCursor: null })
      if (url === '/api/comfyui/workflows/workflow%2Fa%20b' && init?.method === 'DELETE') {
        return deletion.promise
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const view = renderLibrary()
    await selectSavedWorkflow(view)

    fireEvent.click(view.getByRole('button', { name: 'Delete workflow' }))
    fireEvent.click(view.getByRole('button', { name: /Landscape/ }))
    await waitFor(() => expect(view.getByLabelText('draft-name').textContent).toBe('Landscape'))
    deletion.resolve(response({ success: true }))

    await waitFor(() => expect(listCalls).toBe(2))
    expect(view.getByLabelText('draft-name').textContent).toBe('Landscape')
    expect(view.getByRole('button', { name: 'Delete workflow' })).toBeTruthy()
    expect(view.queryByRole('button', { name: /Portrait/ })).toBeNull()
  })

  it('removes the archived workflow locally even when the follow-up reload fails', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    let listCalls = 0
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/comfyui/workflows') {
        listCalls += 1
        if (listCalls === 1) return response({ workflows: [workflow] })
        return response({ error: { code: 'EXTERNAL_ERROR' } }, 503)
      }
      if (url.includes('/compatibility')) return response({ compatibility: [], nextCursor: null })
      if (url === '/api/comfyui/workflows/workflow%2Fa%20b' && init?.method === 'DELETE') {
        return response({ success: true })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const view = renderLibrary()
    await selectSavedWorkflow(view)

    fireEvent.click(view.getByRole('button', { name: 'Delete workflow' }))

    await waitFor(() => expect(listCalls).toBe(2))
    expect(view.queryByRole('button', { name: /Portrait/ })).toBeNull()
    expect(view.queryByRole('button', { name: 'Delete workflow' })).toBeNull()
    expect(view.getByRole('alert').textContent).toBe('The workflow request failed.')
  })

  it('shows safe project-default guidance when archival returns 409', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/comfyui/workflows') return response({ workflows: [workflow] })
      if (url.includes('/compatibility')) return response({ compatibility: [], nextCursor: null })
      if (url === '/api/comfyui/workflows/workflow%2Fa%20b' && init?.method === 'DELETE') {
        return response({
          error: {
            code: 'CONFLICT',
            message: '<script>private server detail</script>',
            details: { reason: 'COMFY_WORKFLOW_PROJECT_DEFAULT_CONFLICT' },
          },
        }, 409)
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const view = renderLibrary()
    await selectSavedWorkflow(view)

    fireEvent.click(view.getByRole('button', { name: 'Delete workflow' }))

    await waitFor(() => expect(view.getByRole('alert').textContent).toBe(
      'This workflow is a project default. Clear that default before deleting it.',
    ))
    expect(view.getByRole('alert').textContent).not.toContain('private server detail')
  })

  it('uses generic conflict guidance when a 409 has no project-default reason', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/comfyui/workflows') return response({ workflows: [workflow] })
      if (url.includes('/compatibility')) return response({ compatibility: [], nextCursor: null })
      if (url === '/api/comfyui/workflows/workflow%2Fa%20b' && init?.method === 'DELETE') {
        return response({ error: { code: 'CONFLICT' } }, 409)
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const view = renderLibrary()
    await selectSavedWorkflow(view)

    fireEvent.click(view.getByRole('button', { name: 'Delete workflow' }))

    await waitFor(() => expect(view.getByRole('alert').textContent).toBe(
      'The workflow changed or is currently in use. Refresh and try again.',
    ))
  })

  it('preserves the HTTP status while safely parsing a recognized conflict reason', () => {
    const error = workflowRequestErrorFromPayload({
      error: {
        code: 'CONFLICT',
        details: { reason: 'COMFY_WORKFLOW_PROJECT_DEFAULT_CONFLICT' },
      },
    }, 409)

    expect(error).toMatchObject({
      code: 'CONFLICT',
      status: 409,
      reason: 'COMFY_WORKFLOW_PROJECT_DEFAULT_CONFLICT',
    })
  })
})
