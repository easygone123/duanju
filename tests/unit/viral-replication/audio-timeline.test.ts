import { describe, expect, it } from 'vitest'

import {
  audioTextForRange,
  parseViralAudioCues,
} from '@/lib/viral-replication/audio-timeline'

describe('viral source audio timeline', () => {
  it('parses SRT cues and keeps their original wording and timing', () => {
    const cues = parseViralAudioCues([
      '1',
      '00:00:00,250 --> 00:00:01,500',
      '第一句原声',
      '',
      '2',
      '00:00:01,500 --> 00:00:03,000',
      '<i>第二句原声</i>',
    ].join('\n'))

    expect(cues).toEqual([
      { startMs: 250, endMs: 1_500, text: '第一句原声' },
      { startMs: 1_500, endMs: 3_000, text: '第二句原声' },
    ])
    expect(audioTextForRange(cues, 1_000, 2_000)).toBe('第一句原声\n第二句原声')
  })

  it('returns no cues for missing or malformed transcript content', () => {
    expect(parseViralAudioCues(null)).toEqual([])
    expect(parseViralAudioCues('plain text without timestamps')).toEqual([])
  })
})
