'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { apiFetch } from '@/lib/api-fetch'
import WorkflowCompatibilityTable, { type WorkflowCompatibilityView } from './WorkflowCompatibilityTable'
import WorkflowActivationPanel from './WorkflowActivationPanel'
import {
  draftFromWorkflow,
  createWorkflowCompatibilityCoordinator,
  mapWorkflowCompatibility,
  safeWorkflowErrorKey,
  WorkflowRequestError,
  workflowRequestErrorFromPayload,
  type WorkflowAuthorDraft,
  type WorkflowCompatibilityResponseItem,
  type WorkflowVersionView,
  type WorkflowView,
  type WorkflowErrorKey,
} from './workflow-ui'

type ErrorKey = WorkflowErrorKey

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, init)
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null)
    throw workflowRequestErrorFromPayload(payload, response.status)
  }
  return response.json() as Promise<T>
}

interface Props {
  initialWorkflowId?: string | null
  activationWorkflowId?: string | null
  onCreateNew(): void
  onEditWorkflow(workflowId: string, draft: WorkflowAuthorDraft): void
  onActivationClosed?(): void
}

export default function WorkflowLibraryPanel({ initialWorkflowId, activationWorkflowId, onCreateNew, onEditWorkflow, onActivationClosed }: Props) {
  const t = useTranslations('comfyui.workflows')
  const [workflows, setWorkflows] = useState<WorkflowView[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [localActivationWorkflowId, setLocalActivationWorkflowId] = useState<string | null>(null)
  const activationWorkflowIdRef = useRef(activationWorkflowId)
  const activationOwnershipEpochRef = useRef(0)
  const onActivationClosedRef = useRef(onActivationClosed)
  const parentActivationCloseRequestedRef = useRef<{ workflowId: string; epoch: number } | null>(null)
  const selectedIdRef = useRef<string | null>(null)
  const selectionRevisionRef = useRef(0)
  const archiveInFlightRef = useRef<string | null>(null)
  const newWorkflowButtonRef = useRef<HTMLButtonElement>(null)
  const [authorDraft, setAuthorDraft] = useState<WorkflowAuthorDraft | null>(null)
  const [savedVersion, setSavedVersion] = useState<WorkflowVersionView | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ErrorKey | null>(null)
  const [workflowDeleted, setWorkflowDeleted] = useState(false)
  const [compatibility, setCompatibility] = useState<WorkflowCompatibilityView[]>([])
  const [compatibilityCursor, setCompatibilityCursor] = useState<string | null>(null)
  const [compatibilityError, setCompatibilityError] = useState(false)
  const [compatibilityLoadingMore, setCompatibilityLoadingMore] = useState(false)
  const [compatibilityCoordinator] = useState(() => createWorkflowCompatibilityCoordinator())
  const selectedWorkflow = workflows.find((workflow) => workflow.id === selectedId)
  const selectedMediaType = selectedWorkflow?.mediaType ?? authorDraft?.mediaType ?? 'image'

  if (activationWorkflowIdRef.current !== activationWorkflowId) {
    activationWorkflowIdRef.current = activationWorkflowId
    activationOwnershipEpochRef.current += 1
  }
  onActivationClosedRef.current = onActivationClosed

  useEffect(() => {
    if (activationWorkflowId) setLocalActivationWorkflowId(null)
  }, [activationWorkflowId])

  const closeActivationForSelection = (
    nextId?: string | null,
    expectedEpoch = activationOwnershipEpochRef.current,
  ) => {
    setLocalActivationWorkflowId(null)
    const currentParentId = activationWorkflowIdRef.current
    const currentEpoch = activationOwnershipEpochRef.current
    if (expectedEpoch !== currentEpoch) return
    if (!currentParentId || currentParentId === nextId) return
    const requested = parentActivationCloseRequestedRef.current
    if (requested?.workflowId === currentParentId && requested.epoch === currentEpoch) return
    parentActivationCloseRequestedRef.current = { workflowId: currentParentId, epoch: currentEpoch }
    onActivationClosedRef.current?.()
  }

  const updateSelectedId = (id: string | null) => {
    selectedIdRef.current = id
    setSelectedId(id)
  }

  const load = async (preferId?: string) => {
    const selectionRevision = selectionRevisionRef.current
    const activationEpoch = activationOwnershipEpochRef.current
    setLoading(true)
    try {
      const payload = await requestJson<{ workflows: WorkflowView[] }>('/api/comfyui/workflows')
      if (selectionRevisionRef.current !== selectionRevision) return
      setWorkflows(payload.workflows)
      const targetId = preferId ?? selectedIdRef.current
      const selected = payload.workflows.find((item) => item.id === targetId) ?? payload.workflows[0]
      if (selected) {
        if (selected.id !== selectedIdRef.current) closeActivationForSelection(selected.id, activationEpoch)
        const version = selected.versions[0] ?? selected.currentVersion
        updateSelectedId(selected.id); setSavedVersion(version); setAuthorDraft(draftFromWorkflow(selected, version))
      } else if (selectedIdRef.current === targetId) {
        closeActivationForSelection(null, activationEpoch)
        updateSelectedId(null); setSavedVersion(null); setAuthorDraft(null)
      }
      setError(null)
    } catch { setError('requestFailed') } finally { setLoading(false) }
  }
  useEffect(() => { void load(initialWorkflowId ?? undefined) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const selectWorkflow = (id: string) => {
    selectionRevisionRef.current += 1
    if (id !== selectedIdRef.current) closeActivationForSelection(id)
    updateSelectedId(id); setError(null)
    const workflow = workflows.find((item) => item.id === id)
    if (!workflow) return
    const version = workflow.versions[0] ?? workflow.currentVersion
    setSavedVersion(version); setAuthorDraft(draftFromWorkflow(workflow, version))
  }
  const archiveSelectedWorkflow = async () => {
    if (!selectedId || archiveInFlightRef.current) return
    const targetId = selectedId
    const selected = workflows.find((workflow) => workflow.id === targetId)
    if (!selected || !window.confirm(t('deleteWorkflowConfirm', { name: selected.name }))) return
    archiveInFlightRef.current = targetId
    setBusy(true); setError(null); setWorkflowDeleted(false)
    try {
      await requestJson(`/api/comfyui/workflows/${encodeURIComponent(targetId)}`, {
        method: 'DELETE',
      })
      setWorkflows((current) => current.filter((workflow) => workflow.id !== targetId))
      closeActivationForSelection(null)
      setWorkflowDeleted(true)
      if (selectedIdRef.current === targetId) {
        updateSelectedId(null)
        setSavedVersion(null)
        setAuthorDraft(null)
        newWorkflowButtonRef.current?.focus()
      }
      await load()
    } catch (actionError) {
      setError(actionError instanceof WorkflowRequestError
        && actionError.status === 409
        && actionError.code === 'CONFLICT'
        && actionError.reason === 'COMFY_WORKFLOW_PROJECT_DEFAULT_CONFLICT'
        ? 'workflowProjectDefaultConflict'
        : safeWorkflowErrorKey(actionError))
    } finally {
      if (archiveInFlightRef.current === targetId) archiveInFlightRef.current = null
      setBusy(false)
    }
  }

  const savedVersionId = savedVersion?.id ?? null
  useEffect(() => {
    const selection = compatibilityCoordinator.select(
      selectedId ?? '',
      savedVersionId ?? '',
    )
    setCompatibility([]); setCompatibilityCursor(null); setCompatibilityError(false); setCompatibilityLoadingMore(false)
    if (!selectedId || !savedVersionId) return () => compatibilityCoordinator.cancel(selection)
    const ticket = compatibilityCoordinator.beginInitial()
    if (!ticket) return () => compatibilityCoordinator.cancel(selection)
    requestJson<{ compatibility: WorkflowCompatibilityResponseItem[]; nextCursor: string | null }>(`/api/comfyui/workflows/${encodeURIComponent(ticket.workflowId)}/versions/${encodeURIComponent(ticket.versionId)}/compatibility?limit=20`, { signal: ticket.controller.signal })
      .then((payload) => {
        if (!compatibilityCoordinator.accept(ticket, payload.nextCursor)) return
        setCompatibility(payload.compatibility.map(mapWorkflowCompatibility)); setCompatibilityCursor(payload.nextCursor)
      })
      .catch(() => {
        if (compatibilityCoordinator.isCurrent(ticket)) setCompatibilityError(true)
      })
      .finally(() => compatibilityCoordinator.finish(ticket))
    return () => compatibilityCoordinator.cancel(selection)
  }, [compatibilityCoordinator, savedVersionId, selectedId])
  const loadMoreCompatibility = async () => {
    if (!selectedId || !savedVersion || !compatibilityCursor || compatibilityLoadingMore) return
    const ticket = compatibilityCoordinator.beginLoadMore(compatibilityCursor)
    if (!ticket) return
    setCompatibilityLoadingMore(true); setCompatibilityError(false)
    let settledCurrent = false
    try {
      const payload = await requestJson<{ compatibility: WorkflowCompatibilityResponseItem[]; nextCursor: string | null }>(`/api/comfyui/workflows/${encodeURIComponent(ticket.workflowId)}/versions/${encodeURIComponent(ticket.versionId)}/compatibility?limit=20&cursor=${encodeURIComponent(ticket.cursor ?? '')}`, { signal: ticket.controller.signal })
      if (!compatibilityCoordinator.accept(ticket, payload.nextCursor)) return
      settledCurrent = true
      setCompatibility((current) => {
        const rows = new Map(current.map((item) => [item.connectionId, item]))
        for (const item of payload.compatibility.map(mapWorkflowCompatibility)) rows.set(item.connectionId, item)
        return [...rows.values()]
      })
      setCompatibilityCursor(payload.nextCursor)
    } catch {
      if (compatibilityCoordinator.isCurrent(ticket)) {
        settledCurrent = true; setCompatibilityError(true)
      }
    } finally {
      const stillCurrent = compatibilityCoordinator.isCurrent(ticket)
      compatibilityCoordinator.finish(ticket)
      if (settledCurrent || stillCurrent) setCompatibilityLoadingMore(false)
    }
  }

  const issues = savedVersion?.validation.issues ?? []
  const activeActivationWorkflowId = activationWorkflowId ?? localActivationWorkflowId
  const activationOpen = Boolean(selectedId && savedVersion && activeActivationWorkflowId === selectedId)
  const openSelectedWorkflowActivation = () => {
    if (!selectedId) return
    closeActivationForSelection(selectedId)
    setLocalActivationWorkflowId(selectedId)
  }
  const closeSelectedWorkflowActivation = () => {
    closeActivationForSelection(null)
  }
  const editFailedMappings = () => {
    closeSelectedWorkflowActivation()
    if (selectedId && authorDraft) onEditWorkflow(selectedId, authorDraft)
  }

  return <section aria-labelledby="comfyui-workflow-library-heading" className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--glass-stroke-base)] px-5 py-4 sm:px-6">
      <div><h2 id="comfyui-workflow-library-heading" className="text-lg font-semibold">{t('title')}</h2><p className="mt-1 text-sm text-[var(--glass-text-secondary)]">{t('description')}</p></div>
      <button ref={newWorkflowButtonRef} type="button" className="glass-btn-base glass-btn-tone-info px-4 py-2 text-sm" onClick={onCreateNew}>{t('newWorkflow')}</button>
    </header>
    <div className="grid min-h-0 min-w-0 flex-1 gap-5 overflow-y-auto p-5 sm:p-6">
      <nav aria-label={t('library')} className="space-y-2">{loading && <p role="status" className="text-sm">{t('loading')}</p>}
        {workflows.map((workflow) => <button key={workflow.id} type="button" onClick={() => selectWorkflow(workflow.id)} aria-current={selectedId === workflow.id ? 'page' : undefined}
          className="glass-surface-soft w-full rounded-xl p-3 text-left"><span className="block truncate font-medium">{workflow.name}</span><span className="text-xs text-[var(--glass-text-tertiary)]">{t(workflow.mediaType)} · {t(`purposes.${workflow.purpose}`)} · {t(`statuses.${workflow.status}`)}</span></button>)}</nav>
      <div className="min-w-0 space-y-6">
        {selectedWorkflow && <div className="glass-surface-soft space-y-2 rounded-xl p-4" aria-label={t('workflowSummary')}>
          <h3 className="break-words font-semibold">{selectedWorkflow.name}</h3>
          <p className="text-sm text-[var(--glass-text-secondary)]">
            {t(selectedWorkflow.mediaType)} · {t(`purposes.${selectedWorkflow.purpose}`)} · {t(`statuses.${selectedWorkflow.status}`)}
          </p>
        </div>}
        {savedVersion && <div className="glass-surface-soft rounded-xl p-3 text-xs" aria-label={t('savedVersion')}>
          {t('savedVersion')} v{savedVersion.version} · {savedVersion.validation.valid ? t('staticValid') : t('staticInvalid')} · {savedVersion.lastSuccessfulTestAt ? t('tested') : t('notTested')}
        </div>}
        {activationOpen && selectedId && savedVersion && <WorkflowActivationPanel
          key={savedVersion.id}
          workflowId={selectedId}
          mediaType={selectedMediaType}
          version={savedVersion}
          onClose={closeSelectedWorkflowActivation}
          onEditMappings={editFailedMappings}
          onActivated={() => load(selectedId)}
        />}
        {selectedId && authorDraft && !activationOpen && <div className="flex flex-wrap items-end gap-2">
          <button type="button" onClick={() => onEditWorkflow(selectedId, authorDraft)} disabled={busy} className="glass-btn-base glass-btn-tone-info px-4 py-2 text-sm">{t('editWorkflow')}</button>
          <button type="button" onClick={openSelectedWorkflowActivation} disabled={busy || !savedVersion} className="glass-btn-base px-4 py-2 text-sm">{t('testAndEnable')}</button>
          <button type="button" onClick={() => void archiveSelectedWorkflow()} disabled={busy}
            className="glass-btn-base glass-btn-tone-danger px-4 py-2 text-sm">{t('deleteWorkflow')}</button>
        </div>}
        {workflowDeleted && <p role="status" className="text-sm text-[var(--glass-tone-success-fg)]">{t('workflowDeleted')}</p>}
        {error && <p role="alert" className="text-sm text-[var(--glass-danger)]">{t(error)}</p>}
        {selectedId && <WorkflowCompatibilityTable issues={issues} compatibility={compatibility} />}
        {selectedId && compatibilityError && <p role="alert" className="text-xs text-[var(--glass-danger)]">{t('compatibilityLoadFailed')}</p>}
        {selectedId && compatibilityCursor && <button type="button" disabled={compatibilityLoadingMore} className="glass-btn-base px-3 py-2 text-xs disabled:opacity-50" onClick={() => void loadMoreCompatibility()}>{compatibilityLoadingMore ? t('loading') : t('loadMore')}</button>}
        {selectedId && <p className="text-xs text-[var(--glass-text-tertiary)]">{t('defaultEligibility', { status: savedVersion?.lastSuccessfulTestAt ? t('eligible') : t('ineligible') })}</p>}
      </div>
    </div>
  </section>
}
