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
  onEditMappings?(): void
  onActivated?(): void | Promise<void>
}

export default function WorkflowActivationPanel({ workflowId, version, onClose, onEditMappings, onActivated }: Props) {
  const t = useTranslations('comfyui.workflows')
  const queryClient = useQueryClient()
  const connectionsQuery = useComfyConnections()
  const enabledConnections = useMemo(() => (
    connectionsQuery.data?.connections ?? []
  ).filter((connection) => connection.enabled), [connectionsQuery.data?.connections])
  const requiredDefinitions = useMemo(
    () => version.variableDefinitions.filter((definition) => definition.required),
    [version.variableDefinitions],
  )
  const [connectionId, setConnectionId] = useState(() => enabledConnections[0]?.id ?? '')
  useEffect(() => {
    if (enabledConnections.some((connection) => connection.id === connectionId)) return
    setConnectionId(enabledConnections[0]?.id ?? '')
  }, [connectionId, enabledConnections])
  const [testPayload, setTestPayload] = useState<WorkflowTestPayload | null>(() => (
    requiredDefinitions.length === 0 ? emptyWorkflowTestPayload() : null
  ))
  const [activation, setActivation] = useState(() => initialWorkflowActivationState({
    valid: version.validation.valid,
    published: Boolean(version.publishedAt),
    tested: Boolean(version.lastSuccessfulTestAt),
  }))
  const [requestError, setRequestError] = useState<string | null>(null)
  const previousVersionIdRef = useRef(version.id)
  const versionRef = useRef(version)
  const mountedRef = useRef(false)
  const operationEpochRef = useRef(0)
  const operationInFlightRef = useRef(false)
  versionRef.current = version
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      operationEpochRef.current += 1
      operationInFlightRef.current = false
    }
  }, [])
  useEffect(() => {
    if (previousVersionIdRef.current === version.id) return
    previousVersionIdRef.current = version.id
    operationEpochRef.current += 1
    operationInFlightRef.current = false
    const nextVersion = versionRef.current
    setTestPayload(nextVersion.variableDefinitions.some((definition) => definition.required) ? null : emptyWorkflowTestPayload())
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

  const beginOperation = () => {
    if (operationInFlightRef.current) return null
    operationInFlightRef.current = true
    operationEpochRef.current += 1
    return operationEpochRef.current
  }
  const isCurrentOperation = (epoch: number) => (
    mountedRef.current && operationEpochRef.current === epoch
  )
  const finishOperation = (epoch: number) => {
    if (!isCurrentOperation(epoch)) return
    operationInFlightRef.current = false
  }
  const cancelOperations = () => {
    operationEpochRef.current += 1
    operationInFlightRef.current = false
  }

  const publishExactVersion = async (existingEpoch?: number) => {
    const epoch = existingEpoch ?? beginOperation()
    if (epoch === null || !isCurrentOperation(epoch)) return
    transition('publish_started')
    setRequestError(null)
    try {
      await requestWorkflowAction(`/api/comfyui/workflows/${encodeURIComponent(workflowId)}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId: version.id }),
      })
    } catch (error) {
      if (!isCurrentOperation(epoch)) return
      setRequestError(safeWorkflowErrorKey(error))
      transition('publish_failed')
      finishOperation(epoch)
      return
    }
    await Promise.resolve(invalidateUserModels(queryClient)).catch(() => undefined)
    if (!isCurrentOperation(epoch)) return
    transition('publish_succeeded')
    await onActivated?.()
    finishOperation(epoch)
  }

  const testAndPublish = async () => {
    if (!connectionId || !testPayload) return
    const epoch = beginOperation()
    if (epoch === null || !isCurrentOperation(epoch)) return
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
      if (!isCurrentOperation(epoch)) return
      setRequestError(safeWorkflowErrorKey(error))
      transition('test_failed')
      finishOperation(epoch)
      return
    }
    if (!isCurrentOperation(epoch)) return
    transition('test_succeeded')
    await publishExactVersion(epoch)
  }

  const busy = activation.busy !== null
  const canTest = version.validation.valid && Boolean(connectionId) && Boolean(testPayload) && !busy
  const canPublish = version.validation.valid && !busy
  const statusKey = activation.status === 'needs_test'
    ? 'needsTest'
    : activation.status === 'ready_to_publish'
      ? 'readyToPublish'
      : activation.status
  const statusText = activation.busy === 'publishing'
    ? t('activation.publishing')
    : activation.busy === 'testing'
      ? t('activation.testing')
      : t(`activation.${statusKey}`)
  const closeActivation = () => {
    cancelOperations()
    onClose()
  }

  return <section aria-labelledby="workflow-activation-heading" aria-busy={busy} className="glass-surface-soft space-y-4 rounded-xl p-4">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 id="workflow-activation-heading" className="font-semibold">{t('activation.title')}</h3>
      </div>
      <button type="button" className="glass-btn-base px-3 py-1.5 text-xs" onClick={closeActivation}>{t('activation.close')}</button>
    </header>

    <p role="status" aria-live="polite" className="text-sm font-medium">{statusText}</p>

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
        definitions={requiredDefinitions}
        onChange={setTestPayload}
        onError={(key) => setRequestError(key)}
      />}

      {activation.error === 'test' && <p role="alert" className="text-sm text-[var(--glass-danger)]">{t('activation.testFailed')}</p>}
      {activation.error === 'publish' && <p role="alert" className="text-sm text-[var(--glass-danger)]">{t('activation.publishFailed')}</p>}
      {requestError && <p className="text-xs text-[var(--glass-text-tertiary)]">{t(requestError)}</p>}

      <div className="flex flex-wrap gap-2">
        {activation.publishRequired
          ? <button type="button" disabled={!canPublish} className="glass-btn-base glass-btn-tone-info px-4 py-2 text-sm disabled:opacity-50" onClick={() => void publishExactVersion()}>
            {activation.error === 'publish' ? t('activation.retryPublish') : t('activation.publish')}
          </button>
          : <button type="button" disabled={!canTest} className="glass-btn-base glass-btn-tone-info px-4 py-2 text-sm disabled:opacity-50" onClick={() => void testAndPublish()}>
            {activation.busy === 'testing' ? t('activation.testing') : t('activation.testAndEnable')}
          </button>}
        {activation.error === 'test' && onEditMappings && <button
          type="button"
          disabled={busy}
          className="glass-btn-base px-4 py-2 text-sm disabled:opacity-50"
          onClick={onEditMappings}
        >
          {t('activation.editMappings')}
        </button>}
      </div>
    </>}
  </section>
}
