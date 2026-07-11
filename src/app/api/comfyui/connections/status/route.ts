import { NextResponse } from 'next/server'

import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { apiHandler } from '@/lib/api-errors'
import { probeOwnedConnectionStatuses } from '@/lib/comfyui/connection-service'

export const GET = apiHandler(async () => {
  const authResult = await requireUserAuth()
  if (isErrorResponse(authResult)) return authResult
  const statuses = await probeOwnedConnectionStatuses(authResult.session.user.id)
  return NextResponse.json({ statuses })
})
