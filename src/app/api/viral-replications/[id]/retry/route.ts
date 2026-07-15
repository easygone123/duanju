import { NextResponse, type NextRequest } from 'next/server'
import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { apiHandler } from '@/lib/api-errors'
import { resolveTaskLocale } from '@/lib/task/resolve-locale'
import { retryViralReplication } from '@/lib/viral-replication/service'

export const POST = apiHandler(async (request: NextRequest, context) => {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const { id } = await context.params
  const replication = await retryViralReplication({
    id: String(id),
    userId: auth.session.user.id,
    locale: resolveTaskLocale(request) ?? 'zh',
  })
  return NextResponse.json({ replication }, { status: 202 })
})
