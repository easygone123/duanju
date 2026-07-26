import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'

import { createDuanjuMcpServer } from '@/lib/mcp/duanju-server'

describe('createDuanjuMcpServer', () => {
  it('publishes the project analysis and persistence tools', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createDuanjuMcpServer({
      userId: 'user-1',
      userName: 'easygone',
    })
    const client = new Client({
      name: 'duanju-test-client',
      version: '1.0.0',
    })

    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const response = await client.listTools()
    const tools = new Map(response.tools.map((tool) => [tool.name, tool]))

    expect([...tools.keys()]).toEqual([
      'duanju_list_projects',
      'duanju_get_project',
      'duanju_get_episode',
      'duanju_create_project',
      'duanju_create_episode',
      'duanju_update_episode',
      'duanju_upsert_character',
      'duanju_upsert_location',
      'duanju_import_grid_storyboards',
      'duanju_list_tasks',
    ])
    expect(tools.get('duanju_import_grid_storyboards')?.annotations?.destructiveHint).toBe(true)
    expect(tools.get('duanju_get_episode')?.annotations?.readOnlyHint).toBe(true)

    await client.close()
    await server.close()
  })
})
