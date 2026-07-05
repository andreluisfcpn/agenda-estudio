-- Notification templates: per-event admin overrides (defaults live in the code
-- catalog, config/notificationEventCatalog.ts). A row only stores what the admin
-- changed; null columns mean "use the catalog default". No seed — absence of a
-- row is fully default, and deleting a row restores the default.
CREATE TABLE "notification_templates" (
    "event_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "title" TEXT,
    "message" TEXT,
    "severity" TEXT,
    "push_enabled" BOOLEAN,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("event_key")
);
