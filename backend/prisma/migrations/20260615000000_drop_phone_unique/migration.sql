-- Phone is no longer a login identifier (login is by e-mail/OTP/Google); it stays
-- only as an optional profile contact field. Drop its unique index (idempotent).
DROP INDEX IF EXISTS "users_phone_key";
