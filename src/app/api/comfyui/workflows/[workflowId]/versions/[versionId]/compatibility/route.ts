import { NextRequest, NextResponse } from 'next/server'
import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { apiHandler } from '@/lib/api-errors'
import { listOwnedWorkflowCompatibility } from '@/lib/comfyui/workflow-compatibility-service'

type Context = { params: Promise<{ workflowId: string; versionId: string }> }

export const GET = apiHandler(async (request: NextRequest, context: Context) => {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const { workflowId, versionId } = await context.params
  const url = new URL(request.url)
  const requestedLimit = Number(url.searchParams.get('limit') ?? 20)
  const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(50, requestedLimit)) : 20
  const rawCursor = url.searchParams.get('cursor')
  const cursor = rawCursor && rawCursor.length <= 200 ? rawCursor : undefined
  return NextResponse.json(await listOwnedWorkflowCompatibility(
    auth.session.user.id, workflowId, versionId, { cursor, limit, signal: request.signal },
  ))
})
