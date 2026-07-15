import { beforeEach, describe, expect, it, vi } from 'vitest'

import { queryKeys } from '@/lib/query/keys'
import {
  getViralReplicationAvailability,
  uploadViralReplicationVideo,
} from '@/lib/viral-replication/client'

class FakeXMLHttpRequest {
  static instances: FakeXMLHttpRequest[] = []

  readonly upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  status = 0
  responseText = ''
  method = ''
  url = ''
  sentBody: Document | XMLHttpRequestBodyInit | null = null
  headers = new Map<string, string>()

  constructor() {
    FakeXMLHttpRequest.instances.push(this)
  }

  open(method: string, url: string) {
    this.method = method
    this.url = url
  }

  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value)
  }

  send(body: Document | XMLHttpRequestBodyInit | null) {
    this.sentBody = body
  }

  abort() {
    this.onabort?.()
  }

  succeed(payload: unknown) {
    this.status = 202
    this.responseText = JSON.stringify(payload)
    this.onload?.()
  }
}

describe('viral replication client', () => {
  beforeEach(() => {
    FakeXMLHttpRequest.instances = []
    ;(globalThis as unknown as { XMLHttpRequest: typeof FakeXMLHttpRequest }).XMLHttpRequest = FakeXMLHttpRequest
  })

  it('uses a stable detail query key', () => {
    expect(queryKeys.viralReplication.detail('rep-1')).toEqual(['viral-replication', 'rep-1'])
    expect(queryKeys.viralReplication.detail('rep-1')).toEqual(queryKeys.viralReplication.detail('rep-1'))
  })

  it('reads the runtime availability endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      JSON.stringify({ available: true }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    await expect(getViralReplicationAvailability()).resolves.toEqual({ available: true })
    expect(fetchMock).toHaveBeenCalledWith('/api/viral-replications', expect.objectContaining({
      headers: expect.any(Headers),
    }))
    fetchMock.mockRestore()
  })

  it('uploads the File body directly with PUT and reports percentage progress', async () => {
    const file = new File(['video'], 'source.mp4', { type: 'video/mp4' })
    const onProgress = vi.fn()
    const pending = uploadViralReplicationVideo('rep-1', file, { onProgress })
    const xhr = FakeXMLHttpRequest.instances[0]

    expect(xhr.method).toBe('PUT')
    expect(xhr.url).toBe('/api/viral-replications/rep-1/video')
    expect(xhr.sentBody).toBe(file)
    expect(xhr.headers.get('Content-Type')).toBe('video/mp4')

    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 } as ProgressEvent)
    expect(onProgress).toHaveBeenLastCalledWith(25)

    xhr.succeed({ replication: { id: 'rep-1', status: 'analyzing', taskId: 'task-1' } })
    await expect(pending).resolves.toMatchObject({ id: 'rep-1', status: 'analyzing' })
  })

  it('aborts the XHR and rejects with AbortError', async () => {
    const controller = new AbortController()
    const pending = uploadViralReplicationVideo(
      'rep-1',
      new File(['video'], 'source.mov', { type: 'video/quicktime' }),
      { signal: controller.signal },
    )
    const xhr = FakeXMLHttpRequest.instances[0]
    const abortSpy = vi.spyOn(xhr, 'abort')

    controller.abort()

    expect(abortSpy).toHaveBeenCalledOnce()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
