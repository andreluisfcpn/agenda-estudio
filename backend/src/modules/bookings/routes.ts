import { Router } from 'express';
import { registerAvailabilityRoutes } from './booking.availability.js';
import { registerCreationRoutes } from './booking.creation.js';
import { registerStatusRoutes } from './booking.status.js';
import { registerManagementRoutes } from './booking.management.js';

const router = Router();

// Static routes first (before :id param routes)
registerAvailabilityRoutes(router); // GET /public-availability, /availability
registerCreationRoutes(router);     // POST /, /bulk, /admin

// Param routes after static ones
registerStatusRoutes(router);       // POST /:id/complete-payment | PATCH /:id/confirm | PUT /:id/client-cancel, check-in, complete, mark-falta
registerManagementRoutes(router);   // GET /my, / | PATCH /:id, /:id/client-update, /:id/reschedule | POST /:id/addons | DELETE /:id, /:id/hard-delete

export default router;
