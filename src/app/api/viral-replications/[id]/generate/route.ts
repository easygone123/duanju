import { NextResponse, type NextRequest } from 'next/server'
import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { resolveTaskLocale } from '@/lib/task/resolve-locale'
import { generateViralReplication } from '@/lib/viral-replication/service'
import { readJsonObject } from '@/lib/viral-replication/request-json'

export const POST = apiHandler(async (request: NextRequest, context) => {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const body = await readJsonObject(request)
  const keys = Object.keys(body)
  const brief = typeof body.brief === 'string' ? body.brief.trim() : ''
  if (keys.length !== 1 || keys[0] !== 'brief' || !brief || brief.length > 2_000) {
    throw new ApiError('INVALID_PARAMS', { code: 'VIRAL_BRIEF_INVALID', field: 'brief' })
  }
  const { id } = await context.params
  const replication = await generateViralReplication({
    id: String(id),
    userId: auth.session.user.id,
    locale: resolveTaskLocale(request) ?? 'zh',
    brief,
  })
  return NextResponse.json({ replication }, { status: 202 })
})
