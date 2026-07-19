// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ComfyUiSettings from '@/app/[locale]/profile/components/comfyui/ComfyUiSettings'
import { emptyWorkflowDraft } from '@/app/[locale]/profile/components/comfyui/workflow-ui'

const createWorkflowDraftMock = vi.hoisted(() => vi.fn())
const prepareWorkflowVersionForTestMock = vi.hoisted(() => vi.fn())

;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('@/app/[locale]/profile/components/comfyui/workflow-requests', () => ({
  createWorkflowDraft: createWorkflowDraftMock,
  prepareWorkflowVersionForTest: prepareWorkflowVersionForTestMock,
}))
vi.mock('@/app/[locale]/profile/components/comfyui/ConnectionPoolPanel', () => ({
  default: () => <section>CONNECTION POOL</section>,
}))
vi.mock('@/app/[locale]/profile/components/comfyui/WorkflowLibraryPanel', () => ({
  default: ({
    initialWorkflowId,
    activationWorkflowId,
    onCreateNew,
    onEditWorkflow,
  }: {
    initialWorkflowId?: string | null
    activationWorkflowId?: string | null
    onCreateNew(): void
    onEditWorkflow(workflowId: string, draft: ReturnType<typeof emptyWorkflowDraft>): void
  }) => <section aria-label="WORKFLOW LIBRARY"
    data-initial-workflow-id={initialWorkflowId ?? ''}
    data-activation-workflow-id={activationWorkflowId ?? ''}
  >
    <button type="button" onClick={onCreateNew}>NEW WORKFLOW</button>
    <button type="button" onClick={() => onEditWorkflow(
      'workflow-edit',
      { ...emptyWorkflowDraft(), name: 'Editable workflow' },
    )}>EDIT WORKFLOW</button>
  </section>,
}))
vi.mock('@/app/[locale]/profile/components/comfyui/WorkflowCreationWizard', () => ({
  default: ({
    onCancel,
    onCreate,
    onCreated,
  }: {
    onCancel(): void
    onCreate(draft: ReturnType<typeof emptyWorkflowDraft>, creationId: string): Promise<string>
    onCreated(id: string): void | Promise<void>
  }) => <section aria-label="WORKFLOW WIZARD">
    <button type="button" onClick={onCancel}>CANCEL WIZARD</button>
    <button type="button" onClick={() => {
      void onCreate({ ...emptyWorkflowDraft(), name: 'Portrait' }, 'creation-1')
        .then((id) => onCreated(id))
    }}>FINISH CREATE</button>
  </section>,
}))
vi.mock('@/app/[locale]/profile/components/comfyui/WorkflowEditWizard', () => ({
  default: ({ onCancel }: { onCancel(): void }) => <section aria-label="WORKFLOW EDIT WIZARD">
    <button type="button" onClick={onCancel}>CANCEL EDIT</button>
  </section>,
}))

describe('ComfyUI settings workflow creation shell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createWorkflowDraftMock.mockResolvedValue('workflow-created')
    prepareWorkflowVersionForTestMock.mockReset()
  })

  afterEach(cleanup)

  it('replaces the overview with a full-width wizard and restores it on cancel', () => {
    const view = render(<ComfyUiSettings />)

    expect(view.getByText('CONNECTION POOL')).toBeTruthy()
    expect(view.getByRole('region', { name: 'WORKFLOW LIBRARY' })).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: 'NEW WORKFLOW' }))

    expect(view.getByRole('region', { name: 'WORKFLOW WIZARD' })).toBeTruthy()
    expect(view.queryByText('CONNECTION POOL')).toBeNull()
    expect(view.queryByRole('region', { name: 'WORKFLOW LIBRARY' })).toBeNull()
    expect(view.getByLabelText('ComfyUI settings').getAttribute('data-mode')).toBe('wizard')

    fireEvent.click(view.getByRole('button', { name: 'CANCEL WIZARD' }))

    expect(view.getByText('CONNECTION POOL')).toBeTruthy()
    expect(view.getByRole('region', { name: 'WORKFLOW LIBRARY' })).toBeTruthy()
  })

  it('creates through createWorkflowDraft then keeps the created workflow selected for activation', async () => {
    const view = render(<ComfyUiSettings />)
    fireEvent.click(view.getByRole('button', { name: 'NEW WORKFLOW' }))

    fireEvent.click(view.getByRole('button', { name: 'FINISH CREATE' }))

    await waitFor(() => expect(createWorkflowDraftMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Portrait' }),
      'creation-1',
    ))
    const library = await view.findByRole('region', { name: 'WORKFLOW LIBRARY' })
    expect(library.getAttribute('data-initial-workflow-id')).toBe('workflow-created')
    expect(library.getAttribute('data-activation-workflow-id')).toBe('workflow-created')
  })

  it('opens saved workflow editing as a full-width window and restores overview on cancel', () => {
    const view = render(<ComfyUiSettings />)

    fireEvent.click(view.getByRole('button', { name: 'EDIT WORKFLOW' }))

    expect(view.getByRole('region', { name: 'WORKFLOW EDIT WIZARD' })).toBeTruthy()
    expect(view.queryByText('CONNECTION POOL')).toBeNull()
    expect(view.getByLabelText('ComfyUI settings').getAttribute('data-mode')).toBe('edit')

    fireEvent.click(view.getByRole('button', { name: 'CANCEL EDIT' }))

    expect(view.getByText('CONNECTION POOL')).toBeTruthy()
    expect(view.getByRole('region', { name: 'WORKFLOW LIBRARY' })).toBeTruthy()
  })
})
