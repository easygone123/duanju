import { describe, expect, it } from 'vitest'

import {
  buildViralReportAggregationPrompt,
  buildViralShotAnalysisPrompt,
} from '@/lib/viral-replication/prompts'

const analyzedShot = {
  shotIndex: 0,
  startMs: 0,
  endMs: 1_000,
  shotType: 'close-up',
  cameraAngle: 'eye-level',
  cameraMove: 'static',
  composition: 'centered',
  actionBeat: 'reveal',
  transition: 'cut',
  subtitleSummary: null,
  narrativeFunction: 'hook',
}

describe('viral replication prompt boundaries', () => {
  it('delimits untrusted brief/subtitles and truncates transcript context', () => {
    const prompt = buildViralShotAnalysisPrompt({
      locale: 'en',
      brief: 'Original brief',
      videoMetadata: { durationMs: 1_000 },
      shots: [{
        shotIndex: 0,
        startMs: 0,
        endMs: 1_000,
        representativeMs: 500,
        framePath: '/tmp/frame.jpg',
      }],
      subtitleContext: `${'x'.repeat(60_000)}SHOULD_BE_TRUNCATED`,
    })

    expect(prompt).toContain('<<<BEGIN_UNTRUSTED_BRIEF>>>')
    expect(prompt).toContain('<<<END_UNTRUSTED_BRIEF>>>')
    expect(prompt).toContain('<<<BEGIN_UNTRUSTED_SUBTITLE_CONTEXT>>>')
    expect(prompt).toContain('[TRUNCATED]')
    expect(prompt).not.toContain('SHOULD_BE_TRUNCATED')
    expect(prompt.length).toBeLessThanOrEqual(100_000)
  })

  it('delimits model-derived aggregation input and rejects an oversized total prompt', () => {
    const normal = buildViralReportAggregationPrompt({
      locale: 'en',
      brief: 'Original brief',
      durationMs: 1_000,
      batchResults: [{ shots: [analyzedShot] }],
    })
    expect(normal).toContain('<<<BEGIN_UNTRUSTED_BATCH_RESULTS>>>')
    expect(normal).toContain('<<<END_UNTRUSTED_BATCH_RESULTS>>>')

    expect(() => buildViralReportAggregationPrompt({
      locale: 'en',
      brief: 'Original brief',
      durationMs: 1_000,
      batchResults: [{ shots: [{ ...analyzedShot, composition: 'x'.repeat(600_000) }] }],
    })).toThrow(/prompt.*length/i)
  })
})
