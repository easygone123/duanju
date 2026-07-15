'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

import type {
  CanonicalWorkflowInput,
  WorkflowAutoMappingResult,
  WorkflowImportKind,
} from '@/lib/comfyui/workflow-auto-mapping-types'
import WorkflowAdvancedMappingInspector from './WorkflowAdvancedMappingInspector'
import WorkflowAnalysisSummary from './WorkflowAnalysisSummary'
import WorkflowJsonDropzone from './WorkflowJsonDropzone'
import WorkflowManualMappingCorrections from './WorkflowManualMappingCorrections'
import WorkflowMappingQuestions from './WorkflowMappingQuestions'
import WorkflowTypePicker from './WorkflowTypePicker'
import {
  buildGuidedWorkflowReview,
  createWorkflowAnalysisCoordinator,
  isGuidedWorkflowReady,
} from './guided-workflow-creation'
import {
  withManualWorkflowMappings,
  type ManualWorkflowMappings,
} from './manual-workflow-mapping'
import {
  analyzeWorkflowJson,
  type WorkflowAnalysisResponse,
} from './workflow-requests'
import {
  confirmWorkflowAnalysis,
  safeWorkflowAnalysisErrorKey,
  safeWorkflowErrorKey,
  type WorkflowAuthorDraft,
  type WorkflowErrorKey,
} from './workflow-ui'

type WizardStage = 'type' | 'upload' | 'review'
type BusyOperation = 'analyzing' | 'creating' | null
type WorkflowRole = CanonicalWorkflowInput | 'preserve_original'

export interface WorkflowCreationWizardProps {
  onCancel(): void
  onCreate(draft: WorkflowAuthorDraft, creationId: string): Promise<string>
  onCreated(id: string): void | Promise<void>
  analyze?: (
    kind: WorkflowImportKind,
    file: File,
    signal?: AbortSignal,
  ) => Promise<WorkflowAnalysisResponse>
}

const STAGES: WizardStage[] = ['type', 'upload', 'review']

function isAbortError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'AbortError')
}

