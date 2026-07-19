'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api-fetch'
import { invalidateUserModels } from '@/lib/query/hooks/useUserModels'
import {
  deriveVideoTestDurationContract,
  prepareVideoTestVariableDefinitions,
} from '@/lib/comfyui/video-test-duration'
import WorkflowCompatibilityTable, { type WorkflowCompatibilityView } from './WorkflowCompatibilityTable'
import WorkflowActivationPanel from './WorkflowActivationPanel'
import WorkflowEditor from './WorkflowEditor'
import WorkflowTestForm, { emptyWorkflowTestPayload, type WorkflowTestPayload } from './WorkflowTestForm'
import { useComfyConnections } from './hooks'
import {
  draftFromWorkflow,
  createWorkflowCompatibilityCoordinator,
  mapWorkflowCompatibility,
  safeWorkflowErrorKey,
  WorkflowRequestError,
  workflowRequestErrorFromPayload,
  workflowPayload,
  type WorkflowAuthorDraft,
  type WorkflowCompatibilityResponseItem,
  type WorkflowVersionView,
  type WorkflowView,
  type WorkflowErrorKey,
} from './workflow-ui'

type ErrorKey = WorkflowErrorKey | 'testUploadInvalid' | 'testUploadTotalTooLarge'

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
  onActivationClosed?(): void
}

