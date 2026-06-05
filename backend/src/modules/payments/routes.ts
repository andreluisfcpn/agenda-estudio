import { Router } from 'express';
import { registerPaymentAdminRoutes } from './payments.admin.js';
import { registerPaymentClientRoutes } from './payments.client.js';

const router = Router();

// Admin routes: GET / list, GET /summary (static), PATCH /:id (param)
registerPaymentAdminRoutes(router);

// Client routes: GET /sandbox-mode (static) before GET /:id/status, POST /:id/simulate (param)
registerPaymentClientRoutes(router);

export default router;
