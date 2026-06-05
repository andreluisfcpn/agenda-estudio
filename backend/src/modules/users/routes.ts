import { Router } from 'express';
import { registerUserListingRoutes } from './users.listing.js';
import { registerUserCrudRoutes } from './users.crud.js';

const router = Router();

// Static routes first (before :id param routes)
registerUserListingRoutes(router); // GET / | GET /:id

// Param / mutation routes after
registerUserCrudRoutes(router);    // POST / | PATCH /:id | DELETE /:id

export default router;
