/** Attached to validator middleware so the bridge can read the schema back. */
export const VALIDATOR_META = Symbol.for('hono-mcp-bridge.validator')
/** Attached to describeTool() middleware. */
export const TOOL_META = Symbol.for('hono-mcp-bridge.tool')
/** Attached to the MCP endpoint handler so it never exposes itself as a tool. */
export const ENDPOINT_META = Symbol.for('hono-mcp-bridge.endpoint')

export type BridgedTarget = 'param' | 'query' | 'json'

export interface ValidatorMeta {
  target: string
  /** A zod v4 schema (v3 schemas are accepted by the validator but not bridged). */
  schema: unknown
}

export interface ToolMeta {
  /** Tool name shown to the agent. Defaults to one derived from method + path. */
  name?: string
  /** Human-readable title. */
  title?: string
  /** What the tool does. Agents rely on this to decide when to call it — write it for them. */
  description?: string
  /** Hide this route from agents even if it matches `include`. */
  hidden?: boolean
}

export function readMeta<T>(fn: unknown, key: symbol): T | undefined {
  return typeof fn === 'function' ? ((fn as any)[key] as T | undefined) : undefined
}
