'use client'

import { useTranslations } from 'next-intl'
import type { TaskPresentationState } from '@/lib/task/presentation'
import { AppIcon } from '@/components/ui/icons'

type TaskStatusOverlayProps = {
  state: TaskPresentationState | null
  className?: string
  diagnostics?: ComfyTaskDiagnostics | null
}

export interface ComfyTaskDiagnostics {
  stage: 'waiting_capacity' | 'executing' | 'transferring'
  capacityWaitMs?: number
  executionMs?: number
  transferMs?: number
  instanceId?: string | null
  workflowId?: string | null
  workflowVersion?: number | null
  currentNodeId?: string | null
  promptId?: string | null
}

export function sanitizeComfyDiagnosticId(value: string | null | undefined): string | null {
  if (!value || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) return null
  return value
}

function formatDuration(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${(value / 1000).toFixed(1)}s` : null
}

export default function TaskStatusOverlay({ state, className, diagnostics }: TaskStatusOverlayProps) {
  const t = useTranslations('common')
  const tc = useTranslations('comfyui.workflows')
  if (!state) return null
  if (state.mode !== 'overlay' && state.mode !== 'placeholder') return null
  const label = state.labelKey ? t(state.labelKey) : t('loading')
  const stage = diagnostics?.stage
  const diagnosticIds = diagnostics ? [
    ['instance', sanitizeComfyDiagnosticId(diagnostics.instanceId)],
    ['workflow', sanitizeComfyDiagnosticId(diagnostics.workflowId)],
    ['node', sanitizeComfyDiagnosticId(diagnostics.currentNodeId)],
    ['prompt', sanitizeComfyDiagnosticId(diagnostics.promptId)],
  ].filter((item): item is [string, string] => !!item[1]) : []

  return (
    <div
      className={[
        'absolute inset-0 flex flex-col items-center justify-center',
        'bg-[var(--glass-overlay)]',
        className || '',
      ].join(' ').trim()}
    >
      {state.isError ? (
        <AppIcon name="alertSolid" className="h-7 w-7 text-[var(--glass-tone-danger-fg)]" />
      ) : (
        <AppIcon name="loader" className="h-7 w-7 animate-spin text-white" />
      )}
      <span className="mt-2 text-xs text-white">{label}</span>
      {stage && <div role="status" aria-live="polite" className="mt-2 max-w-[90%] rounded-lg bg-black/30 px-3 py-2 text-center text-[10px] text-white">
        <p>{stage === 'waiting_capacity' ? tc('capacityWaiting') : stage === 'transferring' ? tc('transferring') : tc('executing')}</p>
        <p>{[
          formatDuration(diagnostics?.capacityWaitMs) && `${tc('capacityWait')}: ${formatDuration(diagnostics?.capacityWaitMs)}`,
          formatDuration(diagnostics?.executionMs) && `${tc('executionTime')}: ${formatDuration(diagnostics?.executionMs)}`,
          formatDuration(diagnostics?.transferMs) && `${tc('transferTime')}: ${formatDuration(diagnostics?.transferMs)}`,
        ].filter(Boolean).join(' · ')}</p>
        {diagnosticIds.length > 0 && <p className="mt-1 break-all">{diagnosticIds.map(([key, value]) => `${tc(`diagnostics.${key}`)}: ${value}`).join(' · ')}{diagnostics?.workflowVersion ? ` · v${diagnostics.workflowVersion}` : ''}</p>}
      </div>}
    </div>
  )
}
