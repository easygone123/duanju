import { NextRequest, NextResponse } from 'next/server'

import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { apiHandler } from '@/lib/api-errors'
import { probeOwnedConnection } from '@/lib/comfyui/connection-service'

type ConnectionContext = { params: Promise<{ connectionId: string }> }

export const POST = apiHandler(async (_request: NextRequest, context: ConnectionContext) => {
  const authResult = await requireUserAuth()
  if (isErrorResponse(authResult)) return authResult
  const { connectionId } = await context.params
  const health = await probeOwnedConnection(authResult.session.user.id, connectionId)
  return NextResponse.json({ health })
})
