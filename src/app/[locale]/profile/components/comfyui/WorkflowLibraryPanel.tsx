'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { apiFetch } from '@/lib/api-fetch'
import WorkflowCompatibilityTable, { type WorkflowCompatibilityView } from './WorkflowCompatibilityTable'
import WorkflowEditor from './WorkflowEditor'
import WorkflowTestForm, { emptyWorkflowTestPayload, type WorkflowTestPayload } from './WorkflowTestForm'
import { useComfyConnections } from './hooks'
import {
  draftFromWorkflow,
  emptyWorkflowDraft,
  safeWorkflowErrorKey,
  workflowPayload,
  type WorkflowAuthorDraft,
  type WorkflowVersionView,
  type WorkflowView,
} from './workflow-ui'

type ErrorKey = 'requestFailed' | 'workflowInvalidJson' | 'workflowTooLarge' | 'testUploadInvalid'

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, init)
  if (!response.ok) throw new Error('requestFailed')
  return response.json() as Promise<T>
}

export default function WorkflowLibraryPanel() {
  const t = useTranslations('comfyui.workflows')
  const [workflows, setWorkflows] = useState<WorkflowView[]>([])
  const [selectedId, setSelectedId] = useState<string | 'new'>('new')
  const [authorDraft, setAuthorDraft] = useState<WorkflowAuthorDraft>(emptyWorkflowDraft)
  const [savedVersion, setSavedVersion] = useState<WorkflowVersionView | null>(null)
  const [connectionId, setConnectionId] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ErrorKey | null>(null)
  const [compatibility, setCompatibility] = useState<WorkflowCompatibilityView[]>([])
  const [testPayload, setTestPayload] = useState<WorkflowTestPayload | null>(emptyWorkflowTestPayload)
  const connectionsQuery = useComfyConnections()

  const load = async (preferId?: string) => {
    setLoading(true)
    try {
      const payload = await requestJson<{ workflows: WorkflowView[] }>('/api/comfyui/workflows')
      setWorkflows(payload.workflows)
      const selected = payload.workflows.find((item) => item.id === (preferId ?? selectedId))
      if (selected) {
        const version = selected.versions[0] ?? selected.currentVersion
        setSelectedId(selected.id); setSavedVersion(version); setAuthorDraft(draftFromWorkflow(selected, version))
      }
      setError(null)
    } catch { setError('requestFailed') } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const selectWorkflow = (id: string | 'new') => {
    setSelectedId(id); setError(null)
    if (id === 'new') { setSavedVersion(null); setAuthorDraft(emptyWorkflowDraft()); return }
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
    const contract = workflowPayload(authorDraft)
    if (selectedId === 'new') {
      const result = await requestJson<{ workflow: WorkflowView }>('/api/comfyui/workflows', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...contract, name: authorDraft.name, mediaType: authorDraft.mediaType }),
      })
      await load(result.workflow.id)
      return
    }
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
  })

  useEffect(() => {
    if (selectedId === 'new' || !savedVersion) { setCompatibility([]); return }
    const controller = new AbortController()
    requestJson<{ compatibility: Array<{
      connectionId: string; connectionName: string; status: 'online' | 'offline' | 'auth_failed';
      compatible: boolean; missingNodes: string[]; missingModels: Array<{ nodeId: string; field: string; value: string }>
    }> }>(`/api/comfyui/workflows/${encodeURIComponent(selectedId)}/versions/${encodeURIComponent(savedVersion.id)}/compatibility`, { signal: controller.signal })
      .then((payload) => setCompatibility(payload.compatibility.map((item) => ({
        connectionId: item.connectionId, connectionName: item.connectionName,
        state: item.status === 'auth_failed' ? 'auth_failed' : item.status === 'offline' ? 'offline' : item.compatible ? 'compatible' : 'incompatible',
        missingNodes: item.missingNodes, missingModels: item.missingModels,
      }))))
      .catch(() => { if (!controller.signal.aborted) setCompatibility([]) })
    return () => controller.abort()
  }, [savedVersion, selectedId])
  const publishVersion = () => runAction(async () => {
    if (selectedId === 'new' || !savedVersion?.validation.valid) return
    await requestJson(`/api/comfyui/workflows/${encodeURIComponent(selectedId)}/publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versionId: savedVersion.id }),
    })
    await load(selectedId)
  })
  const testVersion = () => runAction(async () => {
    if (selectedId === 'new' || !savedVersion || !connectionId) return
    if (!testPayload) return
    await requestJson(`/api/comfyui/workflows/${encodeURIComponent(selectedId)}/test-run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versionId: savedVersion.id, connectionId, variables: testPayload.variables, uploads: testPayload.uploads }),
    })
    await load(selectedId)
  })

  const issues = savedVersion?.validation.issues ?? []

  return <section aria-labelledby="comfyui-workflow-library-heading" className="flex min-h-0 flex-col overflow-hidden">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--glass-stroke-base)] px-5 py-4 sm:px-6">
      <div><h2 id="comfyui-workflow-library-heading" className="text-lg font-semibold">{t('title')}</h2><p className="mt-1 text-sm text-[var(--glass-text-secondary)]">{t('description')}</p></div>
      <button type="button" className="glass-btn-base glass-btn-tone-info px-4 py-2 text-sm" onClick={() => selectWorkflow('new')}>{t('newWorkflow')}</button>
    </header>
    <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto p-5 2xl:grid-cols-[16rem_minmax(0,1fr)] sm:p-6">
      <nav aria-label={t('library')} className="space-y-2">{loading && <p role="status" className="text-sm">{t('loading')}</p>}
        {workflows.map((workflow) => <button key={workflow.id} type="button" onClick={() => selectWorkflow(workflow.id)} aria-current={selectedId === workflow.id ? 'page' : undefined}
          className="glass-surface-soft w-full rounded-xl p-3 text-left"><span className="block truncate font-medium">{workflow.name}</span><span className="text-xs text-[var(--glass-text-tertiary)]">{t(workflow.mediaType)} · {t(`statuses.${workflow.status}`)}</span></button>)}</nav>
      <div className="min-w-0 space-y-6">
        <WorkflowEditor value={authorDraft} disabled={busy} identityLocked={selectedId !== 'new'} onChange={setAuthorDraft} onImportError={(key) => setError(key as ErrorKey)} />
        {savedVersion && <div className="glass-surface-soft rounded-xl p-3 text-xs" aria-label={t('savedVersion')}>
          {t('savedVersion')} v{savedVersion.version} · {savedVersion.validation.valid ? t('staticValid') : t('staticInvalid')} · {savedVersion.lastSuccessfulTestAt ? t('tested') : t('notTested')}
        </div>}
        <div className="flex flex-wrap items-end gap-2">
          <button type="button" onClick={() => void saveDraft()} disabled={busy || !authorDraft.name || !authorDraft.apiFormatJson} className="glass-btn-base glass-btn-tone-info px-4 py-2 text-sm">{t('saveDraft')}</button>
          <button type="button" onClick={() => void publishVersion()} disabled={busy || !savedVersion?.validation.valid} className="glass-btn-base px-4 py-2 text-sm">{t('publish')}</button>
          <label className="min-w-[12rem] text-xs">{t('testInstance')}<select value={connectionId} onChange={(event) => setConnectionId(event.target.value)} className="mt-1 w-full rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-2 py-2">
            <option value="">{t('selectInstance')}</option>{(connectionsQuery.data?.connections ?? []).filter((connection) => connection.enabled).map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}</select></label>
          <button type="button" onClick={() => void testVersion()} disabled={busy || !savedVersion || !connectionId || !testPayload} className="glass-btn-base px-4 py-2 text-sm">{t('test')}</button>
        </div>
        {savedVersion && <WorkflowTestForm key={savedVersion.id} definitions={savedVersion.variableDefinitions} onChange={setTestPayload} onError={(key) => setError(key as ErrorKey)} />}
        {error && <p role="alert" className="text-sm text-[var(--glass-danger)]">{t(error)}</p>}
        <WorkflowCompatibilityTable issues={issues} compatibility={compatibility} />
        <p className="text-xs text-[var(--glass-text-tertiary)]">{t('defaultEligibility', { status: savedVersion?.lastSuccessfulTestAt ? t('eligible') : t('ineligible') })}</p>
      </div>
    </div>
  </section>
}
