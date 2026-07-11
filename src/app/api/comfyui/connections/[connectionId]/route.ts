import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import {
  deleteOwnedConnection,
  getOwnedConnection,
  updateOwnedConnection,
} from '@/lib/comfyui/connection-service'

const credentialsSchema = z.union([
  z.object({ token: z.string().trim().min(1).max(8192) }).strict(),
  z.object({
    username: z.string().trim().min(1).max(512),
    password: z.string().min(1).max(8192),
  }).strict(),
])

const updateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  baseUrl: z.string().trim().min(1).max(2048).optional(),
  authType: z.enum(['none', 'bearer', 'basic']).optional(),
  credentials: credentialsSchema.optional(),
  enabled: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0)

type ConnectionContext = { params: Promise<{ connectionId: string }> }

export const GET = apiHandler(async (_request: NextRequest, context: ConnectionContext) => {
  const authResult = await requireUserAuth()
  if (isErrorResponse(authResult)) return authResult
  const { connectionId } = await context.params
  const connection = await getOwnedConnection(authResult.session.user.id, connectionId)
  return NextResponse.json({ connection })
})

export const PATCH = apiHandler(async (request: NextRequest, context: ConnectionContext) => {
  const authResult = await requireUserAuth()
  if (isErrorResponse(authResult)) return authResult
  const { connectionId } = await context.params
  const parsed = updateSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError('INVALID_PARAMS')
  const connection = await updateOwnedConnection(
    authResult.session.user.id,
    connectionId,
    parsed.data,
  )
  return NextResponse.json({ connection })
})

export const DELETE = apiHandler(async (_request: NextRequest, context: ConnectionContext) => {
  const authResult = await requireUserAuth()
  if (isErrorResponse(authResult)) return authResult
  const { connectionId } = await context.params
  await deleteOwnedConnection(authResult.session.user.id, connectionId)
  return NextResponse.json({ success: true })
})
