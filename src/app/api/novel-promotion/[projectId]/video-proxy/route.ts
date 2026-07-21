import { logInfo as _ulogInfo } from '@/lib/logging/core'
import { NextRequest } from 'next/server'
import { getInternalObjectUrl } from '@/lib/storage'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { prisma } from '@/lib/prisma'

/**
 * 代理下载单个视频文件
 * 用于解决 COS 跨域下载问题
 */
export const GET = apiHandler(async (
    request: NextRequest,
    context: { params: Promise<{ projectId: string }> }
) => {
    const { projectId } = await context.params
    const { searchParams } = new URL(request.url)
    const videoKey = searchParams.get('key')

    if (!videoKey) {
        throw new ApiError('INVALID_PARAMS')
    }

    // 🔐 统一权限验证
    const authResult = await requireProjectAuthLight(projectId)
    if (isErrorResponse(authResult)) return authResult

    const ownedPanel = await prisma.novelPromotionPanel.findFirst({
        where: {
            storyboard: { episode: { novelPromotionProject: { projectId } } },
            OR: [
                { videoUrl: videoKey },
                { lipSyncVideoUrl: videoKey },
            ],
        },
        select: { id: true },
    })
    if (!ownedPanel) throw new ApiError('NOT_FOUND')

    // Use the provider's internal endpoint for storage keys. Going through the
    // public signing route can redirect a server-side request to a browser-only
    // hostname (for example localhost:19000), which makes Docker deployments
    // fail to proxy otherwise valid videos.
    let fetchUrl: string
    if (videoKey.startsWith('http://') || videoKey.startsWith('https://')) {
        fetchUrl = videoKey
    } else {
        fetchUrl = await getInternalObjectUrl(videoKey, 3600)
    }

    _ulogInfo(`[视频代理] 下载: ${fetchUrl.substring(0, 100)}...`)

    const response = await fetch(fetchUrl)
    if (!response.ok) {
        throw new Error(`Failed to fetch video: ${response.statusText}`)
    }

    // 获取内容类型和长度
    const contentType = response.headers.get('content-type') || 'video/mp4'
    const contentLength = response.headers.get('content-length')

    // 流式返回视频数据
    const headers: HeadersInit = {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache'
    }
    if (contentLength) {
        headers['Content-Length'] = contentLength
    }

    return new Response(response.body, { headers })
})
