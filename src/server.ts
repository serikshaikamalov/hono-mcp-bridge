import type { Context, Handler, Hono } from 'hono'
import { collectTools, type CollectOptions, type RouteTool } from './collect.js'
import { ENDPOINT_META } from './meta.js'

export interface McpOptions extends CollectOptions {
  /** Where the MCP endpoint is mounted. Default: `/mcp`. */
  path?: string
  /** Server name shown in the agent's UI. */
  name?: string
  /** Server version. */
  version?: string
  /** Free-form instructions sent to the agent on connect. */
  instructions?: string
  /**
   * Headers copied from the MCP request onto each tool call, so your existing
   * auth middleware sees the agent's credentials. Default: authorization, cookie.
   */
  forwardHeaders?: string[]
  /**
   * If set, requests with an `Origin` header outside this list are rejected (403).
   * Recommended when serving on localhost, to block DNS-rebinding attacks.
   */
  allowedOrigins?: string[]
}

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26']

type JsonRpcId = string | number | null
interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method: string
  params?: any
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Builds a Hono handler that serves the given app's routes as MCP tools
 * over Streamable HTTP (stateless, JSON responses).
 */
export function createMcpHandler(app: Hono<any, any, any>, options: McpOptions = {}): Handler {
  const forwardHeaders = (options.forwardHeaders ?? ['authorization', 'cookie']).map((h) => h.toLowerCase())
  let tools: RouteTool[] | undefined
  // Collected lazily so routes registered after mountMcp() are included too.
  const getTools = () => (tools ??= collectTools(app, options))

  const handler: Handler = async (c) => {
    if (c.req.method !== 'POST') {
      return c.text('Method Not Allowed', 405, { Allow: 'POST' })
    }

    const origin = c.req.header('origin')
    if (options.allowedOrigins && origin && !options.allowedOrigins.includes(origin)) {
      return c.json(rpcError(null, -32000, 'Origin not allowed'), 403)
    }

    let payload: unknown
    try {
      payload = await c.req.json()
    } catch {
      return c.json(rpcError(null, -32700, 'Parse error'), 400)
    }

    const messages = Array.isArray(payload) ? payload : [payload]
    const responses = (await Promise.all(messages.map((m) => handleMessage(m, c)))).filter((r) => r !== null)

    if (!responses.length) return c.body(null, 202)
    return c.json(Array.isArray(payload) ? responses : responses[0])
  }

  async function handleMessage(message: unknown, c: Context): Promise<object | null> {
    if (!isRequest(message)) return rpcError(null, -32600, 'Invalid Request')
    const { id, method, params } = message
    // Notifications (no id) get no response.
    if (id === undefined) return null

    try {
      return { jsonrpc: '2.0', id, result: await dispatch(method, params ?? {}, c) }
    } catch (err) {
      if (err instanceof RpcError) return rpcError(id, err.code, err.message)
      return rpcError(id, -32603, err instanceof Error ? err.message : 'Internal error')
    }
  }

  async function dispatch(method: string, params: any, c: Context): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion
        return {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: options.name ?? 'hono-mcp-bridge', version: options.version ?? '0.0.0' },
          ...(options.instructions ? { instructions: options.instructions } : {}),
        }
      }
      case 'ping':
        return {}
      case 'tools/list':
        return {
          tools: getTools().map(({ name, title, description, inputSchema, annotations }) => ({
            name,
            ...(title ? { title } : {}),
            description,
            inputSchema,
            annotations,
          })),
        }
      case 'tools/call': {
        const tool = getTools().find((t) => t.name === params.name)
        if (!tool) throw new RpcError(-32602, `Unknown tool: ${params.name}`)
        return callTool(tool, params.arguments ?? {}, c)
      }
      default:
        throw new RpcError(-32601, `Method not found: ${method}`)
    }
  }

  async function callTool(tool: RouteTool, args: Record<string, any>, c: Context) {
    const url = new URL(c.req.url)
    url.pathname = fillPath(tool.path, args.params ?? {})
    url.search = ''
    for (const [key, value] of Object.entries(args.query ?? {})) appendQuery(url.searchParams, key, value)

    const headers = new Headers({ accept: 'application/json', 'x-mcp-tool': tool.name })
    for (const name of forwardHeaders) {
      const value = c.req.header(name)
      if (value) headers.set(name, value)
    }

    const init: RequestInit = { method: tool.method, headers }
    if (args.body !== undefined && tool.method !== 'GET') {
      headers.set('content-type', 'application/json')
      init.body = JSON.stringify(args.body)
    }

    const res = await app.fetch(new Request(url, init), c.env, executionCtx(c))
    const text = await res.text()
    const structured = parseObject(text, res.headers.get('content-type'))

    return {
      content: [{ type: 'text', text: res.ok ? text : `HTTP ${res.status}: ${text}` }],
      ...(structured ? { structuredContent: structured } : {}),
      isError: !res.ok,
    }
  }

  ;(handler as any)[ENDPOINT_META] = true
  return handler
}

/**
 * Exposes the app's routes as MCP tools at `options.path` (default `/mcp`).
 *
 * ```ts
 * mountMcp(app, { name: 'Tours API', include: ['/tours*'] })
 * ```
 */
export function mountMcp<T extends Hono<any, any, any>>(app: T, options: McpOptions = {}): T {
  app.on(['POST', 'GET', 'DELETE'], options.path ?? '/mcp', createMcpHandler(app, options))
  return app
}

function fillPath(path: string, params: Record<string, unknown>): string {
  return path.replace(/\/:([A-Za-z0-9_]+)(?:\{[^}]*\})?(\?)?/g, (_, name: string) => {
    const value = params[name]
    return value === undefined || value === null ? '' : `/${encodeURIComponent(String(value))}`
  })
}

function appendQuery(search: URLSearchParams, key: string, value: unknown) {
  if (value === undefined || value === null) return
  if (Array.isArray(value)) return value.forEach((v) => appendQuery(search, key, v))
  search.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
}

function parseObject(text: string, contentType: string | null): Record<string, unknown> | undefined {
  if (!contentType?.includes('json')) return undefined
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function executionCtx(c: Context) {
  try {
    return c.executionCtx
  } catch {
    // Not running on a platform with an execution context (Bun, Node).
    return undefined
  }
}

function isRequest(m: unknown): m is JsonRpcRequest {
  return !!m && typeof m === 'object' && (m as any).jsonrpc === '2.0' && typeof (m as any).method === 'string'
}

function rpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}
