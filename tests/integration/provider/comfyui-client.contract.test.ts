import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ComfyClient } from '@/lib/comfyui/client'
import { ComfyError } from '@/lib/comfyui/errors'
import type { ComfyConnectionAuth } from '@/lib/comfyui/types'
import { FakeComfyUiServer } from '../../helpers/fakes/comfyui-server'

describe('ComfyClient contract', () => {
  let server: FakeComfyUiServer

  beforeEach(async () => {
    server = new FakeComfyUiServer()
    await server.start()
  })

  afterEach(async () => {
    await server.close()
  })

  function client(auth: ComfyConnectionAuth = { type: 'none' }, overrides = {}) {
    return new ComfyClient({
      baseUrl: server.baseUrl,
      auth,
      networkPolicy: { mode: 'trusted', allowedHosts: [], allowedCidrs: [] },
      timeoutMs: 500,
      ...overrides,
    })
  }

  it.each([
    [{ type: 'none' } as const, undefined],
    [{ type: 'bearer', token: 'top-secret-token' } as const, 'Bearer top-secret-token'],
    [
      { type: 'basic', username: '测试', password: 'päss' } as const,
      `Basic ${Buffer.from('测试:päss', 'utf8').toString('base64')}`,
    ],
  ])('applies in-memory %s auth without changing the path prefix', async (auth, expected) => {
    await client(auth).getSystemStats()

    expect(server.requests[0].path).toBe('/proxy/comfy/system_stats')
    expect(server.requests[0].headers.authorization).toBe(expected)
  })

  it('reads stats, queue, object info, and safely encoded model folders', async () => {
    const comfy = client()

    await expect(comfy.getSystemStats()).resolves.toMatchObject({ system: { os: 'fake' } })
    await expect(comfy.getQueue()).resolves.toEqual({ running: [['run']], pending: [['wait']] })
    await expect(comfy.getObjectInfo()).resolves.toHaveProperty('CheckpointLoaderSimple')
    await expect(comfy.getModels('checkpoints/custom')).resolves.toEqual(['model one.safetensors'])
    expect(server.requests.at(-1)?.path).toBe('/proxy/comfy/models/checkpoints%2Fcustom')
  })

  it('uploads bytes as multipart with caller-controlled collision-safe metadata', async () => {
    await client().uploadImage({
      filename: 'request-123-input.png',
      contentType: 'image/png',
      bytes: Uint8Array.from([137, 80, 78, 71]),
      subfolder: 'requests/request-123',
      overwrite: false,
    })

    const request = server.requests.at(-1)!
    expect(request.headers['content-type']).toContain('multipart/form-data; boundary=')
    expect(request.body.toString('latin1')).toContain('filename="request-123-input.png"')
    expect(request.body.toString()).toContain('requests/request-123')
    expect(request.body.toString()).toContain('overwrite')
  })

  it('accepts an input at the source-byte limit and rejects one byte over before upload', async () => {
    const atLimit = client({ type: 'none' }, { maxInputBytes: 4 })
    await expect(atLimit.uploadImage({
      filename: 'at-limit.png', contentType: 'image/png', bytes: Uint8Array.from([1, 2, 3, 4]),
    })).resolves.toMatchObject({ name: 'upload.png' })
    const requestsAfterAcceptedUpload = server.requests.length

    await expect(atLimit.uploadImage({
      filename: 'over-limit.png', contentType: 'image/png', bytes: Uint8Array.from([1, 2, 3, 4, 5]),
    })).rejects.toMatchObject({ code: 'COMFY_INPUT_UPLOAD_FAILED' })
    expect(server.requests).toHaveLength(requestsAfterAcceptedUpload)
  })

  it('submits the graph with client id and returns a validated prompt id', async () => {
    await expect(client().submitPrompt({ '1': { class_type: 'KSampler', inputs: {} } }, 'client-1'))
      .resolves.toEqual({ promptId: 'prompt-1' })

    expect(JSON.parse(server.requests.at(-1)!.body.toString())).toEqual({
      prompt: { '1': { class_type: 'KSampler', inputs: {} } },
      client_id: 'client-1',
    })
  })

  it('accepts a serialized prompt request at its UTF-8 limit and rejects one byte over', async () => {
    const graph = { '1': { class_type: '测试Sampler', inputs: { prompt: '画面' } } }
    const serialized = JSON.stringify({ prompt: graph, client_id: 'client-1' })
    const requestBytes = Buffer.byteLength(serialized, 'utf8')

    await expect(client({ type: 'none' }, { maxWorkflowBytes: requestBytes })
      .submitPrompt(graph, 'client-1')).resolves.toEqual({ promptId: 'prompt-1' })
    const requestsAfterAcceptedPrompt = server.requests.length

    await expect(client({ type: 'none' }, { maxWorkflowBytes: requestBytes - 1 })
      .submitPrompt(graph, 'client-1')).rejects.toMatchObject({ code: 'COMFY_PROMPT_REJECTED' })
    expect(server.requests).toHaveLength(requestsAfterAcceptedPrompt)
  })

  it('does not retain prompt-sensitive context after many near-limit submissions', async () => {
    let promptNumber = 0
    server.override('/proxy/comfy/prompt', (_request, response) => {
      promptNumber += 1
      response.end(JSON.stringify({ prompt_id: `retention-${promptNumber}`, node_errors: {} }))
    })
    const comfy = client({ type: 'none' }, { maxWorkflowBytes: 16 * 1024 })

    for (let index = 0; index < 12; index += 1) {
      await comfy.submitPrompt({
        '1': {
          class_type: 'TextNode',
          inputs: { prompt: `sensitive-${index}-${'x'.repeat(15 * 1024)}` },
        },
      }, 'client-1')
    }

    expect(Object.keys(comfy).filter((key) => /prompt|sensitive/i.test(key))).toEqual([])
  })

  it('rejects missing prompt ids and exposes bounded sanitized node errors', async () => {
    server.override('/proxy/comfy/prompt', (_request, response) => {
      response.statusCode = 400
      response.end(JSON.stringify({
        error: { message: 'bad Bearer top-secret-token' },
        node_errors: {
          '3': {
            class_type: 'KSampler',
            errors: [{
              type: 'top-secret-token',
              code: 'top-secret-prompt',
              message: 'bad top-secret-prompt token=top-secret-token',
              extra_info: { submitted_prompt: 'top-secret-prompt' },
            }],
            extra_info: { raw: 'must-not-survive' },
          },
          'top-secret-token': { errors: [] },
        },
      }))
    })

    await expect(client({ type: 'bearer', token: 'top-secret-token' }).submitPrompt({
      '1': { class_type: 'TextNode', inputs: { prompt: 'top-secret-prompt' } },
    }, 'client-1'))
      .rejects.toMatchObject({
        code: 'COMFY_PROMPT_REJECTED',
        details: {
          nodeErrors: {
            '3': {
              nodeId: '3',
              classType: 'KSampler',
              errors: [{ type: '[REDACTED]', code: '[REDACTED]', message: '[REDACTED]' }],
            },
            '[REDACTED]': { nodeId: '[REDACTED]', errors: [] },
          },
        },
      })
  })

  it('maps correlated execution events and ignores previews and other prompts', async () => {
    const controller = new AbortController()
    const iterator = client().watchPrompt('prompt-1', 'client-1', controller.signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    await server.waitForSocket()
    server.sendBinary()
    server.send({ type: 'executing', data: { prompt_id: 'other', node: '1' } })
    server.send({ type: 'status', data: { status: { exec_info: { queue_remaining: 1 } } } })
    server.send({ type: 'execution_start', data: { prompt_id: 'prompt-1' } })

    await expect(first).resolves.toEqual({
      done: false,
      value: { type: 'status', queueRemaining: 1 },
    })
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'execution_start', promptId: 'prompt-1' },
    })

    const eventPromises = [iterator.next(), iterator.next(), iterator.next(), iterator.next()]
    server.send({ type: 'executing', data: { prompt_id: 'prompt-1', node: '4' } })
    server.send({ type: 'progress', data: { prompt_id: 'prompt-1', node: '4', value: 2, max: 5 } })
    server.send({ type: 'executed', data: { prompt_id: 'prompt-1', node: '4', output: { images: [] } } })
    server.send({ type: 'execution_error', data: { prompt_id: 'prompt-1', node_id: '4', exception_message: 'boom' } })
    const events = await Promise.all(eventPromises)
    expect(events.map((result) => result.value?.type)).toEqual([
      'executing', 'progress', 'executed', 'execution_error',
    ])

    controller.abort()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('omits delayed-watch free text and preserves only canonical structural diagnostics', async () => {
    const comfy = client({ type: 'bearer', token: 'ws-auth-secret' })
    await comfy.submitPrompt({
      '1': { class_type: 'TextNode', inputs: { prompt: 'ws-prompt-secret' } },
    }, 'client-1')
    const controller = new AbortController()
    const iterator = comfy.watchPrompt('prompt-1', 'client-1', controller.signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    await server.waitForSocket()
    server.send({
      type: 'execution_error',
      data: {
        prompt_id: 'prompt-1',
        node_id: 'ws-prompt-secret',
        exception_message: `failed ws-prompt-secret ws-auth-secret ${'x'.repeat(5_000)}`,
        node_errors: {
          '4': {
            class_type: 'KSampler',
            errors: [{
              type: 'value_error',
              code: 'BAD_PROMPT',
              message: 'invalid ws-prompt-secret',
              extra_info: { raw_prompt: 'ws-prompt-secret' },
            }],
            extra_info: { arbitrary: 'must-not-survive' },
          },
          'unsafe/node': {
            errors: [{ type: 'value_error', code: 'UNSAFE_NODE', message: 'must-not-survive' }],
          },
        },
        extra_info: { raw: 'must-not-survive' },
      },
    })

    const result = await next
    expect(result).toMatchObject({
      done: false,
      value: {
        type: 'execution_error',
        promptId: 'prompt-1',
        message: 'Execution failed',
        nodeErrors: {
          '4': {
            nodeId: '4',
            errors: [{ type: 'value_error', code: 'BAD_PROMPT' }],
          },
        },
      },
    })
    const serialized = JSON.stringify(result)
    expect(result.value).not.toHaveProperty('nodeId')
    expect(serialized.length).toBeLessThan(2_000)
    expect(serialized).not.toMatch(/ws-prompt-secret|ws-auth-secret|must-not-survive|x{100}/)

    controller.abort()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('omits direct-watch free text and unsafe identifiers without prompt context', async () => {
    const controller = new AbortController()
    const iterator = client({ type: 'bearer', token: 'direct-auth-secret' })
      .watchPrompt('direct-prompt', 'client-1', controller.signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    await server.waitForSocket()
    server.send({
      type: 'execution_error',
      data: {
        prompt_id: 'direct-prompt',
        node_id: 'unsafe/node',
        exception_message: 'x'.repeat(5_000),
        node_errors: {
          '8': {
            errors: [{ message: 'leaked direct-auth-secret', extra_info: { raw: true } }],
            extra_info: { raw: true },
          },
        },
      },
    })

    const result = await next
    expect(result.value?.type).toBe('execution_error')
    if (result.value?.type !== 'execution_error') throw new Error('expected execution_error')
    expect(result.value.message).toBe('Execution failed')
    expect(result.value).not.toHaveProperty('nodeId')
    expect(result.value.nodeErrors).toEqual({
      '8': { nodeId: '8', errors: [] },
    })
    expect(JSON.stringify(result.value)).not.toMatch(/direct-auth-secret|extra_info/)
    controller.abort()
  })

  it('discards queued WebSocket events when aborted before the next consumption', async () => {
    const controller = new AbortController()
    const iterator = client().watchPrompt('prompt-1', 'client-1', controller.signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    await server.waitForSocket()
    server.send({ type: 'execution_start', data: { prompt_id: 'prompt-1' } })
    await expect(first).resolves.toMatchObject({ value: { type: 'execution_start' } })

    server.send({ type: 'executing', data: { prompt_id: 'prompt-1', node: 'queued-node' } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()

    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('throws a stable connection error when the WebSocket handshake is refused', async () => {
    server.rejectWebSockets(503)
    const next = client().watchPrompt('prompt-1', 'client-1', new AbortController().signal)
      [Symbol.asyncIterator]().next()

    await expect(next).rejects.toMatchObject({ code: 'COMFY_CONNECTION_OFFLINE' })
  })

  it.each([401, 403])('maps a WebSocket HTTP %s handshake to auth failed', async (status) => {
    server.rejectWebSockets(status)
    const next = client().watchPrompt('prompt-1', 'client-1', new AbortController().signal)
      [Symbol.asyncIterator]().next()

    await expect(next).rejects.toMatchObject({
      code: 'COMFY_AUTH_FAILED', details: { httpStatus: status },
    })
  })

  it('terminates an idle WebSocket with a stable timeout error', async () => {
    const next = client({ type: 'none' }, { wsIdleTimeoutMs: 25 })
      .watchPrompt('prompt-1', 'client-1', new AbortController().signal)
      [Symbol.asyncIterator]().next()
    await server.waitForSocket()

    await expect(next).rejects.toMatchObject({ code: 'COMFY_EXECUTION_TIMEOUT' })
  })

  it('resets the WebSocket idle timeout on each correlated event', async () => {
    const controller = new AbortController()
    const iterator = client({ type: 'none' }, { wsIdleTimeoutMs: 100 })
      .watchPrompt('prompt-1', 'client-1', controller.signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    await server.waitForSocket()
    await new Promise((resolve) => setTimeout(resolve, 60))
    server.send({ type: 'execution_start', data: { prompt_id: 'prompt-1' } })
    await expect(first).resolves.toMatchObject({ value: { type: 'execution_start' } })

    await new Promise((resolve) => setTimeout(resolve, 60))
    const second = iterator.next()
    server.send({ type: 'executing', data: { prompt_id: 'prompt-1', node: '4' } })
    await expect(second).resolves.toMatchObject({ value: { type: 'executing' } })
    controller.abort()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('reads history and output bytes with safe explicit view query fields', async () => {
    const comfy = client()
    await expect(comfy.getHistory('prompt-1')).resolves.toHaveProperty('prompt-1')
    await expect(comfy.downloadOutput({
      name: 'primary', nodeId: '9', mediaType: 'image', primary: true,
      filename: 'output #1.png', subfolder: 'job/a b', type: 'output',
    })).resolves.toEqual(Buffer.from('output-bytes'))
    expect(server.requests.at(-1)?.path).toBe(
      '/proxy/comfy/view?filename=output+%231.png&subfolder=job%2Fa+b&type=output',
    )
  })

  it('deletes only the requested queued prompt and interrupts with the prompt id', async () => {
    const comfy = client()
    await comfy.deleteQueuedPrompt('prompt-1')
    await comfy.interruptPrompt('prompt-1')

    expect(JSON.parse(server.requests.at(-2)!.body.toString())).toEqual({ delete: ['prompt-1'] })
    expect(JSON.parse(server.requests.at(-1)!.body.toString())).toEqual({ prompt_id: 'prompt-1' })
  })

  it('times out stalled phases with a stable error', async () => {
    server.override('/proxy/comfy/system_stats', () => undefined)

    await expect(client({ type: 'none' }, { timeoutMs: 25 }).getSystemStats()).rejects.toMatchObject({
      code: 'COMFY_EXECUTION_TIMEOUT',
    })
  })

  it('bounds a stalled DNS authorization phase', async () => {
    const resolveHost = () => new Promise<never>(() => undefined)

    await expect(client({ type: 'none' }, { timeoutMs: 25, resolveHost }).getSystemStats())
      .rejects.toMatchObject({ code: 'COMFY_EXECUTION_TIMEOUT' })
  }, 250)

  it('enforces JSON and output body limits', async () => {
    server.override('/proxy/comfy/system_stats', (_request, response) => response.end('x'.repeat(80)))
    server.override('/proxy/comfy/view', (_request, response) => response.end(Buffer.alloc(80)))
    const comfy = client({ type: 'none' }, { maxJsonBytes: 32, maxOutputBytes: 32 })

    await expect(comfy.getSystemStats()).rejects.toBeInstanceOf(ComfyError)
    await expect(comfy.downloadOutput({
      name: 'x', nodeId: '1', mediaType: 'image', primary: true,
      filename: 'x.png', subfolder: '', type: 'output',
    })).rejects.toBeInstanceOf(ComfyError)
  })

  it('rejects cross-origin redirects without forwarding credentials', async () => {
    server.override('/proxy/comfy/system_stats', (_request, response) => {
      response.statusCode = 302
      response.setHeader('location', 'http://127.0.0.1:1/stolen')
      response.end()
    })

    await expect(client({ type: 'bearer', token: 'redirect-secret' }).getSystemStats())
      .rejects.toMatchObject({ code: 'COMFY_NETWORK_TARGET_BLOCKED' })
  })

  it('reauthorizes a bounded same-origin redirect before following it', async () => {
    const resolveHost = vi.fn(async () => [{ address: '127.0.0.1', family: 4 as const }])
    server.override('/proxy/comfy/system_stats', (_request, response) => {
      response.statusCode = 302
      response.setHeader('location', '/proxy/comfy/object_info')
      response.end()
    })

    await expect(client({ type: 'none' }, { resolveHost }).getSystemStats())
      .resolves.toHaveProperty('CheckpointLoaderSimple')
    expect(resolveHost).toHaveBeenCalledTimes(2)
  })

  it('rejects a same-origin redirect outside the configured base prefix before forwarding auth', async () => {
    server.override('/proxy/comfy/system_stats', (_request, response) => {
      response.statusCode = 302
      response.setHeader('location', '/outside-prefix')
      response.end()
    })

    await expect(client({ type: 'bearer', token: 'prefix-secret' }).getSystemStats())
      .rejects.toMatchObject({ code: 'COMFY_NETWORK_TARGET_BLOCKED' })
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].headers.authorization).toBe('Bearer prefix-secret')
  })

  it.each([
    ['169.254.170.23', 4 as const],
    ['fd00:ec2::23', 6 as const],
  ])('blocks EKS credential address %s while reauthorizing a redirect', async (address, family) => {
    const resolveHost = vi.fn()
      .mockResolvedValueOnce([{ address: '203.0.113.10', family: 4 as const }])
      .mockResolvedValueOnce([{ address, family }])
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'http://comfy.example/proxy/comfy/system_stats' },
    }))
    const comfy = new ComfyClient({
      baseUrl: 'http://comfy.example/proxy/comfy',
      auth: { type: 'none' },
      networkPolicy: { mode: 'allowlist', allowedHosts: ['comfy.example'], allowedCidrs: [] },
      resolveHost,
      fetchImpl,
    })

    await expect(comfy.getSystemStats()).rejects.toMatchObject({
      code: 'COMFY_NETWORK_TARGET_BLOCKED',
    })
    expect(resolveHost).toHaveBeenCalledTimes(2)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects an adversarial streaming redirect within the request timeout', async () => {
    server.override('/proxy/comfy/system_stats', (_request, response) => {
      response.statusCode = 302
      response.setHeader('location', '/outside-prefix')
      response.write('never-ending redirect body')
    })
    const startedAt = Date.now()

    await expect(client({ type: 'none' }, { timeoutMs: 30 }).getSystemStats())
      .rejects.toBeInstanceOf(ComfyError)
    expect(Date.now() - startedAt).toBeLessThan(250)
  })

  it('pins the authorized address for both HTTP and WebSocket connections', async () => {
    const resolveHost = vi.fn(async () => [{ address: '127.0.0.1', family: 4 as const }])
    const deliberatelyUnresolvableBase = new URL(server.baseUrl)
    deliberatelyUnresolvableBase.hostname = 'comfy.invalid'
    const comfy = new ComfyClient({
      baseUrl: deliberatelyUnresolvableBase.href,
      auth: { type: 'none' },
      networkPolicy: { mode: 'trusted', allowedHosts: [], allowedCidrs: [] },
      resolveHost,
      timeoutMs: 500,
    })

    await expect(comfy.getSystemStats()).resolves.toHaveProperty('system')
    expect(server.requests.at(-1)?.headers.host).toMatch(/^comfy\.invalid:/)
    const controller = new AbortController()
    const next = comfy.watchPrompt('prompt-1', 'client-1', controller.signal)
      [Symbol.asyncIterator]().next()
    await server.waitForSocket()
    controller.abort()
    await expect(next).resolves.toEqual({ done: true, value: undefined })
    expect(resolveHost).toHaveBeenCalledTimes(2)
  })

  it('sanitizes and bounds non-OK response bodies', async () => {
    server.override('/proxy/comfy/system_stats', (_request, response) => {
      response.statusCode = 500
      response.end(`Bearer response-secret ${'x'.repeat(1_000)}`)
    })

    const promise = client({ type: 'bearer', token: 'response-secret' }, { maxErrorBytes: 48 })
      .getSystemStats()
    await expect(promise).rejects.toBeInstanceOf(ComfyError)
    await expect(promise).rejects.not.toThrow(/response-secret/)
  })

  it('preserves operation code and HTTP status when a non-OK body exceeds the error limit', async () => {
    server.override('/proxy/comfy/system_stats', (_request, response) => {
      response.statusCode = 500
      response.end(`Bearer oversized-secret leak-marker ${'x'.repeat(1_000)}`)
    })

    const promise = client(
      { type: 'bearer', token: 'oversized-secret' },
      { maxErrorBytes: 32 },
    ).getSystemStats()
    await expect(promise).rejects.toMatchObject({
      code: 'COMFY_CONNECTION_OFFLINE',
      details: { httpStatus: 500, bodyTruncated: true },
    })
    await expect(promise).rejects.not.toThrow(/oversized-secret|leak-marker/)
  })

  it.each([401, 403])('maps HTTP %s to auth failed without reflecting the body', async (status) => {
    server.override('/proxy/comfy/system_stats', (_request, response) => {
      response.statusCode = status
      response.end('arbitrary-body-marker top-secret-token')
    })
    const promise = client({ type: 'bearer', token: 'top-secret-token' }).getSystemStats()

    await expect(promise).rejects.toMatchObject({
      code: 'COMFY_AUTH_FAILED', details: { httpStatus: status },
    })
    await expect(promise).rejects.not.toThrow(/arbitrary-body-marker|top-secret-token/)
  })

  it.each([
    ['/proxy/comfy/system_stats', 'stats', 'COMFY_CONNECTION_OFFLINE'],
    ['/proxy/comfy/history/prompt-1', 'history', 'COMFY_CONNECTION_OFFLINE'],
    ['/proxy/comfy/upload/image', 'upload', 'COMFY_INPUT_UPLOAD_FAILED'],
    ['/proxy/comfy/prompt', 'prompt', 'COMFY_PROMPT_REJECTED'],
  ])('uses the operation code for oversized successful %s responses', async (path, operation, code) => {
    server.override(path, (_request, response) => response.end('x'.repeat(80)))
    const comfy = client({ type: 'none' }, { maxJsonBytes: 32 })
    const request = operation === 'stats'
      ? comfy.getSystemStats()
      : operation === 'history'
        ? comfy.getHistory('prompt-1')
        : operation === 'upload'
          ? comfy.uploadImage({ filename: 'x.png', contentType: 'image/png', bytes: new Uint8Array() })
          : comfy.submitPrompt({}, 'client-1')

    await expect(request).rejects.toMatchObject({ code })
  })
})
