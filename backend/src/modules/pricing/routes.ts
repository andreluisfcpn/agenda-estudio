import { Router } from 'express';
import { registerTiersRoutes } from './pricing.tiers.js';
import { registerMethodsRoutes } from './pricing.methods.js';
import { registerConfigRoutes } from './pricing.config.js';

const router = Router();

// All pricing paths use disjoint prefixes (/, /addons, /payment-methods*, /business-config*),
// so registration order has no effect on Express matching. Within each module the original
// route order is preserved verbatim.
registerTiersRoutes(router);   // GET / [PUBLIC] | PUT /
registerMethodsRoutes(router); // GET/PUT /addons | GET /payment-methods [PUBLIC] | GET /payment-methods/all | PUT /payment-methods
registerConfigRoutes(router);  // GET /business-config/public [PUBLIC] | GET/PUT /business-config

export default router;
