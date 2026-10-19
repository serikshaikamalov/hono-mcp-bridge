import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { collectTools, defaultToolName, describeTool, mountMcp, zValidator } from '../src/index.js'

function buildApp() {
  const app = new Hono()

  app.get(
    '/tours',
    describeTool('Search tours'),
    zValidator('query', z.object({ month: z.coerce.number(), maxPrice: z.coerce.number().optional() })),
    (c) => c.json({ query: c.req.valid('query') }),
  )
  app.get('/tours/:id', (c) => c.json({ id: c.req.param('id') }))
  app.post(
    '/bookings',
    zValidator('json', z.object({ tourId: z.number(), fullName: z.string().min(2) })),
    (c) => c.json({ booked: c.req.valid('json') }, 201),
  )
  app.delete('/bookings/:id', (c) => c.body(null, 204))
  app.get('/secret', describeTool({ hidden: true }), (c) => c.text('nope'))
  app.get('/me', (c) => c.json({ auth: c.req.header('authorization') ?? null }))

  const api = new Hono()
  api.get('/ping', (c) => c.text('pong'))
  app.route('/v1', api)

  return mountMcp(app, { name: 'Test API', version: '1.2.3' })
}

async function rpc(app: Hono, body: unknown, headers: Record<string, string> = {}) {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: res.status === 202 ? null : ((await res.json()) as any) }
}

const call = (name: string, args: unknown, headers?: Record<string, string>) =>
  rpc(buildApp(), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, headers)

describe('collectTools', () => {
  const tools = collectTools(buildApp())
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]))

  test('turns routes into tools, skipping hidden ones and the MCP endpoint', () => {
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['delete_bookings_by_id', 'get_me', 'get_tours', 'get_tours_by_id', 'get_v1_ping', 'post_bookings'].sort(),
    )
  })

  test('uses zod schemas from zValidator', () => {
    expect(byName.get_tours!.description).toBe('Search tours')
    expect(byName.get_tours!.inputSchema).toMatchObject({
      type: 'object',
      properties: { query: { type: 'object', properties: { month: { type: 'number' } }, required: ['month'] } },
      required: ['query'],
    })
    expect(byName.post_bookings!.inputSchema.required).toEqual(['body'])
  })

  test('derives path params when there is no param validator', () => {
    expect(byName.get_tours_by_id!.inputSchema).toMatchObject({
      properties: { params: { properties: { id: { type: 'string' } }, required: ['id'] } },
      required: ['params'],
    })
  })

  test('marks GET as read-only and DELETE as destructive', () => {
    expect(byName.get_tours!.annotations.readOnlyHint).toBe(true)
    expect(byName.delete_bookings_by_id!.annotations.destructiveHint).toBe(true)
  })

  test('include / exclude / methods filters', () => {
    const app = buildApp()
    expect(collectTools(app, { include: ['/tours*'] }).map((t) => t.name)).toEqual(['get_tours', 'get_tours_by_id'])
    expect(collectTools(app, { exclude: ['/bookings*'] }).some((t) => t.path.startsWith('/bookings'))).toBe(false)
    expect(collectTools(app, { methods: ['GET'] }).every((t) => t.method === 'GET')).toBe(true)
  })

  test('default tool names', () => {
    expect(defaultToolName('GET', '/users/:id{[0-9]+}/posts/:slug?')).toBe('get_users_by_id_posts_by_slug')
  })
})

describe('JSON-RPC endpoint', () => {
  test('initialize negotiates protocol version', async () => {
    const { json } = await rpc(buildApp(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    })
    expect(json.result.protocolVersion).toBe('2025-06-18')
    expect(json.result.serverInfo).toEqual({ name: 'Test API', version: '1.2.3' })
  })

  test('notifications get 202 with no body', async () => {
    expect((await rpc(buildApp(), { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)
  })

  test('unknown method and bad JSON', async () => {
    expect((await rpc(buildApp(), { jsonrpc: '2.0', id: 1, method: 'nope' })).json.error.code).toBe(-32601)
    const res = await buildApp().request('/mcp', { method: 'POST', body: '{' })
    expect(res.status).toBe(400)
  })

  test('GET is not supported (no SSE stream)', async () => {
    expect((await buildApp().request('/mcp')).status).toBe(405)
  })

  test('rejects unknown origins when allowedOrigins is set', async () => {
    const app = mountMcp(new Hono(), { allowedOrigins: ['https://ok.dev'] })
    const res = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.dev' })
    expect(res.status).toBe(403)
  })
})

describe('tools/call', () => {
  test('passes query args through the real route and validator', async () => {
    const { json } = await call('get_tours', { query: { month: 3, maxPrice: 2000 } })
    expect(json.result.isError).toBe(false)
    expect(json.result.structuredContent).toEqual({ query: { month: 3, maxPrice: 2000 } })
  })

  test('fills path params', async () => {
    const { json } = await call('get_tours_by_id', { params: { id: 'a b' } })
    expect(json.result.structuredContent).toEqual({ id: 'a b' })
  })

  test('sends JSON body', async () => {
    const { json } = await call('post_bookings', { body: { tourId: 1, fullName: 'Ali' } })
    expect(json.result.structuredContent).toEqual({ booked: { tourId: 1, fullName: 'Ali' } })
  })

  test('validation errors come back as tool errors the agent can read', async () => {
    const { json } = await call('post_bookings', { body: { tourId: 'x' } })
    expect(json.result.isError).toBe(true)
    expect(json.result.content[0].text).toStartWith('HTTP 400:')
  })

  test('forwards the Authorization header', async () => {
    const { json } = await call('get_me', {}, { authorization: 'Bearer abc' })
    expect(json.result.structuredContent).toEqual({ auth: 'Bearer abc' })
  })

  test('unknown tool is a JSON-RPC error', async () => {
    expect((await call('nope', {})).json.error.code).toBe(-32602)
  })
})

describe('official MCP SDK client', () => {
  test('connects, lists tools and calls one', async () => {
    const app = buildApp()
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    })
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    await client.connect(transport)

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain('get_tours')

    const result = await client.callTool({ name: 'get_tours', arguments: { query: { month: 5 } } })
    expect(result.structuredContent).toEqual({ query: { month: 5 } })
    await client.close()
  })
})
