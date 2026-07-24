import { describe, expect, it } from 'vitest'

import {
  audioTextForRange,
  chunkViralAudioRanges,
  findViralTranscriptGaps,
  mergeViralAudioTranscripts,
  offsetViralAudioTranscript,
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

  it('does not treat short natural pauses as missing transcript ranges', () => {
    const transcript = [
      '1',
      '00:00:00,500 --> 00:00:03,000',
      '开场',
      '',
      '2',
      '00:00:06,000 --> 00:00:10,000',
      '结尾',
    ].join('\n')

    expect(findViralTranscriptGaps(transcript, 12_000)).toEqual([])
  })

  it('finds only material timeline holes and chunks long holes for bounded ASR', () => {
    const transcript = [
      '1',
      '00:00:00,000 --> 00:00:05,000',
      '已有字幕',
      '',
      '2',
      '00:00:45,000 --> 00:00:50,000',
      '恢复字幕',
    ].join('\n')
    const gaps = findViralTranscriptGaps(transcript, 60_000)

    expect(gaps).toEqual([
      { startMs: 5_000, endMs: 45_000 },
      { startMs: 50_000, endMs: 60_000 },
    ])
    expect(chunkViralAudioRanges(gaps)).toEqual([
      { startMs: 5_000, endMs: 35_000 },
      { startMs: 35_000, endMs: 45_000 },
      { startMs: 50_000, endMs: 60_000 },
    ])
  })

  it('keeps embedded cues authoritative while filling non-overlapping ASR gaps', () => {
    const primary = [
      '1',
      '00:00:00,000 --> 00:00:04,000',
      '内嵌字幕',
    ].join('\n')
    const supplemental = [
      '1',
      '00:00:01,000 --> 00:00:03,000',
      '音频冲突文字',
      '',
      '2',
      '00:00:06,000 --> 00:00:08,000',
      '音频补齐文字',
    ].join('\n')

    const merged = mergeViralAudioTranscripts({
      primaryTranscript: primary,
      supplementalTranscripts: [supplemental],
      durationMs: 10_000,
    })

    expect(merged).toContain('内嵌字幕')
    expect(merged).toContain('音频补齐文字')
    expect(merged).not.toContain('音频冲突文字')
  })

  it('offsets timestamps returned by an external ASR segment', () => {
    const shifted = offsetViralAudioTranscript([
      '1',
      '00:00:00,250 --> 00:00:01,500',
      '分段识别结果',
    ].join('\n'), 30_000, 10_000)

    expect(shifted).toContain('00:00:30,250 --> 00:00:31,500')
    expect(shifted).toContain('分段识别结果')
  })
})
