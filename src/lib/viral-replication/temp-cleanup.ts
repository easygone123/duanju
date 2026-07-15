import { createScopedLogger } from '@/lib/logging/core'

const logger = createScopedLogger({ module: 'viral-replication.upload' })

type CleanupOutcome = 'primary_failure' | 'committed'

export type UploadTempCleanupWarning = {
  action: 'viral.upload.temp_cleanup_failed'
  message: 'viral upload temp file cleanup failed'
  details: {
    replicationId: string
    outcome: CleanupOutcome
  }
  error: {
    name: string
    message: string
    code?: string
  }
}

type CleanupWarningReporter = (warning: UploadTempCleanupWarning) => void | Promise<void>

function safeError(error: unknown): UploadTempCleanupWarning['error'] {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code
    return {
      name: error.name,
      message: error.message,
      ...(typeof code === 'string' ? { code } : {}),
    }
  }
  return { name: 'Error', message: String(error) }
}

const defaultReporter: CleanupWarningReporter = (warning) => {
  logger.event({
    level: 'WARN',
    action: warning.action,
    message: warning.message,
    details: warning.details,
    error: warning.error,
  })
}

export async function cleanupUploadTempFile(
  cleanup: () => Promise<void>,
  preserveExistingOutcome: boolean,
  options?: {
    reporter?: CleanupWarningReporter
    context?: { replicationId: string; outcome: CleanupOutcome }
  },
): Promise<void> {
  try {
    await cleanup()
  } catch (error: unknown) {
    if (!preserveExistingOutcome) throw error
    if (!options?.context) return
    const warning: UploadTempCleanupWarning = {
      action: 'viral.upload.temp_cleanup_failed',
      message: 'viral upload temp file cleanup failed',
      details: options.context,
      error: safeError(error),
    }
    try {
      await (options.reporter ?? defaultReporter)(warning)
    } catch {
      // Reporting is best-effort and must never replace the preserved outcome.
    }
  }
}
