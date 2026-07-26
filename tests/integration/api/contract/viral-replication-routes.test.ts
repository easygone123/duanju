import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMockRequest } from '../../../helpers/request'

const authState = vi.hoisted(() => ({ authenticated: true }))
const runtimeHealthState = vi.hoisted(() => ({ available: true }))
const serviceMock = vi.hoisted(() => ({
  createViralReplication: vi.fn(),
  getOwnedViralReplicationDetail: vi.fn(),
  updateViralReplicationBrief: vi.fn(),
  uploadViralReplicationVideo: vi.fn(),
  importViralReplicationVideoFromLink: vi.fn(),
  retryViralReplication: vi.fn(),
  generateViralReplication: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({
  isErrorResponse: (value: unknown) => value instanceof Response,
  requireUserAuth: async () => authState.authenticated
    ? { session: { user: { id: 'user-1' } } }
    : new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
}))

vi.mock('@/lib/viral-replication/service', () => serviceMock)
vi.mock('@/lib/viral-replication/runtime-health', () => ({
  getViralReplicationRuntimeHealth: async () => ({
    available: runtimeHealthState.available,
    ffmpeg: runtimeHealthState.available,
    ffprobe: runtimeHealthState.available,
  }),
}))

describe('api contract - viral replication routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authState.authenticated = true
    runtimeHealthState.available = true
    serviceMock.createViralReplication.mockResolvedValue({
      id: 'rep-1', status: 'uploading', brief: '复刻节奏，不复制人物', videoRatio: '9:16', artStyle: 'realistic',
    })
    serviceMock.getOwnedViralReplicationDetail.mockResolvedValue({
      id: 'rep-1', status: 'review_ready', reportJson: { schemaVersion: 1 }, project: { id: 'project-1' },
      episode: { id: 'episode-1' }, sourceVideo: { id: 'media-1', url: '/m/source-1' },
    })
    serviceMock.updateViralReplicationBrief.mockResolvedValue({
      id: 'rep-1', status: 'review_ready', brief: '新的原创方向',
    })
    serviceMock.uploadViralReplicationVideo.mockResolvedValue({
      id: 'rep-1', status: 'analyzing', projectId: 'project-1', episodeId: 'episode-1', sourceVideoMediaId: 'media-1', taskId: 'task-1',
    })
    serviceMock.importViralReplicationVideoFromLink.mockResolvedValue({
      id: 'rep-1', status: 'analyzing', projectId: 'project-1', episodeId: 'episode-1', sourceVideoMediaId: 'media-1', taskId: 'task-link-1',
    })
    serviceMock.retryViralReplication.mockResolvedValue({
      id: 'rep-1', status: 'analyzing', taskId: 'task-retry-1',
    })
    serviceMock.generateViralReplication.mockResolvedValue({
      id: 'rep-1', status: 'generating', taskId: 'task-generate-1',
    })
  })

  it('reports runtime availability and rejects session creation when FFmpeg is unavailable', async () => {
    const { GET, POST } = await import('@/app/api/viral-replications/route')
    const context = { params: Promise.resolve({}) }
    expect(await (await GET(buildMockRequest({ path: '/api/viral-replications', method: 'GET' }), context)).json())
      .toEqual({ available: true })

    runtimeHealthState.available = false
    expect(await (await GET(buildMockRequest({ path: '/api/viral-replications', method: 'GET' }), context)).json())
      .toEqual({ available: false })
    const response = await POST(buildMockRequest({
      path: '/api/viral-replications', method: 'POST',
      body: { brief: '方向', videoRatio: '9:16', artStyle: 'realistic', storyboardGenerationMode: 'four_grid' },
    }), context)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { details: { code: 'VIRAL_REPLICATION_UNAVAILABLE' } },
    })
    expect(serviceMock.createViralReplication).not.toHaveBeenCalled()
  })

  it('requires authentication for upload-session creation', async () => {
    authState.authenticated = false
    const { POST } = await import('@/app/api/viral-replications/route')
    const response = await POST(buildMockRequest({
      path: '/api/viral-replications', method: 'POST',
      body: { brief: '方向', videoRatio: '9:16', artStyle: 'realistic', storyboardGenerationMode: 'four_grid' },
    }), { params: Promise.resolve({}) })
    expect(response.status).toBe(401)
    expect(serviceMock.createViralReplication).not.toHaveBeenCalled()
  })

  it.each([
    ['GET', '/api/viral-replications/rep-1'],
    ['PATCH', '/api/viral-replications/rep-1'],
    ['PUT', '/api/viral-replications/rep-1/video'],
    ['POST_LINK', '/api/viral-replications/rep-1/video-link'],
    ['POST_RETRY', '/api/viral-replications/rep-1/retry'],
    ['POST_GENERATE', '/api/viral-replications/rep-1/generate'],
  ] as const)('requires authentication for %s %s', async (method, path) => {
    authState.authenticated = false
    const context = { params: Promise.resolve({ id: 'rep-1' }) }
    let response: Response
    if (method === 'GET') {
      const { GET } = await import('@/app/api/viral-replications/[id]/route')
      response = await GET(buildMockRequest({ path, method }), context)
    } else if (method === 'PATCH') {
      const { PATCH } = await import('@/app/api/viral-replications/[id]/route')
      response = await PATCH(buildMockRequest({ path, method, body: { brief: '方向' } }), context)
    } else if (method === 'PUT') {
      const { PUT } = await import('@/app/api/viral-replications/[id]/video/route')
      response = await PUT(new NextRequest(`http://localhost:3000${path}`, {
        method, headers: { 'content-type': 'video/mp4' }, body: Buffer.from('video'),
      }), context)
    } else if (method === 'POST_LINK') {
      const { POST } = await import('@/app/api/viral-replications/[id]/video-link/route')
      response = await POST(buildMockRequest({
        path,
        method: 'POST',
        body: { shareText: 'https://v.douyin.com/abc/' },
      }), context)
    } else if (method === 'POST_RETRY') {
      const { POST } = await import('@/app/api/viral-replications/[id]/retry/route')
      response = await POST(buildMockRequest({ path, method: 'POST' }), context)
    } else {
      const { POST } = await import('@/app/api/viral-replications/[id]/generate/route')
      response = await POST(buildMockRequest({ path, method: 'POST', body: { brief: '方向' } }), context)
    }
    expect(response.status).toBe(401)
    expect(serviceMock.getOwnedViralReplicationDetail).not.toHaveBeenCalled()
    expect(serviceMock.updateViralReplicationBrief).not.toHaveBeenCalled()
    expect(serviceMock.uploadViralReplicationVideo).not.toHaveBeenCalled()
    expect(serviceMock.importViralReplicationVideoFromLink).not.toHaveBeenCalled()
    expect(serviceMock.retryViralReplication).not.toHaveBeenCalled()
    expect(serviceMock.generateViralReplication).not.toHaveBeenCalled()
  })

  it.each([
    [{ brief: '', videoRatio: '9:16', artStyle: 'realistic', storyboardGenerationMode: 'four_grid' }, 'brief'],
    [{ brief: '方向', videoRatio: 'bad', artStyle: 'realistic', storyboardGenerationMode: 'four_grid' }, 'videoRatio'],
    [{ brief: '方向', videoRatio: '9:16', artStyle: 'unknown', storyboardGenerationMode: 'four_grid' }, 'artStyle'],
    [{ brief: '方向', videoRatio: '9:16', artStyle: 'realistic', storyboardGenerationMode: 'unknown' }, 'storyboardGenerationMode'],
    [{
      brief: '方向',
      videoRatio: '9:16',
      artStyle: 'realistic',
      storyboardGenerationMode: 'four_grid',
      transcriptionMode: 'unknown',
    }, 'transcriptionMode'],
  ])('rejects invalid POST payload %o', async (body, field) => {
    const { POST } = await import('@/app/api/viral-replications/route')
    const response = await POST(buildMockRequest({ path: '/api/viral-replications', method: 'POST', body }), {
      params: Promise.resolve({}),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { details: { field } } })
    expect(serviceMock.createViralReplication).not.toHaveBeenCalled()
  })

  it.each([
    ['malformed', '{]'],
    ['null', 'null'],
    ['array', '[]'],
  ])('rejects %s JSON for POST without calling the service', async (_label, rawBody) => {
    const { POST } = await import('@/app/api/viral-replications/route')
    const request = new NextRequest('http://localhost:3000/api/viral-replications', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: rawBody,
    })
    const response = await POST(request, { params: Promise.resolve({}) })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_PARAMS' } })
    expect(serviceMock.createViralReplication).not.toHaveBeenCalled()
  })

  it('creates only an uploading session and returns 201', async () => {
    const { POST } = await import('@/app/api/viral-replications/route')
    const response = await POST(buildMockRequest({
      path: '/api/viral-replications', method: 'POST',
      body: {
        brief: ' 复刻节奏，不复制人物 ',
        videoRatio: '9:16',
        artStyle: 'realistic',
        storyboardGenerationMode: 'six_grid',
        locale: 'zh',
      },
    }), { params: Promise.resolve({}) })
    expect(response.status).toBe(201)
    expect(serviceMock.createViralReplication).toHaveBeenCalledWith({
      userId: 'user-1',
      brief: '复刻节奏，不复制人物',
      videoRatio: '9:16',
      artStyle: 'realistic',
      storyboardGenerationMode: 'six_grid',
      transcriptionMode: 'auto',
    })
    expect(await response.json()).toMatchObject({ replication: { id: 'rep-1', status: 'uploading' } })
  })

  it('reads owner-scoped detail metadata', async () => {
    const { GET } = await import('@/app/api/viral-replications/[id]/route')
    const response = await GET(buildMockRequest({ path: '/api/viral-replications/rep-1', method: 'GET' }), {
      params: Promise.resolve({ id: 'rep-1' }),
    })
    expect(serviceMock.getOwnedViralReplicationDetail).toHaveBeenCalledWith('rep-1', 'user-1')
    expect(await response.json()).toMatchObject({ replication: { reportJson: { schemaVersion: 1 }, sourceVideo: { id: 'media-1' } } })
  })

  it('updates only brief through the owner-scoped lifecycle service', async () => {
    const { PATCH } = await import('@/app/api/viral-replications/[id]/route')
    const response = await PATCH(buildMockRequest({
      path: '/api/viral-replications/rep-1', method: 'PATCH', body: { brief: ' 新的原创方向 ' },
    }), { params: Promise.resolve({ id: 'rep-1' }) })
    expect(response.status).toBe(200)
    expect(serviceMock.updateViralReplicationBrief).toHaveBeenCalledWith({
      id: 'rep-1', userId: 'user-1', brief: '新的原创方向',
    })
  })

  it('rejects PATCH fields other than brief', async () => {
    const { PATCH } = await import('@/app/api/viral-replications/[id]/route')
    const response = await PATCH(buildMockRequest({
      path: '/api/viral-replications/rep-1', method: 'PATCH', body: { brief: '方向', status: 'completed' },
    }), { params: Promise.resolve({ id: 'rep-1' }) })
    expect(response.status).toBe(400)
    expect(serviceMock.updateViralReplicationBrief).not.toHaveBeenCalled()
  })

  it.each([
    ['malformed', '{]'],
    ['null', 'null'],
    ['array', '[]'],
  ])('rejects %s JSON for PATCH without calling the service', async (_label, rawBody) => {
    const { PATCH } = await import('@/app/api/viral-replications/[id]/route')
    const request = new NextRequest('http://localhost:3000/api/viral-replications/rep-1', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: rawBody,
    })
    const response = await PATCH(request, { params: Promise.resolve({ id: 'rep-1' }) })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_PARAMS' } })
    expect(serviceMock.updateViralReplicationBrief).not.toHaveBeenCalled()
  })

  it('forwards the raw video request only to the owner-scoped upload service', async () => {
    const { PUT } = await import('@/app/api/viral-replications/[id]/video/route')
    const request = new NextRequest('http://localhost:3000/api/viral-replications/rep-1/video', {
      method: 'PUT', headers: { 'content-type': 'video/mp4', 'accept-language': 'zh-CN' }, body: Buffer.from('video'),
    })
    const response = await PUT(request, { params: Promise.resolve({ id: 'rep-1' }) })
    expect(response.status).toBe(202)
    expect(serviceMock.uploadViralReplicationVideo).toHaveBeenCalledWith(expect.objectContaining({
      id: 'rep-1', userId: 'user-1', request, mimeType: 'video/mp4', locale: 'zh',
    }))
    expect(await response.json()).toMatchObject({ replication: { status: 'analyzing', taskId: 'task-1' } })
  })

  it('imports a Douyin share link through the owner-scoped link service', async () => {
    const { POST } = await import('@/app/api/viral-replications/[id]/video-link/route')
    const request = buildMockRequest({
      path: '/api/viral-replications/rep-1/video-link',
      method: 'POST',
      headers: { 'accept-language': 'zh-CN' },
      body: { shareText: ' 复制打开抖音 https://v.douyin.com/abc/ ' },
    })
    const response = await POST(request, { params: Promise.resolve({ id: 'rep-1' }) })
    expect(response.status).toBe(202)
    expect(serviceMock.importViralReplicationVideoFromLink).toHaveBeenCalledWith({
      id: 'rep-1',
      userId: 'user-1',
      shareText: '复制打开抖音 https://v.douyin.com/abc/',
      locale: 'zh',
      signal: request.signal,
    })
    expect(await response.json()).toMatchObject({
      replication: { status: 'analyzing', taskId: 'task-link-1' },
    })
  })

  it.each([
    ['empty', { shareText: '' }],
    ['missing', {}],
    ['extra long', { shareText: 'x'.repeat(4_001) }],
  ])('rejects %s share-link input before calling the service', async (_label, body) => {
    const { POST } = await import('@/app/api/viral-replications/[id]/video-link/route')
    const response = await POST(buildMockRequest({
      path: '/api/viral-replications/rep-1/video-link',
      method: 'POST',
      body,
    }), { params: Promise.resolve({ id: 'rep-1' }) })
    expect(response.status).toBe(400)
    expect(serviceMock.importViralReplicationVideoFromLink).not.toHaveBeenCalled()
  })

  it('retries a failed analysis using the owner-scoped lifecycle service', async () => {
    const { POST } = await import('@/app/api/viral-replications/[id]/retry/route')
    const request = buildMockRequest({
      path: '/api/viral-replications/rep-1/retry', method: 'POST', headers: { 'accept-language': 'zh-CN' },
    })
    const response = await POST(request, { params: Promise.resolve({ id: 'rep-1' }) })
    expect(response.status).toBe(202)
    expect(serviceMock.retryViralReplication).toHaveBeenCalledWith({
      id: 'rep-1', userId: 'user-1', locale: 'zh',
    })
    expect(await response.json()).toMatchObject({ replication: { status: 'analyzing', taskId: 'task-retry-1' } })
  })

  it('confirms the latest brief and queues original storyboard generation', async () => {
    const { POST } = await import('@/app/api/viral-replications/[id]/generate/route')
    const request = buildMockRequest({
      path: '/api/viral-replications/rep-1/generate', method: 'POST',
      headers: { 'accept-language': 'zh-CN' }, body: { brief: ' 最新原创方向 ' },
    })
    const response = await POST(request, { params: Promise.resolve({ id: 'rep-1' }) })
    expect(response.status).toBe(202)
    expect(serviceMock.generateViralReplication).toHaveBeenCalledWith({
      id: 'rep-1', userId: 'user-1', locale: 'zh', brief: '最新原创方向',
    })
    expect(await response.json()).toMatchObject({ replication: { status: 'generating', taskId: 'task-generate-1' } })
  })

  it('rejects generate fields other than a valid brief', async () => {
    const { POST } = await import('@/app/api/viral-replications/[id]/generate/route')
    const response = await POST(buildMockRequest({
      path: '/api/viral-replications/rep-1/generate', method: 'POST',
      body: { brief: '方向', status: 'completed' },
    }), { params: Promise.resolve({ id: 'rep-1' }) })
    expect(response.status).toBe(400)
    expect(serviceMock.generateViralReplication).not.toHaveBeenCalled()
  })
})
