import type { ViralReplicationClientStatus } from './client'
import { parseViralAnalysisReport, type ViralAnalysisReportV1 } from './contracts'

export type ViralReplicationViewState = {
  kind: ViralReplicationClientStatus
  subscribeToSse: boolean
  editable: boolean
}

const VIEW_STATES: Record<ViralReplicationClientStatus, ViralReplicationViewState> = {
  uploading: { kind: 'uploading', subscribeToSse: false, editable: false },
  analyzing: { kind: 'analyzing', subscribeToSse: true, editable: false },
  review_ready: { kind: 'review_ready', subscribeToSse: false, editable: true },
  generating: { kind: 'generating', subscribeToSse: true, editable: false },
  completed: { kind: 'completed', subscribeToSse: false, editable: false },
  failed: { kind: 'failed', subscribeToSse: false, editable: false },
}

export function resolveViralReplicationViewState(
  status: ViralReplicationClientStatus,
): ViralReplicationViewState {
  return VIEW_STATES[status]
}

export function parseViralAnalysisReportForView(
  reportJson: unknown,
  durationMs: number | null | undefined,
): ViralAnalysisReportV1 | null {
  if (!durationMs) return null
  try {
    return parseViralAnalysisReport(reportJson, durationMs)
  } catch {
    return null
  }
}
