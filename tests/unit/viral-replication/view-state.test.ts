import { describe, expect, it } from 'vitest'

import {
  parseViralAnalysisReportForView,
  resolveViralReplicationViewState,
} from '@/lib/viral-replication/view-state'

const validReport = {
  schemaVersion: 1,
  overview: {
    hook: 'Immediate conflict',
    coreAppeal: 'A satisfying reversal',
    pacing: 'Fast opening, measured payoff',
    emotionalArc: 'Tension to relief',
  },
  styleFingerprint: {
    composition: ['centered close-ups'],
    lighting: ['high contrast'],
    color: ['warm highlights'],
    editing: ['hard cuts'],
  },
  shots: [{
    shotIndex: 0,
    startMs: 0,
    endMs: 1_000,
    shotType: 'close-up',
    cameraAngle: 'eye-level',
    cameraMove: 'static',
    composition: 'subject centered',
    actionBeat: 'hero opens the door',
    transition: 'cut',
    subtitleSummary: 'You came back.',
    narrativeFunction: 'hook',
  }],
  originalAdaptationAdvice: ['Keep the conflict, replace the setting.'],
}

describe('viral replication view state', () => {
  it.each([
    ['uploading', 'uploading', false, false],
    ['analyzing', 'analyzing', true, false],
    ['review_ready', 'review_ready', false, true],
    ['generating', 'generating', true, false],
    ['completed', 'completed', false, false],
    ['failed', 'failed', false, false],
  ] as const)('maps %s to its complete render contract', (status, kind, subscribeToSse, editable) => {
    expect(resolveViralReplicationViewState(status)).toEqual({ kind, subscribeToSse, editable })
  })

  it('returns report data only after the V1 parser accepts it', () => {
    expect(parseViralAnalysisReportForView(validReport, 1_000)).toEqual(validReport)
    expect(parseViralAnalysisReportForView({ ...validReport, schemaVersion: 2 }, 1_000)).toBeNull()
    expect(parseViralAnalysisReportForView(validReport, null)).toBeNull()
  })
})
