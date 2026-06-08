-- Service-catalog metadata on add-ons (two families via `monthly`): admin-editable
-- display + monthly service-contract config. Idempotent (IF NOT EXISTS) so it is safe
-- to re-run on every deploy.
ALTER TABLE "addon_config" ADD COLUMN IF NOT EXISTS "active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "addon_config" ADD COLUMN IF NOT EXISTS "sort_order" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "addon_config" ADD COLUMN IF NOT EXISTS "icon" TEXT DEFAULT 'Sparkles';
ALTER TABLE "addon_config" ADD COLUMN IF NOT EXISTS "show_on_landing" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "addon_config" ADD COLUMN IF NOT EXISTS "benefits" TEXT;
ALTER TABLE "addon_config" ADD COLUMN IF NOT EXISTS "durations_offered" TEXT NOT NULL DEFAULT '3,6';
ALTER TABLE "addon_config" ADD COLUMN IF NOT EXISTS "plans_allowed" TEXT NOT NULL DEFAULT 'FULL';
ALTER TABLE "addon_config" ADD COLUMN IF NOT EXISTS "billing_cadence" TEXT NOT NULL DEFAULT 'BILLING_CYCLE_28';

-- Enable the monthly self-serve config on the existing social-media service (metadata
-- only — never touches admin-edited price/name/description).
UPDATE "addon_config" SET
  "plans_allowed" = 'MONTHLY,FULL',
  "billing_cadence" = 'CALENDAR_MONTH',
  "icon" = 'Share2',
  "durations_offered" = '3,6',
  "benefits" = '["Criação de artes para publicação","Contato e agendamento com os convidados","Making-of e bastidores das gravações","Cortes e edição com foco em alcance","Otimização de SEO, títulos e descrições","Relatório mensal de métricas e crescimento"]'
WHERE "key" = 'GESTAO_SOCIAL';

-- New monthly service: traffic/ads management (price is a placeholder — admin can edit).
INSERT INTO "addon_config"
  ("key","name","price","description","monthly","active","sort_order","icon","show_on_landing","benefits","durations_offered","plans_allowed","billing_cadence","updated_at")
VALUES
  ('GESTAO_TRAFEGO','Gestão de Tráfego e Anúncios',150000,
   'Gestão completa de campanhas de anúncios (Meta e Google) para o seu podcast: criativos, segmentação e otimização contínua para escalar alcance e audiência.',
   true,true,0,'TrendingUp',true,
   '["Criação de criativos para anúncios","Segmentação e públicos estratégicos","Gestão e otimização contínua das campanhas","Relatório mensal de resultados (ROAS)"]',
   '3,6','MONTHLY,FULL','CALENDAR_MONTH', now())
ON CONFLICT ("key") DO NOTHING;
