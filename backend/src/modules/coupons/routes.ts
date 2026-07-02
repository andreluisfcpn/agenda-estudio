import { Router } from 'express';
import clientRoutes from './coupons.client.js';
import adminRoutes from './coupons.admin.js';

const router = Router();

// Static routes (/validate) BEFORE parametric ones (/:id) — repo convention.
router.use(clientRoutes);
router.use(adminRoutes);

export default router;
