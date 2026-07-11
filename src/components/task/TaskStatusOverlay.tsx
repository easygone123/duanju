'use client'

import { useTranslations } from 'next-intl'
import type { TaskPresentationState } from '@/lib/task/presentation'
import { AppIcon } from '@/components/ui/icons'
import type { ComfyTaskDiagnostics } from '@/lib/task/state-service'

type TaskStatusOverlayProps = {
  state: TaskPresentationState | null
  className?: string
  diagnostics?: ComfyTaskDiagnostics | null
}

export type { ComfyTaskDiagnostics } from '@/lib/task/state-service'

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
  const details = diagnostics ?? state.comfyDiagnostics
  const stage = details?.stage
  const diagnosticIds = details ? [
    ['instance', sanitizeComfyDiagnosticId(details.connectionId)],
    ['workflow', sanitizeComfyDiagnosticId(details.workflowId)],
    ['version', sanitizeComfyDiagnosticId(details.workflowVersionId)],
    ['prompt', sanitizeComfyDiagnosticId(details.promptId)],
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
          formatDuration(details?.capacityWaitMs ?? undefined) && `${tc('capacityWait')}: ${formatDuration(details?.capacityWaitMs ?? undefined)}`,
          formatDuration(details?.executionMs ?? undefined) && `${tc('executionTime')}: ${formatDuration(details?.executionMs ?? undefined)}`,
          formatDuration(details?.transferMs ?? undefined) && `${tc('transferTime')}: ${formatDuration(details?.transferMs ?? undefined)}`,
        ].filter(Boolean).join(' · ')}</p>
        {diagnosticIds.length > 0 && <p className="mt-1 break-all">{diagnosticIds.map(([key, value]) => `${tc(`diagnostics.${key}`)}: ${value}`).join(' · ')}</p>}
      </div>}
    </div>
  )
}
