// ─── Integration Management Routes (ADMIN) ─────────────
// CRUD for payment provider configurations (Cora, Stripe)
// Stores credentials in IntegrationConfig table

import { Router } from 'express';
import { registerIntegrationRoutes } from './integrations.crud.js';
import { registerIntegrationWebhookRoutes } from './integrations.webhooks.js';

const router = Router();

// CRUD routes first: GET / (static), then :provider param routes
registerIntegrationRoutes(router);

// Cora webhook management routes after (literal /cora/webhooks paths)
registerIntegrationWebhookRoutes(router);

export default router;
