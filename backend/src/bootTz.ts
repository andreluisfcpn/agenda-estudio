// B6: pin the process timezone to UTC before any Date is constructed.
//
// The whole backend assumes the server runs in UTC (see lib/spTime.ts) and uses
// getUTCDay()/getDay() interchangeably for "weekday of a calendar date" — which is
// only consistent when the process TZ is UTC. Booking dates are stored as @db.Date
// at 00:00Z, so reading their weekday must be done in UTC. On a non-UTC host those
// reads would drift by a day; forcing UTC here makes every weekday computation
// correct regardless of the host's timezone.
//
// This module MUST be imported first in the entrypoint (before any module that
// constructs a Date at import time). Setting process.env.TZ takes effect for all
// subsequently-created Dates. Intl-based SP-calendar helpers pass an explicit
// timeZone and are unaffected either way. An operator can still override TZ
// deliberately by setting it in the environment.
process.env.TZ = process.env.TZ || 'UTC';
