export const VIRAL_TRANSCRIPTION_MODES = ['auto', 'full_audio'] as const

export type ViralTranscriptionMode = (typeof VIRAL_TRANSCRIPTION_MODES)[number]

export function isViralTranscriptionMode(value: unknown): value is ViralTranscriptionMode {
  return typeof value === 'string'
    && (VIRAL_TRANSCRIPTION_MODES as readonly string[]).includes(value)
}
