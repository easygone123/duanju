'use client'

import { useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

import WorkflowActivationPanel from './WorkflowActivationPanel'
import WorkflowAnalysisSummary from './WorkflowAnalysisSummary'
import WorkflowGuidedMappingEditor from './WorkflowGuidedMappingEditor'
import WorkflowMappingQuestions from './WorkflowMappingQuestions'
import {
  buildGuidedWorkflowReview,
  isGuidedWorkflowReady,
} from './guided-workflow-creation'
import {
  effectiveGuidedAnalysis,
  guidedMappingDraftIssues,
  setGuidedPrimaryOutput,
  updateGuidedInputRole,
  type GuidedWorkflowMappingDraft,
} from './guided-workflow-mapping-draft'
import {
  buildEditedWorkflowDraft,
  createGuidedMappingDraftFromAuthorDraft,
  workflowImportKindForDraft,
} from './guided-workflow-edit'
import {
  safeWorkflowErrorKey,
  type WorkflowAuthorDraft,
  type WorkflowErrorKey,
  type WorkflowVersionView,
} from './workflow-ui'

interface Props {
  workflowId: string
  initialDraft: WorkflowAuthorDraft
  onCancel(): void
  onPrepareTest(draft: WorkflowAuthorDraft): Promise<WorkflowVersionView>
  onPublished(): void | Promise<void>
}

export default function WorkflowEditWizard({
  workflowId,
  initialDraft,
  onCancel,
  onPrepareTest,
  onPublished,
}: Props) {
  const t = useTranslations('comfyui.workflows.guided')
  const workflows = useTranslations('comfyui.workflows')
  const initialMappingDraftRef = useRef<GuidedWorkflowMappingDraft | null>(null)
  const initialMappingDraft = initialMappingDraftRef.current
    ?? createGuidedMappingDraftFromAuthorDraft(initialDraft)
  initialMappingDraftRef.current = initialMappingDraft
  const [name, setName] = useState(initialDraft.name)
  const [mappingDraft, setMappingDraft] = useState<GuidedWorkflowMappingDraft>(initialMappingDraft)
  const [preparedVersion, setPreparedVersion] = useState<WorkflowVersionView | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<WorkflowErrorKey | null>(null)
  const preparationInFlightRef = useRef(false)
  const kind = workflowImportKindForDraft(initialDraft)
  const analysis = useMemo(() => effectiveGuidedAnalysis(mappingDraft), [mappingDraft])
  const mappingIssues = useMemo(() => guidedMappingDraftIssues(mappingDraft), [mappingDraft])
  const selectedOutput = mappingDraft.outputs.find((output) => output.primary)?.nodeId || ''
  const review = useMemo(() => buildGuidedWorkflowReview(
    kind,
    analysis,
    {},
    selectedOutput,
  ), [analysis, kind, selectedOutput])
  const ready = isGuidedWorkflowReady({ name, review, busy: preparing })
    && mappingIssues.length === 0
  const automaticPrimaryOutputNodeId = initialMappingDraft.outputs
    .find((output) => output.primary)?.nodeId || ''

  const prepareTest = async () => {
    if (!ready || preparationInFlightRef.current) return
    preparationInFlightRef.current = true
    setPreparing(true)
    setError(null)
    try {
      const draft = buildEditedWorkflowDraft(initialDraft, name, mappingDraft)
      const version = await onPrepareTest(draft)
      setPreparedVersion(version)
    } catch (prepareError) {
      setError(safeWorkflowErrorKey(prepareError))
    } finally {
      preparationInFlightRef.current = false
      setPreparing(false)
    }
  }

  const returnToEdit = () => {
    setPreparedVersion(null)
    setError(null)
  }

  const changePrimaryOutput = (nodeId: string) => {
    const index = mappingDraft.outputs.findIndex((output) => output.nodeId === nodeId)
    if (index >= 0) setMappingDraft(setGuidedPrimaryOutput(mappingDraft, index))
  }

  return <section aria-labelledby="workflow-edit-wizard-title" className="h-full min-h-0 min-w-0 overflow-hidden">
    <div className="h-full min-w-0 overflow-y-auto overflow-x-hidden">
      <div className="mx-auto w-full max-w-[60rem] min-w-0 px-4 py-6 sm:px-6">
        <header className="min-w-0 space-y-4">
          <div>
            <h2 id="workflow-edit-wizard-title" className="break-words text-xl font-semibold text-[var(--glass-text-primary)]">
              {t('editTitle')}
            </h2>
            <p className="mt-1 text-sm text-[var(--glass-text-secondary)]">{t('editHint')}</p>
          </div>
          <ol className="flex min-w-0 flex-wrap gap-2" aria-label={t('editStepsLabel')}>
            {(['review', 'test'] as const).map((step, index) => <li
              key={step}
              aria-current={(preparedVersion ? 'test' : 'review') === step ? 'step' : undefined}
              className={`glass-badge min-w-0 rounded-full border px-3 py-1 text-xs ${(preparedVersion ? 'test' : 'review') === step
                ? 'border-[var(--glass-stroke-focus)] text-[var(--glass-text-primary)]'
                : 'border-[var(--glass-stroke-base)] text-[var(--glass-text-secondary)]'}`}
            >{index + 1}. {t(`editSteps.${step}`)}</li>)}
          </ol>
        </header>

        {!preparedVersion ? <section className="mt-6 min-w-0 space-y-6" aria-labelledby="workflow-edit-review-title">
          <div>
            <h3 id="workflow-edit-review-title" className="font-semibold">{t('editReviewTitle')}</h3>
            <p className="mt-1 text-sm text-[var(--glass-text-secondary)]">{t('editReviewHint')}</p>
          </div>
          <label className="block min-w-0 text-sm text-[var(--glass-text-secondary)]">
            <span>{t('name')}</span>
            <input
              type="text"
              value={name}
              maxLength={160}
              disabled={preparing}
              onChange={(event) => {
                setName(event.target.value)
                setError(null)
              }}
              className="glass-input mt-1 w-full min-w-0 px-3 py-2"
            />
          </label>
          <WorkflowAnalysisSummary
            review={review}
            outputCount={mappingDraft.outputs.length}
            automaticPrimaryOutputNodeId={automaticPrimaryOutputNodeId}
          />
          <WorkflowMappingQuestions
            analysis={analysis}
            review={review}
            roles={{}}
            primaryOutputNodeId={selectedOutput}
            disabled={preparing}
            onRoleChange={(id, role) => setMappingDraft(updateGuidedInputRole(mappingDraft, id, role))}
            onPrimaryOutputChange={changePrimaryOutput}
          />
          <WorkflowGuidedMappingEditor
            value={mappingDraft}
            disabled={preparing}
            onChange={(next) => {
              setMappingDraft(next)
              setError(null)
            }}
          />
        </section> : <div className="mt-6">
          <WorkflowActivationPanel
            key={preparedVersion.id}
            workflowId={workflowId}
            mediaType={initialDraft.mediaType}
            version={preparedVersion}
            onClose={returnToEdit}
            onEditMappings={returnToEdit}
            onActivated={onPublished}
          />
        </div>}

        <div className="mt-6 min-h-6 min-w-0">
          {error && <p role="alert" className="break-words text-sm text-[var(--glass-tone-danger-fg)]">
            {workflows(error)}
          </p>}
          <p role="status" className="break-words text-sm text-[var(--glass-text-secondary)]">
            {preparing ? t('preparingTestStatus') : ''}
          </p>
        </div>

        {!preparedVersion && <footer className="mt-4 flex min-w-0 flex-wrap items-center justify-between gap-3 border-t border-[var(--glass-stroke-base)] pt-4">
          <button type="button" onClick={onCancel} disabled={preparing} className="glass-btn-base px-4 py-2 text-sm disabled:opacity-50">
            {t('cancel')}
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={() => { void prepareTest() }}
            className="glass-btn-base glass-btn-tone-info px-4 py-2 text-sm disabled:opacity-50"
          >{error ? t('retryPrepareTest') : t('continueToTest')}</button>
        </footer>}
      </div>
    </div>
  </section>
}
