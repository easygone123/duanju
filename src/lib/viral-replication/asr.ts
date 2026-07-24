import OpenAI, { toFile } from 'openai'

import { offsetViralAudioTranscript } from './audio-timeline'

export type ViralAsrResult =
  | { configured: false }
  | { configured: true; transcriptText: string | null }

type ViralAsrEnvironment = {
  VIRAL_ASR_BASE_URL?: string
  VIRAL_ASR_API_KEY?: string
  VIRAL_ASR_MODEL?: string
}

function readConfiguredValue(value: string | undefined): string | null {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

function currentViralAsrEnvironment(): ViralAsrEnvironment {
  return {
    VIRAL_ASR_BASE_URL: process.env.VIRAL_ASR_BASE_URL,
    VIRAL_ASR_API_KEY: process.env.VIRAL_ASR_API_KEY,
    VIRAL_ASR_MODEL: process.env.VIRAL_ASR_MODEL,
  }
}

export function viralAsrIsConfigured(
  environment: ViralAsrEnvironment = currentViralAsrEnvironment(),
): boolean {
  return Boolean(
    readConfiguredValue(environment.VIRAL_ASR_BASE_URL)
    && readConfiguredValue(environment.VIRAL_ASR_API_KEY)
    && readConfiguredValue(environment.VIRAL_ASR_MODEL),
  )
}

export async function transcribeViralAudioWithConfiguredAsr(input: {
  audioBytes: Buffer
  durationMs: number
  offsetMs: number
  environment?: ViralAsrEnvironment
}): Promise<ViralAsrResult> {
  const environment = input.environment ?? currentViralAsrEnvironment()
  const baseURL = readConfiguredValue(environment.VIRAL_ASR_BASE_URL)
  const apiKey = readConfiguredValue(environment.VIRAL_ASR_API_KEY)
  const model = readConfiguredValue(environment.VIRAL_ASR_MODEL)
  if (!baseURL || !apiKey || !model) return { configured: false }

  const client = new OpenAI({ baseURL, apiKey })
  const transcript = await client.audio.transcriptions.create({
    file: await toFile(input.audioBytes, 'viral-source.mp3', { type: 'audio/mpeg' }),
    model,
    response_format: 'srt',
    temperature: 0,
  })
  if (typeof transcript !== 'string') {
    throw new Error('VIRAL_ASR_RESPONSE_INVALID')
  }
  return {
    configured: true,
    transcriptText: offsetViralAudioTranscript(
      transcript,
      input.offsetMs,
      input.durationMs,
    ),
  }
}
