/**
 * A small tours API exposed to AI agents.
 *
 *   bun run example
 *   npx @modelcontextprotocol/inspector   → connect to http://localhost:3000/mcp
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { describeTool, mountMcp, zValidator } from '../src/index.js'

const tours = [
  { id: 1, title: 'Umrah, 10 days', city: 'Makkah', month: 3, price: 1890 },
  { id: 2, title: 'Umrah + Madinah, 14 days', city: 'Madinah', month: 3, price: 2450 },
  { id: 3, title: 'Istanbul weekend', city: 'Istanbul', month: 5, price: 690 },
]

const app = new Hono()

app.get(
  '/tours',
  describeTool('Search tours by departure month and maximum price in USD.'),
  zValidator(
    'query',
    z.object({
      month: z.coerce.number().int().min(1).max(12).describe('Departure month, 1-12'),
      maxPrice: z.coerce.number().optional().describe('Maximum price in USD'),
    }),
  ),
  (c) => {
    const { month, maxPrice } = c.req.valid('query')
    return c.json({ tours: tours.filter((t) => t.month === month && (!maxPrice || t.price <= maxPrice)) })
  },
)

app.get('/tours/:id', describeTool('Get one tour by its id.'), (c) => {
  const tour = tours.find((t) => t.id === Number(c.req.param('id')))
  return tour ? c.json(tour) : c.json({ error: 'Tour not found' }, 404)
})

app.post(
  '/bookings',
  describeTool('Book a tour for a traveller. Returns the booking id.'),
  zValidator(
    'json',
    z.object({
      tourId: z.number().int(),
      fullName: z.string().min(2).describe('Traveller full name as in passport'),
      phone: z.string().describe('Phone in international format, e.g. +77001234567'),
    }),
  ),
  (c) => c.json({ bookingId: crypto.randomUUID(), ...c.req.valid('json') }, 201),
)

// Internal route: never shown to agents.
app.get('/admin/stats', describeTool({ hidden: true }), (c) => c.json({ ok: true }))

mountMcp(app, { name: 'Tours API', version: '1.0.0' })

export default { port: 3000, fetch: app.fetch }
