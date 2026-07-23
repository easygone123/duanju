import { describe, expect, it } from 'vitest'

import { isComfyPromptAbsenceConclusive } from '@/lib/comfyui/reconciliation-timing'

describe('ComfyUI reconciliation timing', () => {
  it('uses stable external activity instead of heartbeat-updated timestamps', () => {
    const request = {
      createdAt: new Date(1_000),
      submittingAt: new Date(2_000),
      submittedAt: new Date(3_000),
      runningAt: new Date(4_000),
      transferringAt: null,
      // This field intentionally is not part of the helper contract. A lease
      // heartbeat may keep changing it without proving any ComfyUI activity.
      updatedAt: new Date(99_000),
      reconcilingAt: new Date(99_000),
    }

    expect(isComfyPromptAbsenceConclusive(request, 10_000, 14_000)).toBe(true)
  })

  it('keeps a recently active prompt in reconciliation during the grace period', () => {
    expect(isComfyPromptAbsenceConclusive({
      createdAt: new Date(1_000),
      submittedAt: new Date(8_000),
      runningAt: new Date(12_000),
    }, 10_000, 21_999)).toBe(false)
  })
})
