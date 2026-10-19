import { zValidator as baseZValidator } from '@hono/zod-validator'
import type { MiddlewareHandler } from 'hono'
import { TOOL_META, VALIDATOR_META, type ToolMeta, type ValidatorMeta } from './meta.js'

/**
 * Drop-in replacement for `zValidator` from `@hono/zod-validator`.
 * Same signature, same types, same runtime behaviour — it only remembers
 * the schema so `mountMcp()` can turn it into a tool input schema.
 *
 * ```ts
 * - import { zValidator } from '@hono/zod-validator'
 * + import { zValidator } from 'hono-mcp-bridge'
 * ```
 */
export const zValidator: typeof baseZValidator = ((...args: Parameters<typeof baseZValidator>) => {
  const middleware = (baseZValidator as any)(...args)
  const [target, schema] = args
  middleware[VALIDATOR_META] = { target, schema } satisfies ValidatorMeta
  return middleware
}) as typeof baseZValidator

/**
 * Optional middleware that names and describes a route for agents.
 * It does nothing at request time.
 *
 * ```ts
 * app.get('/tours', describeTool({ description: 'Search tours by month and price' }), ...)
 * ```
 */
export function describeTool(meta: ToolMeta | string): MiddlewareHandler {
  const middleware: MiddlewareHandler = async (_c, next) => {
    await next()
  }
  ;(middleware as any)[TOOL_META] = typeof meta === 'string' ? { description: meta } : meta
  return middleware
}
