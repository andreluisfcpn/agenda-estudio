// ─── Production Seed (hardened) ─────────────────────────────────────────────
// Idempotent: never wipes data. Seeds operational config (business rules,
// pricing, payment methods, add-ons) + ONE admin with a STRONG password passed
// via env (SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD). No test/client accounts.
// Payment integrations are created DISABLED (enable after adding credentials in
// Admin > Integrações). Safe to re-run.
import "dotenv/config";
import { PrismaClient, Role } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import bcrypt from "bcryptjs";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL || "admin@studio.com";
  const adminPasswordPlain = process.env.SEED_ADMIN_PASSWORD;
  if (!adminPasswordPlain || adminPasswordPlain.length < 12) {
    throw new Error("SEED_ADMIN_PASSWORD env var required (>= 12 chars).");
  }

  console.log("🌱 Production seed (idempotent, no wipe)...");

  // ─── Admin (upsert — never overwrite an existing one) ───────
  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (existing) {
    console.log(`  ⏭️  Admin ${adminEmail} já existe — mantido (senha não alterada).`);
  } else {
    const passwordHash = await bcrypt.hash(adminPasswordPlain, 12);
    await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash,
        name: "Administrador",
        role: Role.ADMIN,
      },
    });
    console.log(`  ✅ Admin criado: ${adminEmail}`);
  }

  // ─── Business Config ────────────────────────────────────────
  const configEntries = [
    { key: "time_slots", value: "10:00,13:00,15:30,18:00,20:30", type: "string", label: "Horários dos Blocos", group: "schedule" },
    { key: "slot_duration_hours", value: "2", type: "number", label: "Duração do Bloco (horas)", group: "schedule" },
    { key: "comercial_slots", value: "10:00,13:00,15:30", type: "string", label: "Horários Faixa Comercial", group: "schedule" },
    { key: "audiencia_slots", value: "18:00,20:30", type: "string", label: "Horários Faixa Audiência", group: "schedule" },
    { key: "operating_days", value: "1,2,3,4,5,6", type: "string", label: "Dias de Funcionamento (1=Seg…6=Sáb)", group: "schedule" },
    { key: "close_time", value: "23:00", type: "string", label: "Horário de Fechamento", group: "schedule" },
    { key: "gateway_stripe_fee_pct", value: "4", type: "percent", label: "Taxa Stripe (%)", group: "gateway" },
    { key: "gateway_cora_fee_cents", value: "200", type: "number", label: "Taxa Cora por Boleto (centavos)", group: "gateway" },
    { key: "card_installment_surcharges", value: JSON.stringify({ "1": 0, "2": 6, "3": 8, "4": 9, "5": 10, "6": 12, "7": 13, "8": 14, "9": 16, "10": 17, "11": 19, "12": 20 }), type: "json", label: "Taxas de Parcelamento Cartão (%)", group: "gateway" },
    { key: "first_booking_min_days", value: "1", type: "number", label: "Dias mín. p/ 1º agendamento", group: "schedule" },
    { key: "first_booking_max_days", value: "14", type: "number", label: "Dias máx. p/ 1º agendamento", group: "schedule" },
    { key: "booking_min_advance_minutes", value: "30", type: "number", label: "Antecedência mínima (min)", group: "schedule" },
    { key: "reschedule_min_hours", value: "24", type: "number", label: "Antecedência mín. p/ reagendar (h)", group: "schedule" },
    { key: "reschedule_max_days", value: "7", type: "number", label: "Janela de reagendamento (dias)", group: "schedule" },
    { key: "sessions_per_month", value: "4", type: "number", label: "Sessões por mês", group: "schedule" },
    { key: "discount_3months", value: "30", type: "percent", label: "Desconto Fidelidade 3 meses (%)", group: "gateway" },
    { key: "discount_6months", value: "40", type: "percent", label: "Desconto Fidelidade 6 meses (%)", group: "gateway" },
    { key: "episodes_3months", value: "12", type: "number", label: "Episódios p/ contrato 3 meses", group: "schedule" },
    { key: "episodes_6months", value: "24", type: "number", label: "Episódios p/ contrato 6 meses", group: "schedule" },
    { key: "studio_name", value: "Estúdio Búzios Digital", type: "string", label: "Nome do Estúdio", group: "studio" },
    { key: "studio_logo_url", value: "https://buzios.digital/wp-content/uploads/2025/01/logo-site-branca.svg", type: "string", label: "URL do Logo", group: "studio" },
    { key: "studio_email", value: "contato@buzios.digital", type: "string", label: "E-mail de Contato", group: "studio" },
    { key: "studio_hero_image", value: "https://buzios.digital/wp-content/uploads/elementor/thumbs/bd-estudio-enhanced-sr-r9lm9twze86yo0wxu68fp1e0yf8baho28zrniyf1o0.jpg", type: "string", label: "Imagem Principal", group: "studio" },
    { key: "studio_location", value: "Búzios, RJ", type: "string", label: "Localização", group: "studio" },
  ];
  for (const entry of configEntries) {
    await prisma.businessConfig.upsert({ where: { key: entry.key }, create: entry, update: {} });
  }
  console.log(`  ✅ Business config: ${configEntries.length} chaves`);

  // ─── Pricing ────────────────────────────────────────────────
  const pricingEntries = [
    { tier: "COMERCIAL" as const, price: 30000, label: "Comercial", description: "Faixa horário comercial (10h–17h)" },
    { tier: "AUDIENCIA" as const, price: 40000, label: "Audiência", description: "Faixa prime-time (18h–22h)" },
    { tier: "SABADO" as const, price: 50000, label: "Sábado", description: "Sábado (horário premium)" },
  ];
  for (const entry of pricingEntries) {
    await prisma.pricingConfig.upsert({ where: { tier: entry.tier }, create: entry, update: {} });
  }
  console.log(`  ✅ Pricing: ${pricingEntries.length} tiers`);

  // ─── Add-ons ────────────────────────────────────────────────
  const addonEntries = [
    { key: "CORTES_IA", name: "Cortes com IA", price: 30000, description: "Cortes automáticos do episódio usando IA para shorts e reels.", monthly: false },
    { key: "CORTES_HUMANO", name: "Cortes por Editor", price: 800000, description: "Cortes manuais por editor profissional com curadoria e storytelling.", monthly: false },
    { key: "GESTAO_SOCIAL", name: "Gestão de Redes Sociais", price: 200000, description: "Gestão completa das redes sociais do podcast: postagens, stories, engajamento e relatórios.", monthly: true },
    { key: "YOUTUBE_SEO", name: "YouTube SEO", price: 20000, description: "Otimização de título, descrição, tags e thumbnail para ranquear no YouTube.", monthly: false },
    { key: "PAUTAS", name: "Roteiro & Pautas", price: 90000, description: "Criação de roteiro e pauta para cada episódio.", monthly: false },
  ];
  for (const entry of addonEntries) {
    await prisma.addOnConfig.upsert({ where: { key: entry.key }, create: entry, update: {} });
  }
  console.log(`  ✅ Add-ons: ${addonEntries.length} serviços`);

  // ─── Payment methods ────────────────────────────────────────
  const paymentMethods = [
    { key: "PIX", label: "PIX", shortLabel: "PIX", emoji: "⚡", description: "Pagamento instantâneo", color: "#22c55e", active: true, sortOrder: 0, accessMode: "FULL" },
    { key: "CARTAO", label: "Cartão de Crédito", shortLabel: "Cartão", emoji: "💳", description: "Crédito ou débito", color: "#8b5cf6", active: true, sortOrder: 1, accessMode: "FULL" },
    { key: "BOLETO", label: "Boleto Bancário", shortLabel: "Boleto", emoji: "📄", description: "Compensação em até 3 dias úteis", color: "#f59e0b", active: true, sortOrder: 2, accessMode: "PROGRESSIVE" },
  ];
  for (const pm of paymentMethods) {
    await prisma.paymentMethodConfig.upsert({ where: { key: pm.key }, create: pm, update: {} });
  }
  console.log(`  ✅ Métodos de pagamento: ${paymentMethods.length}`);

  // ─── Integrations (DISABLED — configure + enable via Admin) ──
  const integrations = [
    { provider: "STRIPE", enabled: false, environment: "production", config: "{}" },
    { provider: "CORA", enabled: false, environment: "production", config: "{}" },
  ];
  for (const intg of integrations) {
    await prisma.integrationConfig.upsert({ where: { provider: intg.provider }, create: intg, update: {} });
  }
  console.log(`  ✅ Integrações criadas DESABILITADAS (Stripe/Cora) — configure no Admin`);

  console.log("\n✨ Seed de produção concluído.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
