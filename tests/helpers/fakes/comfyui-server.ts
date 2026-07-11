import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { WebSocketServer, type WebSocket } from 'ws'

export interface RecordedComfyRequest {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: Buffer
}

type RouteOverride = (request: IncomingMessage, response: ServerResponse, body: Buffer) => void

export class FakeComfyUiServer {
  readonly requests: RecordedComfyRequest[] = []
  private readonly sockets = new Set<WebSocket>()
  private readonly overrides = new Map<string, RouteOverride>()
  private readonly server = createServer((request, response) => void this.handle(request, response))
  private readonly websocketServer = new WebSocketServer({ noServer: true })

  constructor(readonly prefix = '/proxy/comfy') {
    this.server.on('upgrade', (request, socket, head) => {
      if (new URL(request.url ?? '/', 'http://localhost').pathname !== `${this.prefix}/ws`) {
        socket.destroy()
        return
      }
      this.websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        this.requests.push({
          method: 'WS',
          path: request.url ?? '',
          headers: request.headers,
          body: Buffer.alloc(0),
        })
        this.sockets.add(websocket)
        websocket.on('close', () => this.sockets.delete(websocket))
      })
    })
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
  }

  get baseUrl(): string {
    const address = this.server.address() as AddressInfo
    return `http://127.0.0.1:${address.port}${this.prefix}`
  }

  override(path: string, handler: RouteOverride): void {
    this.overrides.set(path, handler)
  }

  send(event: unknown): void {
    const payload = JSON.stringify(event)
    for (const socket of this.sockets) socket.send(payload)
  }

  sendBinary(bytes = Buffer.from([1, 2, 3])): void {
    for (const socket of this.sockets) socket.send(bytes)
  }

  async waitForSocket(): Promise<void> {
    const deadline = Date.now() + 1_000
    while (this.sockets.size === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    if (this.sockets.size === 0) throw new Error('WebSocket did not connect')
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.close()
    this.websocketServer.close()
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    )
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks)
    const url = new URL(request.url ?? '/', 'http://localhost')
    this.requests.push({
      method: request.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      headers: request.headers,
      body,
    })

    const override = this.overrides.get(url.pathname)
    if (override) {
      override(request, response, body)
      return
    }

    const route = url.pathname.slice(this.prefix.length)
    if (request.method === 'GET' && route === '/system_stats') return json(response, { system: { os: 'fake' }, devices: [] })
    if (request.method === 'GET' && route === '/queue') return json(response, { queue_running: [['run']], queue_pending: [['wait']] })
    if (request.method === 'GET' && route === '/object_info') return json(response, { CheckpointLoaderSimple: { input: {} } })
    if (request.method === 'GET' && route.startsWith('/models/')) return json(response, ['model one.safetensors'])
    if (request.method === 'POST' && route === '/upload/image') return json(response, { name: 'upload.png', subfolder: 'inputs', type: 'input' })
    if (request.method === 'POST' && route === '/prompt') return json(response, { prompt_id: 'prompt-1', number: 1, node_errors: {} })
    if (request.method === 'GET' && route === '/history/prompt-1') return json(response, { 'prompt-1': { status: { completed: true }, outputs: {} } })
    if (request.method === 'GET' && route === '/view') return bytes(response, Buffer.from('output-bytes'))
    if (request.method === 'POST' && route === '/queue') return json(response, {})
    if (request.method === 'POST' && route === '/interrupt') return json(response, {})
    response.statusCode = 404
    json(response, { error: 'not found' })
  }
}

function json(response: ServerResponse, value: unknown): void {
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(value))
}

function bytes(response: ServerResponse, value: Buffer): void {
  response.setHeader('content-type', 'application/octet-stream')
  response.end(value)
}
