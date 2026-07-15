import { NextResponse, type NextRequest } from 'next/server'
import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { apiHandler } from '@/lib/api-errors'
import { resolveTaskLocale } from '@/lib/task/resolve-locale'
import { uploadViralReplicationVideo } from '@/lib/viral-replication/service'

export const PUT = apiHandler(async (request: NextRequest, context) => {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const { id } = await context.params
  const replication = await uploadViralReplicationVideo({
    id: String(id),
    userId: auth.session.user.id,
    request,
    mimeType: request.headers.get('content-type') || '',
    locale: resolveTaskLocale(request) ?? 'zh',
  })
  return NextResponse.json({ replication }, { status: 202 })
})
