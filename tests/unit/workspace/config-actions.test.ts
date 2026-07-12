import { describe, expect, it, vi } from 'vitest'
import {
  createStoryboardConfigUpdater,
  createWorkspaceConfigHandlers,
} from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/hooks/useWorkspaceConfigActions'

describe('workspace config update callbacks', () => {
  it('keeps the legacy handler safe while the strict handler propagates mutation failures', async () => {
    const failure = new Error('save failed')
    const mutateAsync = vi.fn().mockRejectedValue(failure)
    const logError = vi.fn()
    const handlers = createWorkspaceConfigHandlers(mutateAsync, logError)

    await expect(handlers.handleUpdateConfig('artStyle', 'ink')).resolves.toBeUndefined()
    expect(logError).toHaveBeenCalledWith('Update config error:', failure)
    await expect(handlers.handleUpdateConfigStrict('comfyImageWorkflowId', 'workflow-1')).rejects.toBe(failure)
  })

  it('resolves both handlers after a successful mutation', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined)
    const handlers = createWorkspaceConfigHandlers(mutateAsync, vi.fn())

    await expect(handlers.handleUpdateConfigStrict('comfyVideoWorkflowId', 'workflow-2')).resolves.toBeUndefined()
    expect(mutateAsync).toHaveBeenCalledWith({ key: 'comfyVideoWorkflowId', value: 'workflow-2' })
  })
})

describe('storyboard config updates', () => {
  it('refreshes server state and reports failure without rejecting the UI event', async () => {
    const failure = new Error('save failed')
    const refresh = vi.fn().mockResolvedValue(undefined)
    const reportError = vi.fn()
    const update = createStoryboardConfigUpdater({
      mutateAsync: vi.fn().mockRejectedValue(failure),
      refresh,
      reportError,
    })

    await expect(update('storyboardGenerationMode', 'six_grid')).resolves.toBe(false)
    expect(refresh).toHaveBeenCalledOnce()
    expect(reportError).toHaveBeenCalledWith('Update storyboard config error:', failure)
  })

  it('returns success without an unnecessary refresh', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const update = createStoryboardConfigUpdater({
      mutateAsync: vi.fn().mockResolvedValue(undefined),
      refresh,
      reportError: vi.fn(),
    })

    await expect(update('sixGridCellAspectRatio', '16:9')).resolves.toBe(true)
    expect(refresh).not.toHaveBeenCalled()
  })
})
