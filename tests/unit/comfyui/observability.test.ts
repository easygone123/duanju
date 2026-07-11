import { describe, expect, it, vi } from 'vitest'

import {
  createComfyObservability,
  redactComfyDiagnostic,
  type ComfyMetricSink,
} from '@/lib/comfyui/observability'

describe('ComfyUI observability', () => {
  it('attaches correlation identifiers while redacting prompts and credentials', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const metrics: ComfyMetricSink = { increment: vi.fn(), observe: vi.fn(), gauge: vi.fn() }
    const observation = createComfyObservability({
      logger,
      metrics,
      context: {
        taskId: 'task-1', requestId: 'request-1', workflowId: 'workflow-1',
        workflowVersionId: 'version-1', connectionId: 'connection-1',
        promptId: 'prompt-1', leaseId: 'lease-1',
      },
    })

    observation.info('submitted', {
      authorization: 'Bearer secret-token', password: 'secret-password',
      prompt: { '1': { inputs: { text: 'private prompt' } } }, safeCount: 2,
    })

    expect(logger.info).toHaveBeenCalledWith('submitted', expect.objectContaining({
      taskId: 'task-1', requestId: 'request-1', promptId: 'prompt-1', safeCount: 2,
      authorization: '[REDACTED]', password: '[REDACTED]', prompt: '[REDACTED]',
    }))
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('secret-token')
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('private prompt')
  })

  it('records bounded metric names and non-sensitive labels', () => {
    const metrics: ComfyMetricSink = { increment: vi.fn(), observe: vi.fn(), gauge: vi.fn() }
    const observation = createComfyObservability({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, metrics,
      context: { requestId: 'request-1', connectionId: 'connection-1' },
    })

    observation.increment('workflow_success', { state: 'completed', token: 'nope' })
    observation.observe('transfer_duration_ms', 42, { mediaType: 'image' })
    observation.gauge('connection_busy', 1)

    expect(metrics.increment).toHaveBeenCalledWith('comfy.workflow_success', 1, {
      state: 'completed', requestId: 'request-1', connectionId: 'connection-1',
    })
    expect(metrics.observe).toHaveBeenCalledWith(
      'comfy.transfer_duration_ms', 42,
      { mediaType: 'image', requestId: 'request-1', connectionId: 'connection-1' },
    )
    expect(metrics.gauge).toHaveBeenCalledWith(
      'comfy.connection_busy', 1, { requestId: 'request-1', connectionId: 'connection-1' },
    )
  })

  it('redacts nested secret and prompt-shaped keys without retaining error causes', () => {
    const value = redactComfyDiagnostic({
      nested: { cookie: 'session=x', apiKey: 'key', workflow: { secret: true } },
      error: new Error('Bearer leaked-token'),
    })
    expect(value).toEqual({
      nested: { cookie: '[REDACTED]', apiKey: '[REDACTED]', workflow: '[REDACTED]' },
      error: { name: 'Error', message: 'Operation failed' },
    })
    expect(redactComfyDiagnostic({ message: 'failed with Bearer leaked-token' }))
      .toEqual({ message: 'failed with [REDACTED]' })
  })
})
