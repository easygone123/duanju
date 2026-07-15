import { NextResponse, type NextRequest } from 'next/server'
import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { ASPECT_RATIO_CONFIGS, isArtStyleValue } from '@/lib/constants'
import { createViralReplication } from '@/lib/viral-replication/service'

export const POST = apiHandler(async (request: NextRequest) => {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth

  const body = await request.json() as Record<string, unknown>
  const brief = typeof body.brief === 'string' ? body.brief.trim() : ''
  if (!brief || brief.length > 2_000) {
    throw new ApiError('INVALID_PARAMS', { code: 'VIRAL_BRIEF_INVALID', field: 'brief' })
  }
  if (typeof body.videoRatio !== 'string' || !ASPECT_RATIO_CONFIGS[body.videoRatio]) {
    throw new ApiError('INVALID_PARAMS', { code: 'VIRAL_VIDEO_RATIO_INVALID', field: 'videoRatio' })
  }
  if (!isArtStyleValue(body.artStyle)) {
    throw new ApiError('INVALID_PARAMS', { code: 'VIRAL_ART_STYLE_INVALID', field: 'artStyle' })
  }

  const replication = await createViralReplication({
    userId: auth.session.user.id,
    brief,
    videoRatio: body.videoRatio,
    artStyle: body.artStyle,
  })
  return NextResponse.json({ replication }, { status: 201 })
})
