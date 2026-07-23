export interface ComfyPromptActivityTimestamps {
  createdAt: Date
  submittingAt?: Date | null
  submittedAt?: Date | null
  runningAt?: Date | null
  transferringAt?: Date | null
}

/**
 * Decide whether a prompt that is absent from both queue and history has been
 * missing for long enough to fail reconciliation.
 *
 * Lease heartbeats update ComfyGenerationRequest.updatedAt, so updatedAt must
 * never be used as the absence clock. Otherwise the recovery heartbeat keeps
 * the request alive forever while also reserving the only ComfyUI connection.
 */
export function isComfyPromptAbsenceConclusive(
  request: ComfyPromptActivityTimestamps,
  timeoutMs: number,
  nowMs: number = Date.now(),
) {
  const stableActivityTimes = [
    request.createdAt,
    request.submittingAt,
    request.submittedAt,
    request.runningAt,
    request.transferringAt,
  ].flatMap((value) => value instanceof Date && Number.isFinite(value.getTime())
    ? [value.getTime()]
    : [])
  const lastExternalActivityAt = Math.max(...stableActivityTimes)
  return Number.isFinite(timeoutMs)
    && timeoutMs >= 0
    && Number.isFinite(nowMs)
    && nowMs - lastExternalActivityAt >= timeoutMs
}
