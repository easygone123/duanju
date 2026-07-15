import { describe, expect, it } from 'vitest'

import { buildPrompt, PROMPT_IDS } from '@/lib/prompt-i18n'

describe('prompt renderer single-pass substitution', () => {
  it('keeps a later placeholder token literal when it came from an earlier variable value', () => {
    const prompt = buildPrompt({
      promptId: PROMPT_IDS.VIRAL_SHOT_ANALYSIS,
      locale: 'en',
      variables: {
        brief: 'Keep this token literal: {subtitle_context}',
        video_metadata: '{}',
        shot_timeline: '[]',
        subtitle_context: 'PRIVATE_SUBTITLE_VALUE',
      },
    })

    expect(prompt).toContain('Keep this token literal: {subtitle_context}')
    expect(prompt.match(/PRIVATE_SUBTITLE_VALUE/g)).toHaveLength(1)
  })

  it('does not expand a batch placeholder embedded in the brief', () => {
    const prompt = buildPrompt({
      promptId: PROMPT_IDS.VIRAL_REPORT_AGGREGATION,
      locale: 'en',
      variables: {
        brief: 'Literal marker: {batch_results_json}',
        duration_ms: '3000',
        batch_results_json: 'PRIVATE_BATCH_VALUE',
        report_schema_json: '{}',
      },
    })

    expect(prompt).toContain('Literal marker: {batch_results_json}')
    expect(prompt.match(/PRIVATE_BATCH_VALUE/g)).toHaveLength(1)
  })
})
