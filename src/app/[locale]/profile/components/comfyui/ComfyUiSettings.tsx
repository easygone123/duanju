'use client'

import { useState } from 'react'
import ConnectionPoolPanel from './ConnectionPoolPanel'
import WorkflowLibraryPanel from './WorkflowLibraryPanel'
import WorkflowCreationWizard from './WorkflowCreationWizard'
import WorkflowEditWizard from './WorkflowEditWizard'
import {
  createWorkflowDraft,
  prepareWorkflowVersionForTest,
} from './workflow-requests'
import type { WorkflowAuthorDraft } from './workflow-ui'

interface WorkflowEditTarget {
  workflowId: string
  draft: WorkflowAuthorDraft
}

export default function ComfyUiSettings() {
  const [creating, setCreating] = useState(false)
  const [editTarget, setEditTarget] = useState<WorkflowEditTarget | null>(null)
  const [initialWorkflowId, setInitialWorkflowId] = useState<string | null>(null)
  const [activationWorkflowId, setActivationWorkflowId] = useState<string | null>(null)

  if (creating) return <div aria-label="ComfyUI settings" data-mode="wizard" className="h-full min-h-0 min-w-0">
    <WorkflowCreationWizard
      onCancel={() => setCreating(false)}
      onCreate={createWorkflowDraft}
      onCreated={(workflowId) => {
        setInitialWorkflowId(workflowId)
        setActivationWorkflowId(workflowId)
        setCreating(false)
      }}
    />
  </div>

  if (editTarget) return <div aria-label="ComfyUI settings" data-mode="edit" className="h-full min-h-0 min-w-0">
    <WorkflowEditWizard
      key={editTarget.workflowId}
      workflowId={editTarget.workflowId}
      initialDraft={editTarget.draft}
      onCancel={() => setEditTarget(null)}
      onPrepareTest={(draft) => prepareWorkflowVersionForTest(
        editTarget.workflowId,
        editTarget.draft.name,
        draft,
      )}
      onPublished={() => {
        setInitialWorkflowId(editTarget.workflowId)
        setActivationWorkflowId(null)
        setEditTarget(null)
      }}
    />
  </div>

  return <div aria-label="ComfyUI settings" data-mode="overview" className="grid h-full min-h-0 min-w-0 2xl:grid-cols-2">
    <ConnectionPoolPanel />
    <div className="min-w-0 min-h-[32rem] border-t border-[var(--glass-stroke-base)] 2xl:border-l 2xl:border-t-0"><WorkflowLibraryPanel
      initialWorkflowId={initialWorkflowId}
      activationWorkflowId={activationWorkflowId}
      onCreateNew={() => setCreating(true)}
      onEditWorkflow={(workflowId, draft) => setEditTarget({ workflowId, draft })}
      onActivationClosed={() => setActivationWorkflowId(null)}
    /></div>
  </div>
}
