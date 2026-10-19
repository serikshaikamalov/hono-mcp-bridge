import type { Hono } from 'hono'
import { z } from 'zod'
import {
  ENDPOINT_META,
  TOOL_META,
  VALIDATOR_META,
  readMeta,
  type BridgedTarget,
  type ToolMeta,
  type ValidatorMeta,
} from './meta.js'

type JsonSchema = Record<string, unknown>

export interface RouteTool {
  name: string
  title?: string
  description: string
  method: string
  path: string
  inputSchema: JsonSchema & { type: 'object' }
  annotations: Record<string, unknown>
}

export interface CollectOptions {
  /** Path patterns to expose, `*` matches anything. Default: every route. */
  include?: string[]
  /** Path patterns to hide. Applied after `include`. */
  exclude?: string[]
  /** HTTP methods to expose. Default: GET, POST, PUT, PATCH, DELETE. */
  methods?: string[]
  /** Custom tool naming. Default: `get_tours_by_id` for `GET /tours/:id`. */
  toolName?: (route: { method: string; path: string }) => string
}

const DEFAULT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

/** Validation target → key in the tool's input object. */
const ARG_KEYS: Record<BridgedTarget, string> = { param: 'params', query: 'query', json: 'body' }

export function collectTools(app: Hono<any, any, any>, options: CollectOptions = {}): RouteTool[] {
  const methods = (options.methods ?? DEFAULT_METHODS).map((m) => m.toUpperCase())
  const groups = new Map<string, { method: string; path: string; handlers: unknown[] }>()

  for (const route of app.routes) {
    if (!methods.includes(route.method) || route.path.includes('*')) continue
    const key = `${route.method} ${route.path}`
    const group = groups.get(key) ?? { method: route.method, path: route.path, handlers: [] }
    group.handlers.push(route.handler)
    groups.set(key, group)
  }

  const tools: RouteTool[] = []
  const usedNames = new Set<string>()

  for (const { method, path, handlers } of groups.values()) {
    if (handlers.some((h) => readMeta(h, ENDPOINT_META))) continue
    if (options.include && !options.include.some((p) => matchPath(p, path))) continue
    if (options.exclude?.some((p) => matchPath(p, path))) continue

    const meta: ToolMeta = Object.assign({}, ...handlers.map((h) => readMeta<ToolMeta>(h, TOOL_META) ?? {}))
    if (meta.hidden) continue

    const validators = new Map<string, ValidatorMeta>()
    for (const h of handlers) {
      const v = readMeta<ValidatorMeta>(h, VALIDATOR_META)
      if (v) validators.set(v.target, v)
    }

    const name = uniqueName(meta.name ?? options.toolName?.({ method, path }) ?? defaultToolName(method, path), usedNames)
    tools.push({
      name,
      title: meta.title,
      description: meta.description ?? `${method} ${path}`,
      method,
      path,
      inputSchema: buildInputSchema(path, validators),
      annotations: annotationsFor(method, meta.title),
    })
  }

  return tools
}

function buildInputSchema(path: string, validators: Map<string, ValidatorMeta>): RouteTool['inputSchema'] {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []

  const paramSchema = validators.get('param')
    ? toJsonSchema(validators.get('param')!.schema)
    : pathParamsSchema(path)
  if (paramSchema) {
    properties[ARG_KEYS.param] = paramSchema
    if (hasRequired(paramSchema)) required.push(ARG_KEYS.param)
  }

  for (const target of ['query', 'json'] as const) {
    const v = validators.get(target)
    if (!v) continue
    const schema = toJsonSchema(v.schema)
    properties[ARG_KEYS[target]] = schema
    if (hasRequired(schema)) required.push(ARG_KEYS[target])
  }

  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

function toJsonSchema(schema: unknown): JsonSchema {
  // Zod v3 schemas have no `_zod` internals and can't be converted: accept anything.
  if (!schema || typeof schema !== 'object' || !('_zod' in schema)) return { type: 'object' }
  const { $schema: _, ...rest } = z.toJSONSchema(schema as z.ZodType, { io: 'input', unrepresentable: 'any' }) as JsonSchema
  return rest
}

/** `/tours/:id/:slug?` → params schema built from the path itself. */
function pathParamsSchema(path: string): JsonSchema | undefined {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  for (const [, name, optional] of path.matchAll(/:([A-Za-z0-9_]+)(?:\{[^}]*\})?(\?)?/g)) {
    properties[name!] = { type: 'string' }
    if (!optional) required.push(name!)
  }
  if (!Object.keys(properties).length) return undefined
  return { type: 'object', properties, required }
}

function hasRequired(schema: JsonSchema): boolean {
  return Array.isArray(schema.required) && schema.required.length > 0
}

function annotationsFor(method: string, title?: string): Record<string, unknown> {
  const base = title ? { title } : {}
  if (method === 'GET') return { ...base, readOnlyHint: true }
  if (method === 'DELETE') return { ...base, readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  return { ...base, readOnlyHint: false, destructiveHint: false, idempotentHint: method === 'PUT' }
}

export function defaultToolName(method: string, path: string): string {
  const parts = path
    .split('/')
    .filter(Boolean)
    .map((seg) => (seg.startsWith(':') ? `by_${seg.slice(1).replace(/\{.*\}|\?/g, '')}` : seg))
  return [method.toLowerCase(), ...parts].join('_').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
}

function uniqueName(name: string, used: Set<string>): string {
  let candidate = name
  for (let i = 2; used.has(candidate); i++) candidate = `${name.slice(0, 60)}_${i}`
  used.add(candidate)
  return candidate
}

function matchPath(pattern: string, path: string): boolean {
  const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`)
  return regex.test(path)
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}
