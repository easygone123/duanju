'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { invalidateUserModels } from '@/lib/query/hooks/useUserModels'
import { useComfyConnections } from './hooks'
import { requestWorkflowAction } from './workflow-requests'
import WorkflowTestForm, { emptyWorkflowTestPayload, type WorkflowTestPayload } from './WorkflowTestForm'
import {
  initialWorkflowActivationState,
  nextWorkflowActivationState,
} from './workflow-activation'
import { safeWorkflowErrorKey, type WorkflowVersionView } from './workflow-ui'

interface Props {
  workflowId: string
  version: WorkflowVersionView
  onClose(): void
  onActivated?(): void | Promise<void>
}

export default function WorkflowActivationPanel({ workflowId, version, onClose, onActivated }: Props) {
  const t = useTranslations('comfyui.workflows')
  const queryClient = useQueryClient()
  const connectionsQuery = useComfyConnections()
  const enabledConnections = useMemo(() => (
    connectionsQuery.data?.connections ?? []
  ).filter((connection) => connection.enabled), [connectionsQuery.data?.connections])
  const [connectionId, setConnectionId] = useState(() => enabledConnections[0]?.id ?? '')
  useEffect(() => {
    if (enabledConnections.some((connection) => connection.id === connectionId)) return
    setConnectionId(enabledConnections[0]?.id ?? '')
  }, [connectionId, enabledConnections])
  const [testPayload, setTestPayload] = useState<WorkflowTestPayload | null>(() => (
    version.variableDefinitions.length === 0 ? emptyWorkflowTestPayload() : null
  ))
  const [activation, setActivation] = useState(() => initialWorkflowActivationState({
    valid: version.validation.valid,
    published: Boolean(version.publishedAt),
    tested: Boolean(version.lastSuccessfulTestAt),
  }))
  const [requestError, setRequestError] = useState<string | null>(null)
  const previousVersionIdRef = useRef(version.id)
  const versionRef = useRef(version)
  versionRef.current = version
  useEffect(() => {
    if (previousVersionIdRef.current === version.id) return
    previousVersionIdRef.current = version.id
    const nextVersion = versionRef.current
    setTestPayload(nextVersion.variableDefinitions.length === 0 ? emptyWorkflowTestPayload() : null)
    setActivation(initialWorkflowActivationState({
      valid: nextVersion.validation.valid,
      published: Boolean(nextVersion.publishedAt),
      tested: Boolean(nextVersion.lastSuccessfulTestAt),
    }))
    setRequestError(null)
  }, [version.id])

  const transition = (event: Parameters<typeof nextWorkflowActivationState>[1]) => {
    setActivation((current) => nextWorkflowActivationState(current, event))
  }

  const publishExactVersion = async () => {
    transition('publish_started')
    setRequestError(null)
    try {
      await requestWorkflowAction(`/api/comfyui/workflows/${encodeURIComponent(workflowId)}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId: version.id }),
      })
    } catch (error) {
      setRequestError(safeWorkflowErrorKey(error))
      transition('publish_failed')
      return
    }
    transition('publish_succeeded')
    await Promise.resolve(invalidateUserModels(queryClient)).catch(() => undefined)
    await onActivated?.()
  }

  const testAndPublish = async () => {
    if (!connectionId || !testPayload) return
    transition('test_started')
    setRequestError(null)
    try {
      await requestWorkflowAction(`/api/comfyui/workflows/${encodeURIComponent(workflowId)}/test-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          versionId: version.id,
          connectionId,
          variables: testPayload.variables,
          uploads: testPayload.uploads,
        }),
      })
    } catch (error) {
      setRequestError(safeWorkflowErrorKey(error))
      transition('test_failed')
      return
    }
    transition('test_succeeded')
    await publishExactVersion()
  }

  const busy = activation.busy !== null
  const canTest = version.validation.valid && Boolean(connectionId) && Boolean(testPayload) && !busy
  const canPublish = version.validation.valid && !busy
  const statusKey = activation.status === 'needs_test'
    ? 'needsTest'
    : activation.status === 'ready_to_publish'
      ? 'readyToPublish'
      : activation.status

  return <section aria-labelledby="workflow-activation-heading" className="glass-surface-soft space-y-4 rounded-xl p-4">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 id="workflow-activation-heading" className="font-semibold">{t('activation.title')}</h3>
      </div>
      <button type="button" className="glass-btn-base px-3 py-1.5 text-xs" onClick={onClose}>{t('activation.close')}</button>
    </header>

    <p role="status" className="text-sm font-medium">{t(`activation.${statusKey}`)}</p>

    {activation.status !== 'available' && <>
      {!activation.testComplete && (enabledConnections.length === 0
        ? <p className="text-sm text-[var(--glass-danger)]">{t('activation.noEnabledInstance')}</p>
        : <label className="block text-xs">{t('activation.instance')}
          <select value={connectionId} onChange={(event) => setConnectionId(event.target.value)} className="mt-1 w-full rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-2 py-2">
            {enabledConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
          </select>
        </label>)}

      {!activation.testComplete && <WorkflowTestForm
        key={version.id}
        definitions={version.variableDefinitions}
        onChange={setTestPayload}
        onError={(key) => setRequestError(key)}
      />}

      {activation.error === 'test' && <p role="alert" className="text-sm text-[var(--glass-danger)]">{t('activation.testFailed')}</p>}
      {activation.error === 'publish' && <p role="alert" className="text-sm text-[var(--glass-danger)]">{t('activation.publishFailed')}</p>}
      {requestError && <p className="text-xs text-[var(--glass-text-tertiary)]">{t(requestError)}</p>}

      {activation.publishRequired
        ? <button type="button" disabled={!canPublish} className="glass-btn-base glass-btn-tone-info px-4 py-2 text-sm disabled:opacity-50" onClick={() => void publishExactVersion()}>
          {activation.error === 'publish' ? t('activation.retryPublish') : t('activation.publish')}
        </button>
        : <button type="button" disabled={!canTest} className="glass-btn-base glass-btn-tone-info px-4 py-2 text-sm disabled:opacity-50" onClick={() => void testAndPublish()}>
          {activation.busy === 'testing' ? t('activation.testing') : t('activation.testAndEnable')}
        </button>}
    </>}
  </section>
}
