import { describe, expect, it, vi } from 'vitest'
import { cancelAcceptedPromptSafely } from '@/lib/comfyui/runtime-execution-adapter'

function fixture(queues: Array<{ running: unknown[]; pending: unknown[] }>) {
  return {
    promptId: 'owned-prompt',
    getQueue: vi.fn(async () => queues.shift() ?? { running: [], pending: [] }),
    deleteQueuedPrompt: vi.fn(async () => undefined),
    verifyOwner: vi.fn(async () => true),
    persistCanceled: vi.fn(async () => true),
    persistReconciling: vi.fn(async () => true),
  }
}

describe('production ComfyUI accepted-prompt cancellation safety', () => {
  it('keeps a running owned prompt reconciling and never exposes a global interrupt capability', async () => {
    const input = fixture([{ running: [[1, 'manual'], [2, 'owned-prompt']], pending: [] }])
    await expect(cancelAcceptedPromptSafely(input)).resolves.toBe('reconciling')
    expect(input.deleteQueuedPrompt).not.toHaveBeenCalled()
    expect(input.persistReconciling).toHaveBeenCalledOnce()
    expect(input).not.toHaveProperty('interruptPrompt')
  })

  it('does not delete when a pending prompt becomes running beside manual work', async () => {
    const input = fixture([
      { running: [[1, 'manual']], pending: [[2, 'owned-prompt']] },
      { running: [[1, 'manual'], [2, 'owned-prompt']], pending: [] },
    ])
    await expect(cancelAcceptedPromptSafely(input)).resolves.toBe('reconciling')
    expect(input.deleteQueuedPrompt).not.toHaveBeenCalled()
    expect(input.persistReconciling).toHaveBeenCalledOnce()
  })

  it('double-checks and deletes only the exact pending prompt before persisting canceled', async () => {
    const input = fixture([
      { running: [[1, 'manual']], pending: [[2, 'owned-prompt'], [3, 'manual-pending']] },
      { running: [[1, 'manual']], pending: [[2, 'owned-prompt'], [3, 'manual-pending']] },
      { running: [[1, 'manual']], pending: [[3, 'manual-pending']] },
    ])
    await expect(cancelAcceptedPromptSafely(input)).resolves.toBe('canceled')
    expect(input.deleteQueuedPrompt).toHaveBeenCalledWith('owned-prompt')
    expect(input.persistCanceled).toHaveBeenCalledOnce()
    expect(input.persistReconciling).not.toHaveBeenCalled()
  })

  it('treats a queue miss as uncertain and persists reconciling', async () => {
    const input = fixture([{ running: [[1, 'manual']], pending: [] }])
    await expect(cancelAcceptedPromptSafely(input)).resolves.toBe('reconciling')
    expect(input.deleteQueuedPrompt).not.toHaveBeenCalled()
    expect(input.persistCanceled).not.toHaveBeenCalled()
    expect(input.persistReconciling).toHaveBeenCalledOnce()
  })
})
