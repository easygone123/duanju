import { NextResponse, type NextRequest } from 'next/server'
import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { getOwnedViralReplicationDetail, updateViralReplicationBrief } from '@/lib/viral-replication/service'
import { readJsonObject } from '@/lib/viral-replication/request-json'

export const GET = apiHandler(async (_request: NextRequest, context) => {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const { id } = await context.params
  const replication = await getOwnedViralReplicationDetail(String(id), auth.session.user.id)
  return NextResponse.json({ replication })
})

export const PATCH = apiHandler(async (request: NextRequest, context) => {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const body = await readJsonObject(request)
  const keys = Object.keys(body)
  const brief = typeof body.brief === 'string' ? body.brief.trim() : ''
  if (keys.length !== 1 || keys[0] !== 'brief' || !brief || brief.length > 2_000) {
    throw new ApiError('INVALID_PARAMS', { code: 'VIRAL_BRIEF_INVALID', field: 'brief' })
  }
  const { id } = await context.params
  const replication = await updateViralReplicationBrief({ id: String(id), userId: auth.session.user.id, brief })
  return NextResponse.json({ replication })
})
