import { Router } from 'express';
import { registerCreationRoutes } from './contract.creation';
import { registerCheckRoutes } from './contract.checks';
import { registerLifecycleRoutes } from './contract.lifecycle';
import { registerPaymentRoutes } from './contract.payments';
import { registerServiceRoutes } from './contract.services';

const router = Router();

// Static routes first (before :id param routes)
registerCreationRoutes(router);   // POST /, /self, /custom
registerCheckRoutes(router);      // POST /check-fixo, /custom/check
registerServiceRoutes(router);    // POST /service

// Param routes last
registerLifecycleRoutes(router);  // GET /, /my, /:id | PATCH /:id | DELETE /:id | POST /:id/request-cancellation, /:id/resolve-cancellation, /:id/renew | PATCH /:id/pause, /:id/resume
registerPaymentRoutes(router);    // POST /:id/pay, /:id/confirm-payment, /:id/subscribe, /:id/client-renew

export default router;
