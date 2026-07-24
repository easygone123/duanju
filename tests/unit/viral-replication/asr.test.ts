import { describe, expect, it } from 'vitest'

import {
  transcribeViralAudioWithConfiguredAsr,
  viralAsrIsConfigured,
} from '@/lib/viral-replication/asr'

describe('viral replication external ASR', () => {
  it('requires a complete OpenAI-compatible ASR configuration', () => {
    expect(viralAsrIsConfigured({})).toBe(false)
    expect(viralAsrIsConfigured({
      VIRAL_ASR_BASE_URL: 'https://asr.example/v1',
      VIRAL_ASR_API_KEY: 'secret',
    })).toBe(false)
    expect(viralAsrIsConfigured({
      VIRAL_ASR_BASE_URL: 'https://asr.example/v1',
      VIRAL_ASR_API_KEY: 'secret',
      VIRAL_ASR_MODEL: 'whisper-1',
    })).toBe(true)
  })

  it('returns an explicit unconfigured result without making a request', async () => {
    await expect(transcribeViralAudioWithConfiguredAsr({
      audioBytes: Buffer.from('audio'),
      durationMs: 1_000,
      offsetMs: 0,
      environment: {},
    })).resolves.toEqual({ configured: false })
  })
})
