import { NextResponse, type NextRequest } from 'next/server'

import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { resolveTaskLocale } from '@/lib/task/resolve-locale'
import { readJsonObject } from '@/lib/viral-replication/request-json'
import { importViralReplicationVideoFromLink } from '@/lib/viral-replication/service'

export const POST = apiHandler(async (request: NextRequest, context) => {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth

  const body = await readJsonObject(request)
  const shareText = typeof body.shareText === 'string' ? body.shareText.trim() : ''
  if (!shareText || shareText.length > 4_000) {
    throw new ApiError('INVALID_PARAMS', { code: 'VIRAL_LINK_INVALID', field: 'shareText' })
  }

  const { id } = await context.params
  const replication = await importViralReplicationVideoFromLink({
    id: String(id),
    userId: auth.session.user.id,
    shareText,
    locale: resolveTaskLocale(request) ?? 'zh',
    signal: request.signal,
  })
  return NextResponse.json({ replication }, { status: 202 })
})