export default function WorkflowLibraryPanel({ initialWorkflowId, activationWorkflowId, onCreateNew, onActivationClosed }: Props) {
  const t = useTranslations('comfyui.workflows')
  const queryClient = useQueryClient()
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
  const [connectionId, setConnectionId] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ErrorKey | null>(null)
  const [workflowDeleted, setWorkflowDeleted] = useState(false)
  const [compatibility, setCompatibility] = useState<WorkflowCompatibilityView[]>([])
  const [compatibilityCursor, setCompatibilityCursor] = useState<string | null>(null)
  const [compatibilityError, setCompatibilityError] = useState(false)
  const [compatibilityLoadingMore, setCompatibilityLoadingMore] = useState(false)
  const [compatibilityCoordinator] = useState(() => createWorkflowCompatibilityCoordinator())
  const [testPayload, setTestPayload] = useState<WorkflowTestPayload | null>(emptyWorkflowTestPayload)
  const [mappingRepairMode, setMappingRepairMode] = useState(false)
  const [mappingFocusRequestId, setMappingFocusRequestId] = useState(0)
  const connectionsQuery = useComfyConnections()
  const selectedWorkflow = workflows.find((workflow) => workflow.id === selectedId)
  const selectedMediaType = selectedWorkflow?.mediaType ?? authorDraft?.mediaType ?? 'image'
  const durationTest = useMemo(() => deriveVideoTestDurationContract({
    mediaType: selectedMediaType,
    variableDefinitions: savedVersion?.variableDefinitions ?? [],
    bindings: savedVersion?.bindings ?? [],
  }), [savedVersion?.bindings, savedVersion?.variableDefinitions, selectedMediaType])
  const testDefinitions = useMemo(() => prepareVideoTestVariableDefinitions(
    savedVersion?.variableDefinitions ?? [],
    durationTest,
  ), [durationTest, savedVersion?.variableDefinitions])
  const durationVariableNames = useMemo(() => new Set(
    durationTest.required && durationTest.eligible ? [durationTest.variableName] : [],
  ), [durationTest])
  const durationLabels = useMemo(() => (
    durationTest.required && durationTest.eligible
      ? { [durationTest.variableName]: t('videoTestDuration') }
      : {}
  ), [durationTest, t])
  const durationHints = useMemo(() => (
    durationTest.required && durationTest.eligible && durationTest.targetUnit === 'frames'
      ? { [durationTest.variableName]: t('videoTestFramesHint') }
      : {}
  ), [durationTest, t])
  const durationBlocked = durationTest.required && !durationTest.eligible

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
    setMappingRepairMode(false)
    setMappingFocusRequestId(0)
    updateSelectedId(id); setError(null)
    const workflow = workflows.find((item) => item.id === id)
    if (!workflow) return
    const version = workflow.versions[0] ?? workflow.currentVersion
    setSavedVersion(version); setAuthorDraft(draftFromWorkflow(workflow, version))
  }
  const runAction = async (operation: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await operation() } catch (actionError) { setError(safeWorkflowErrorKey(actionError)) } finally { setBusy(false) }
  }
  const saveDraft = () => runAction(async () => {
    if (!selectedId || !authorDraft) return
    const contract = workflowPayload(authorDraft)
    const current = workflows.find((workflow) => workflow.id === selectedId)
    if (current && current.name !== authorDraft.name.trim()) {
      await requestJson(`/api/comfyui/workflows/${encodeURIComponent(selectedId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: authorDraft.name }),
      })
    }
    const result = await requestJson<{ version: WorkflowVersionView }>(`/api/comfyui/workflows/${encodeURIComponent(selectedId)}/versions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(contract),
    })
    setSavedVersion(result.version)
    await load(selectedId)
    setMappingRepairMode(false)
  })
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
  const publishVersion = () => runAction(async () => {
    if (!selectedId || !savedVersion?.validation.valid) return
    await requestJson(`/api/comfyui/workflows/${encodeURIComponent(selectedId)}/publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versionId: savedVersion.id }),
    })
    await invalidateUserModels(queryClient)
    await load(selectedId)
  })
  const testVersion = () => runAction(async () => {
    if (!selectedId || !savedVersion || !connectionId) return
    if (!testPayload) return
    await requestJson(`/api/comfyui/workflows/${encodeURIComponent(selectedId)}/test-run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versionId: savedVersion.id, connectionId, variables: testPayload.variables, uploads: testPayload.uploads }),
    })
    await Promise.resolve(invalidateUserModels(queryClient)).catch(() => undefined)
    await load(selectedId)
  })
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
    setMappingRepairMode(true)
    setMappingFocusRequestId((current) => current + 1)
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
        {selectedId && authorDraft && <WorkflowEditor key={selectedId} value={authorDraft} disabled={busy || activationOpen} mappingFocusRequestId={mappingFocusRequestId} onChange={setAuthorDraft} onImportError={(key) => setError(key as ErrorKey)} />}
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
        {mappingRepairMode && !activationOpen && <p role="status" className="text-sm text-[var(--glass-text-secondary)]">
          {t('mappingRepairHint')}
        </p>}
        {selectedId && authorDraft && !activationOpen && <div className="flex flex-wrap items-end gap-2">
          <button type="button" onClick={() => void saveDraft()} disabled={busy || !authorDraft.name || !authorDraft.apiFormatJson} className="glass-btn-base glass-btn-tone-info px-4 py-2 text-sm">{t('saveDraft')}</button>
          <button type="button" onClick={openSelectedWorkflowActivation} disabled={busy || !savedVersion || durationBlocked} className="glass-btn-base glass-btn-tone-info px-4 py-2 text-sm">{t('testAndEnable')}</button>
          <button type="button" onClick={() => void publishVersion()} disabled={busy || !savedVersion?.validation.valid} className="glass-btn-base px-4 py-2 text-sm">{t('publish')}</button>
          <label className="min-w-[12rem] text-xs">{t('testInstance')}<select value={connectionId} onChange={(event) => setConnectionId(event.target.value)} className="mt-1 w-full rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-2 py-2">
            <option value="">{t('selectInstance')}</option>{(connectionsQuery.data?.connections ?? []).filter((connection) => connection.enabled).map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}</select></label>
          <button type="button" onClick={() => void testVersion()} disabled={busy || !savedVersion || !connectionId || !testPayload || durationBlocked} className="glass-btn-base px-4 py-2 text-sm">{t('test')}</button>
          <button type="button" onClick={() => void archiveSelectedWorkflow()} disabled={busy}
            className="glass-btn-base glass-btn-tone-danger px-4 py-2 text-sm">{t('deleteWorkflow')}</button>
        </div>}
        {savedVersion && !activationOpen && <WorkflowTestForm
          key={savedVersion.id}
          definitions={testDefinitions}
          positiveNumberVariables={durationVariableNames}
          labelOverrides={durationLabels}
          hintOverrides={durationHints}
          onChange={setTestPayload}
          onError={(key) => setError(key as ErrorKey)}
        />}
        {durationBlocked && !activationOpen && <p role="alert" className="text-sm text-[var(--glass-danger)]">{t('videoTestDurationMappingRequired')}</p>}
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
