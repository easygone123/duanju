import { apiFetch, getPageLocale } from '@/lib/api-fetch'

export type ViralReplicationClientStatus =
  | 'uploading'
  | 'analyzing'
  | 'review_ready'
  | 'generating'
  | 'completed'
  | 'failed'

export type ViralReplicationDetail = {
  id: string
  brief: string
  videoRatio: string
  artStyle: string
  status: ViralReplicationClientStatus
  reportJson?: unknown
  reportVersion?: number
  errorMessage?: string | null
  durationMs?: number | null
  confirmedAt?: string | null
  createdAt?: string
  updatedAt?: string
  taskId?: string | null
  projectId?: string | null
  episodeId?: string | null
  sourceVideoMediaId?: string | null
  project?: { id: string; name: string } | null
  episode?: { id: string; episodeNumber: number; name: string } | null
  sourceVideo?: {
    id: string
    publicId: string
    mimeType: string | null
    sizeBytes: number | null
    width: number | null
    height: number | null
    durationMs: number | null
    url: string
  } | null
}

type ReplicationResponse = { replication: ViralReplicationDetail }

async function parseJsonResponse(response: Response): Promise<ReplicationResponse> {
  const payload = await response.json().catch(() => null) as {
    replication?: ViralReplicationDetail
    error?: { message?: string; code?: string }
  } | null
  if (!response.ok || !payload?.replication) {
    throw new Error(payload?.error?.message || payload?.error?.code || 'VIRAL_REPLICATION_REQUEST_FAILED')
  }
  return { replication: payload.replication }
}

async function requestReplication(path: string, init?: RequestInit): Promise<ViralReplicationDetail> {
  return (await parseJsonResponse(await apiFetch(path, init))).replication
}

export function getViralReplicationDetail(id: string): Promise<ViralReplicationDetail> {
  return requestReplication(`/api/viral-replications/${encodeURIComponent(id)}`)
}

export function createViralReplicationSession(input: {
  brief: string
  videoRatio: string
  artStyle: string
}): Promise<ViralReplicationDetail> {
  return requestReplication('/api/viral-replications', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function patchViralReplicationBrief(
  id: string,
  brief: string,
): Promise<ViralReplicationDetail> {
  return requestReplication(`/api/viral-replications/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ brief }),
  })
}

export function retryViralReplicationClient(id: string): Promise<ViralReplicationDetail> {
  return requestReplication(`/api/viral-replications/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
  })
}

export function generateViralReplicationClient(
  id: string,
  brief: string,
): Promise<ViralReplicationDetail> {
  return requestReplication(`/api/viral-replications/${encodeURIComponent(id)}/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ brief }),
  })
}

function abortError(): DOMException {
  return new DOMException('Upload aborted', 'AbortError')
}

export function uploadViralReplicationVideo(
  id: string,
  file: File,
  options: {
    signal?: AbortSignal
    onProgress?: (percentage: number) => void
  } = {},
): Promise<ViralReplicationDetail> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError())
      return
    }

    const xhr = new XMLHttpRequest()
    let settled = false
    const cleanup = () => options.signal?.removeEventListener('abort', onSignalAbort)
    const succeed = (value: ViralReplicationDetail) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onSignalAbort = () => xhr.abort()

    xhr.open('PUT', `/api/viral-replications/${encodeURIComponent(id)}/video`)
    xhr.setRequestHeader('Accept-Language', getPageLocale())
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return
      const percentage = Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)))
      options.onProgress?.(percentage)
    }
    xhr.onload = () => {
      let payload: {
        replication?: ViralReplicationDetail
        error?: { message?: string; code?: string }
      } | null = null
      try {
        payload = JSON.parse(xhr.responseText || 'null')
      } catch {
        // Normalize malformed server responses into one stable client error.
      }
      if (xhr.status >= 200 && xhr.status < 300 && payload?.replication) {
        succeed(payload.replication)
        return
      }
      fail(new Error(payload?.error?.message || payload?.error?.code || 'VIRAL_VIDEO_UPLOAD_FAILED'))
    }
    xhr.onerror = () => fail(new Error('VIRAL_VIDEO_UPLOAD_FAILED'))
    xhr.onabort = () => fail(abortError())
    options.signal?.addEventListener('abort', onSignalAbort, { once: true })
    xhr.send(file)
  })
}
