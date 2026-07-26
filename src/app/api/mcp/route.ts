import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { NextRequest, NextResponse } from 'next/server'

import { apiHandler } from '@/lib/api-errors'
import {
  authorizeDuanjuMcpRequest,
  DuanjuMcpAuthError,
} from '@/lib/mcp/duanju-auth'
import { createDuanjuMcpServer } from '@/lib/mcp/duanju-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function jsonRpcError(status: number, message: string) {
  return NextResponse.json({
    jsonrpc: '2.0',
    error: {
      code: status === 401 ? -32001 : -32000,
      message,
    },
    id: null,
  }, {
    status,
    headers: status === 401
      ? { 'WWW-Authenticate': 'Bearer realm="duanju-mcp"' }
      : undefined,
  })
}

async function handleMcpRequest(request: NextRequest): Promise<Response> {
  let principal
  try {
    principal = await authorizeDuanjuMcpRequest(request)
  } catch (error) {
    if (error instanceof DuanjuMcpAuthError) {
      return jsonRpcError(error.status, error.message)
    }
    return jsonRpcError(500, 'MCP authorization failed')
  }

  const server = createDuanjuMcpServer(principal)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })

  try {
    await server.connect(transport)
    return await transport.handleRequest(request)
  } catch {
    return jsonRpcError(500, 'MCP request failed')
  }
}

const mcpHandler = apiHandler(async (request: NextRequest) => handleMcpRequest(request))

export const GET = mcpHandler
export const POST = mcpHandler
export const DELETE = mcpHandler