export default function WorkflowCreationWizard({
  onCancel,
  onCreate,
  onCreated,
  analyze = analyzeWorkflowJson,
}: WorkflowCreationWizardProps) {
  const t = useTranslations('comfyui.workflows.guided')
  const workflows = useTranslations('comfyui.workflows')
  const coordinatorRef = useRef(createWorkflowAnalysisCoordinator())
  const lastFileRef = useRef<File | null>(null)
  const mountedRef = useRef(true)
  const submissionRef = useRef<'idle' | 'creating' | 'completed'>('idle')
  const creationIdRef = useRef<string | null>(null)
  const createdWorkflowIdRef = useRef<string | null>(null)
  const analysisAbortRef = useRef<AbortController | null>(null)
  const stageHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const [stage, setStage] = useState<WizardStage>('type')
  const [kind, setKind] = useState<WorkflowImportKind | null>(null)
  const [name, setName] = useState('')
  const [sourceText, setSourceText] = useState('')
  const [analysis, setAnalysis] = useState<WorkflowAutoMappingResult | null>(null)
  const [roles, setRoles] = useState<Record<string, WorkflowRole>>({})
  const [manualMappings, setManualMappings] = useState<ManualWorkflowMappings>({})
  const [selectedOutput, setSelectedOutput] = useState('')
  const [busy, setBusy] = useState<BusyOperation>(null)
  const [completed, setCompleted] = useState(false)
  const [navigationFailed, setNavigationFailed] = useState(false)
  const [navigationBusy, setNavigationBusy] = useState(false)
  const [error, setError] = useState<WorkflowErrorKey | null>(null)

  useEffect(() => {
    const coordinator = coordinatorRef.current
    coordinator.reset()
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      analysisAbortRef.current?.abort()
      analysisAbortRef.current = null
      coordinator.dispose()
    }
  }, [])

  useEffect(() => {
    stageHeadingRef.current?.focus()
  }, [stage])

  const clearGraphState = () => {
    creationIdRef.current = null
    setSourceText('')
    setAnalysis(null)
    setRoles({})
    setManualMappings({})
    setSelectedOutput('')
    setError(null)
    setBusy(null)
  }

  const runAnalysis = async (file: File, derivedName?: string) => {
    if (!kind) return
    lastFileRef.current = file
    if (derivedName !== undefined) setName(derivedName)
    setSourceText('')
    setAnalysis(null)
    setRoles({})
    setManualMappings({})
    setSelectedOutput('')
    setError(null)
    setBusy('analyzing')
    const ticket = coordinatorRef.current.begin()
    analysisAbortRef.current?.abort()
    const controller = new AbortController()
    analysisAbortRef.current = controller
    try {
      const result = await analyze(kind, file, controller.signal)
      if (!coordinatorRef.current.isCurrent(ticket)) return
      const automaticOutput = result.analysis.outputs.find((output) => output.primary)?.nodeId
        || (result.analysis.outputs.length === 1 ? result.analysis.outputs[0]?.nodeId : '')
      setSourceText(result.sourceText)
      setAnalysis(result.analysis)
      setSelectedOutput(automaticOutput || '')
      setStage('review')
      setError(null)
    } catch (analysisError) {
      if (!coordinatorRef.current.isCurrent(ticket)) return
      if (isAbortError(analysisError)) return
      setSourceText('')
      setAnalysis(null)
      setRoles({})
      setManualMappings({})
      setSelectedOutput('')
      setStage('upload')
      setError(safeWorkflowAnalysisErrorKey(analysisError))
    } finally {
      if (analysisAbortRef.current === controller) analysisAbortRef.current = null
      if (coordinatorRef.current.isCurrent(ticket)) setBusy(null)
    }
  }

  const mappingResolution = useMemo(() => {
    if (!analysis) return { effectiveAnalysis: null, mappingInvalid: false }
    try {
      return {
        effectiveAnalysis: withManualWorkflowMappings(analysis, manualMappings, roles),
        mappingInvalid: false,
      }
    } catch (mappingError) {
      if (!(mappingError instanceof Error) || mappingError.message !== 'workflowManualMappingInvalid') {
        throw mappingError
      }
      return { effectiveAnalysis: analysis, mappingInvalid: true }
    }
  }, [analysis, manualMappings, roles])
  const { effectiveAnalysis, mappingInvalid } = mappingResolution
  const review = useMemo(() => kind && effectiveAnalysis
    ? buildGuidedWorkflowReview(kind, effectiveAnalysis, roles, selectedOutput)
    : null, [effectiveAnalysis, kind, roles, selectedOutput])
  const ready = Boolean(review && isGuidedWorkflowReady({
    name,
    review,
    busy: busy !== null,
  }) && !mappingInvalid && !completed)
  const automaticPrimaryOutputNodeId = analysis?.outputs.find((output) => output.primary)?.nodeId
    || (analysis?.outputs.length === 1 ? analysis.outputs[0]?.nodeId : '')
    || ''

  const navigateToCreatedWorkflow = async (id: string) => {
    if (navigationBusy) return
    setNavigationBusy(true)
    setNavigationFailed(false)
    try {
      await Promise.resolve(onCreated(id))
    } catch {
      if (mountedRef.current) setNavigationFailed(true)
    } finally {
      if (mountedRef.current) setNavigationBusy(false)
    }
  }

  const create = async () => {
    if (!analysis || !effectiveAnalysis || mappingInvalid || !review || !ready || submissionRef.current !== 'idle') return
    submissionRef.current = 'creating'
    setBusy('creating')
    setError(null)
    try {
      const confirmed = confirmWorkflowAnalysis(effectiveAnalysis, {
        roles,
        primaryOutputNodeId: review.primaryOutputNodeId,
      })
      const draft: WorkflowAuthorDraft = {
        name: name.trim(),
        mediaType: analysis.mediaType,
        purpose: analysis.purpose,
        apiFormatJson: sourceText,
        ...confirmed,
      }
      creationIdRef.current ??= crypto.randomUUID()
      const id = await onCreate(draft, creationIdRef.current)
      submissionRef.current = 'completed'
      createdWorkflowIdRef.current = id
      if (mountedRef.current) {
        setCompleted(true)
        setBusy(null)
        await navigateToCreatedWorkflow(id)
      }
    } catch (creationError) {
      submissionRef.current = 'idle'
      if (mountedRef.current) setError(safeWorkflowErrorKey(creationError))
    } finally {
      if (mountedRef.current) setBusy(null)
    }
  }

  const changeRole = (id: string, value: WorkflowRole) => {
    setRoles((current) => ({ ...current, [id]: value }))
    if (value !== 'preserve_original') {
      setManualMappings((current) => {
        if (!current[value]) return current
        const next = { ...current }
        delete next[value]
        return next
      })
    }
  }

  const backToType = () => {
    coordinatorRef.current.begin()
    analysisAbortRef.current?.abort()
    analysisAbortRef.current = null
    lastFileRef.current = null
    clearGraphState()
    setName('')
    setStage('type')
  }
  const backToUpload = () => {
    coordinatorRef.current.begin()
    analysisAbortRef.current?.abort()
    analysisAbortRef.current = null
    clearGraphState()
    setStage('upload')
  }

  const cancel = () => {
    coordinatorRef.current.begin()
    analysisAbortRef.current?.abort()
    analysisAbortRef.current = null
    setBusy(null)
    onCancel()
  }

  return <section aria-labelledby="workflow-wizard-title" className="h-full min-h-0 min-w-0 overflow-hidden">
    <div className="h-full min-w-0 overflow-y-auto overflow-x-hidden">
      <div className="mx-auto w-full max-w-[60rem] min-w-0 px-4 py-6 sm:px-6">
        <header className="min-w-0 space-y-4">
          <div>
            <h2 id="workflow-wizard-title" className="break-words text-xl font-semibold text-[var(--glass-text-primary)]">{t('wizardTitle')}</h2>
            <p className="mt-1 text-sm text-[var(--glass-text-secondary)]">{t('wizardHint')}</p>
          </div>
          <ol className="flex min-w-0 flex-wrap gap-2" aria-label={t('stepsLabel')}>
            {STAGES.map((item, index) => <li
              key={item}
              aria-current={stage === item ? 'step' : undefined}
              className={`glass-badge min-w-0 rounded-full border px-3 py-1 text-xs ${stage === item
                ? 'border-[var(--glass-stroke-focus)] text-[var(--glass-text-primary)]'
                : 'border-[var(--glass-stroke-base)] text-[var(--glass-text-secondary)]'}`}
            >
              <span className="break-words">{index + 1}. {t(`steps.${item}`)}</span>
            </li>)}
          </ol>
        </header>

        <div className="mt-6 min-w-0">
          {stage === 'type' && <section className="min-w-0 space-y-4" aria-labelledby="workflow-wizard-type">
            <h3 ref={stageHeadingRef} tabIndex={-1} id="workflow-wizard-type" className="sr-only">{t('steps.type')}</h3>
            <WorkflowTypePicker value={kind} onSelect={(nextKind) => {
              if (nextKind !== kind) {
                clearGraphState()
                setName('')
                lastFileRef.current = null
              }
              setKind(nextKind)
            }} />
          </section>}

          {stage === 'upload' && <section className="min-w-0 space-y-4" aria-labelledby="workflow-wizard-upload">
            <div>
              <h3 ref={stageHeadingRef} tabIndex={-1} id="workflow-wizard-upload" className="font-semibold">{t('uploadTitle')}</h3>
              <p className="mt-1 text-sm text-[var(--glass-text-secondary)]">{t('uploadHint')}</p>
            </div>
            <WorkflowJsonDropzone
              name={name}
              busy={busy === 'analyzing'}
              allowReplacementWhileBusy
              onNameChange={setName}
              onFile={(file, derivedName) => { void runAnalysis(file, derivedName) }}
            />
          </section>}

          {stage === 'review' && analysis && review && <section className="min-w-0 space-y-6" aria-labelledby="workflow-wizard-review">
            <div>
              <h3 ref={stageHeadingRef} tabIndex={-1} id="workflow-wizard-review" className="font-semibold">{t('reviewTitle')}</h3>
              <p className="mt-1 text-sm text-[var(--glass-text-secondary)]">{t('reviewHint')}</p>
            </div>
            <label className="block min-w-0 text-sm text-[var(--glass-text-secondary)]">
              <span>{t('name')}</span>
              <input
                type="text"
                value={name}
                maxLength={160}
                disabled={busy === 'creating' || completed}
                onChange={(event) => setName(event.target.value)}
                className="glass-input mt-1 w-full min-w-0 px-3 py-2"
              />
            </label>
            <WorkflowAnalysisSummary
              review={review}
              outputCount={analysis.outputs.length}
              automaticPrimaryOutputNodeId={automaticPrimaryOutputNodeId}
            />
            {mappingInvalid && <p role="alert" className="break-words text-sm text-[var(--glass-tone-danger-fg)]">
              {t('manualCorrectionInvalid')}
            </p>}
            <WorkflowManualMappingCorrections
              analysis={analysis}
              missingRequiredInputs={review.missingRequiredInputs}
              value={manualMappings}
              disabled={busy === 'creating' || completed}
              onChange={setManualMappings}
            />
            <WorkflowMappingQuestions
              analysis={analysis}
              review={review}
              roles={roles}
              primaryOutputNodeId={selectedOutput}
              disabled={busy === 'creating' || completed}
              onRoleChange={changeRole}
              onPrimaryOutputChange={setSelectedOutput}
            />
            <WorkflowAdvancedMappingInspector
              analysis={analysis}
              roles={roles}
              primaryOutputNodeId={selectedOutput}
              disabled={busy === 'creating' || completed}
              onRoleChange={changeRole}
              onPrimaryOutputChange={setSelectedOutput}
            />
          </section>}
        </div>

        <div className="mt-6 min-h-6 min-w-0">
          {error && <p role="alert" className="break-words text-sm text-[var(--glass-tone-danger-fg)]">
            {workflows(error)}
          </p>}
          <p role="status" className="break-words text-sm text-[var(--glass-text-secondary)]">
            {busy === 'analyzing'
              ? t('analyzingStatus')
              : busy === 'creating'
                ? t('creatingStatus')
                : completed ? t('completedStatus') : ''}
          </p>
        </div>

        <footer className="mt-4 flex min-w-0 flex-wrap items-center justify-between gap-3 border-t border-[var(--glass-stroke-base)] pt-4">
          <button type="button" onClick={cancel} disabled={busy === 'creating' || completed} className="glass-btn-base px-4 py-2 text-sm disabled:opacity-50">
            {t('cancel')}
          </button>
          <div className="flex min-w-0 flex-wrap justify-end gap-2">
            {stage === 'type' && <button
              type="button"
              disabled={!kind}
              onClick={() => setStage('upload')}
              className="glass-btn-base glass-btn-tone-info px-4 py-2 text-sm disabled:opacity-50"
            >{t('next')}</button>}
            {stage === 'upload' && <>
              <button type="button" onClick={backToType} className="glass-btn-base px-4 py-2 text-sm">{t('back')}</button>
              {error && lastFileRef.current && <button
                type="button"
                disabled={busy === 'analyzing'}
                onClick={() => { if (lastFileRef.current) void runAnalysis(lastFileRef.current) }}
                className="glass-btn-base glass-btn-tone-info px-4 py-2 text-sm disabled:opacity-50"
              >{t('retryAnalysis')}</button>}
            </>}
            {stage === 'review' && <>
              <button type="button" disabled={busy === 'creating' || completed} onClick={backToUpload} className="glass-btn-base px-4 py-2 text-sm disabled:opacity-50">{t('back')}</button>
              <button
                type="button"
                disabled={!ready}
                onClick={() => { void create() }}
                className="glass-btn-base glass-btn-tone-info px-4 py-2 text-sm disabled:opacity-50"
              >{error ? t('retryCreate') : t('create')}</button>
              {completed && navigationFailed && <button
                type="button"
                disabled={navigationBusy}
                onClick={() => {
                  if (createdWorkflowIdRef.current) {
                    void navigateToCreatedWorkflow(createdWorkflowIdRef.current)
                  }
                }}
                className="glass-btn-base glass-btn-tone-info px-4 py-2 text-sm disabled:opacity-50"
              >{t('returnToLibrary')}</button>}
            </>}
          </div>
        </footer>
      </div>
    </div>
  </section>
}
