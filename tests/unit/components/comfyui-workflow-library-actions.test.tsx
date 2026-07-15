// @vitest-environment jsdom

import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import WorkflowLibraryPanel from '@/app/[locale]/profile/components/comfyui/WorkflowLibraryPanel'
import type { WorkflowView } from '@/app/[locale]/profile/components/comfyui/workflow-ui'
import enComfyui from '../../../messages/en/comfyui.json'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const apiFetchMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api-fetch', () => ({ apiFetch: apiFetchMock }))
vi.mock('@/lib/query/hooks/useUserModels', () => ({ invalidateUserModels: vi.fn() }))
vi.mock('@/app/[locale]/profile/components/comfyui/hooks', () => ({
  useComfyConnections: () => ({ data: { connections: [] } }),
}))
vi.mock('@/app/[locale]/profile/components/comfyui/WorkflowEditor', () => ({
  default: ({ value }: { value: { name: string } }) => <output aria-label="draft-name">{value.name}</output>,
}))
vi.mock('@/app/[locale]/profile/components/comfyui/WorkflowTestForm', () => ({
  default: () => null,
  emptyWorkflowTestPayload: () => null,
}))
vi.mock('@/app/[locale]/profile/components/comfyui/WorkflowCompatibilityTable', () => ({
  default: () => null,
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

function response(payload: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload } as Response
}

function renderLibrary() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="en" messages={{ comfyui: enComfyui }} timeZone="UTC">
        <WorkflowLibraryPanel />
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

  it('does not offer workflow removal while authoring a new workflow', async () => {
    const view = renderLibrary()

    await waitFor(() => expect(view.getByRole('button', { name: /Portrait/ })).toBeTruthy())
    expect(view.queryByRole('button', { name: 'Delete workflow' })).toBeNull()
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
    expect(view.getByLabelText('draft-name').textContent).toBe('')
  })

  it('shows safe project-default guidance when archival returns 409', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/comfyui/workflows') return response({ workflows: [workflow] })
      if (url.includes('/compatibility')) return response({ compatibility: [], nextCursor: null })
      if (url === '/api/comfyui/workflows/workflow%2Fa%20b' && init?.method === 'DELETE') {
        return response({
          error: { code: 'CONFLICT', message: '<script>private server detail</script>' },
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
})
