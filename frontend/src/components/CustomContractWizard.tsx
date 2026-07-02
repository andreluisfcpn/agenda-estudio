import { getErrorMessage } from "../utils/errors";
import { formatBRL } from "../utils/format";
import React, { useState, useEffect, useRef } from "react";
import BottomSheetModal from "./BottomSheetModal";
import {
  PricingConfig,
  AddOnConfig,
  bookingsApi,
  contractsApi,
  pricingApi,
  CustomContractData,
  CustomConflict,
  stripeApi,
  authApi,
} from "../api/client";
import { useBusinessConfig } from "../hooks/useBusinessConfig";
import { getClientPaymentMethods } from "../constants/paymentMethods";
import StripeCardForm from "./StripeCardForm";
import InlineCheckout from "./InlineCheckout";
import CpfCnpjPrompt from "./CpfCnpjPrompt";
import { useAuth } from "../context/AuthContext";
import { isValidCpfCnpj } from "../utils/mask";
import {
  CheckCircle2,
  CreditCard,
  Lock,
  Calendar,
  CalendarDays,
  Clock,
  AlertTriangle,
  Info,
  Check,
  Plus,
  ShieldCheck,
} from "lucide-react";

export interface CustomContractWizardProps {
  pricing: PricingConfig[];
  onClose: () => void;
  onComplete: () => void;
}

type WizardStep = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

const DAY_NAMES: Record<number, string> = {
  1: "Seg",
  2: "Ter",
  3: "Qua",
  4: "Qui",
  5: "Sex",
  6: "Sáb",
};
const DAY_NAMES_FULL: Record<number, string> = {
  1: "Segunda",
  2: "Terça",
  3: "Quarta",
  4: "Quinta",
  5: "Sexta",
  6: "Sábado",
};
const TIER_INFO: Record<
  string,
  { emoji: string; hours: string; desc: string }
> = {
  COMERCIAL: {
    emoji: "🏢",
    hours: "Horários até 17:30",
    desc: "Grave durante o horário comercial com preços mais acessíveis.",
  },
  AUDIENCIA: {
    emoji: "🎤",
    hours: "Gravações até 23:00",
    desc: "Horários flexíveis ao longo do dia e noite para maior alcance.",
  },
  SABADO: {
    emoji: "🌟",
    hours: "Sábados exclusivos",
    desc: "Gravações exclusivas aos sábados para conteúdo premium.",
  },
};

const POSSIBLE_SLOTS: Record<string, string[]> = {
  COMERCIAL: ["10:00", "13:00", "15:30"],
  AUDIENCIA: ["10:00", "13:00", "15:30", "18:00", "20:30"],
  SABADO: ["10:00", "13:00", "15:30", "18:00", "20:30"],
};

export default function CustomContractWizard({
  pricing,
  onClose,
  onComplete,
}: CustomContractWizardProps) {
  const { user, updateUser } = useAuth();
  const [step, setStep] = useState<WizardStep>(1);
  // PIX needs a CPF/CNPJ — gate the contract creation when it's missing.
  const [showCpfPrompt, setShowCpfPrompt] = useState(false);
  const pendingResolutions = useRef<any[]>([]);

  // Step 1
  const [selectedTier, setSelectedTier] = useState<string>(
    pricing[0]?.tier || "COMERCIAL",
  );
  const [contractName, setContractName] = useState("");
  const [durationMonths, setDurationMonths] = useState(3);
  const [selectedDays, setSelectedDays] = useState<number[]>([]);
  const [dayTimes, setDayTimes] = useState<Record<number, string>>({});

  // Step 2
  const [addons, setAddons] = useState<AddOnConfig[]>([]);
  const [addonConfig, setAddonConfig] = useState<
    Record<string, { mode: "all" | "credits" | "none"; perCycle: number }>
  >({});

  // Step 3
  const [paymentMethod, setPaymentMethod] = useState<"CARTAO" | "PIX" | null>(
    null,
  );
  // Payment plan: MONTHLY (per-cycle, current behavior) or FULL (whole contract upfront).
  const [paymentPlan, setPaymentPlan] = useState<"MONTHLY" | "FULL">("MONTHLY");
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  // Step 7
  const [conflicts, setConflicts] = useState<CustomConflict[]>([]);
  const [resolvedConflicts, setResolvedConflicts] = useState<
    {
      originalDate: string;
      originalTime: string;
      newDate: string;
      newTime: string;
    }[]
  >([]);

  // Submission
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Inline card payment
  const [cardClientSecret, setCardClientSecret] = useState<string | null>(null);
  const [firstPaymentId, setFirstPaymentId] = useState<string | null>(null);
  const [firstPixString, setFirstPixString] = useState<string | null>(null);

  // Cancel confirmation modal
  const [showCancelModal, setShowCancelModal] = useState(false);

  const { get: getRule } = useBusinessConfig();

  useEffect(() => {
    pricingApi
      .getAddons()
      .then((res) => setAddons(res.addons))
      .catch(console.error);
  }, []);

  // ─── Derived Calculations ────────────────────────────
  const tierConfig = pricing.find((p) => p.tier === selectedTier);
  const basePrice = tierConfig?.price || 0;
  const sessionsPerWeek = selectedDays.length;
  const sessionsPerCycle = sessionsPerWeek * 4;
  const totalSessions = sessionsPerCycle * durationMonths;

  // Fidelity discount thresholds & rates come from business config
  // (episodes_3months/6months → discount_3months/6months), no hardcoded rates.
  let discountPct = 0;
  if (totalSessions >= getRule("episodes_6months"))
    discountPct = getRule("discount_6months");
  else if (totalSessions >= getRule("episodes_3months"))
    discountPct = getRule("discount_3months");

  const discountedSessionPrice = Math.round(
    basePrice * (1 - discountPct / 100),
  );
  const cycleBaseAmount = sessionsPerCycle * discountedSessionPrice;

  let addonsCostPerCycle = 0;
  const activeAddons = Object.entries(addonConfig).filter(
    ([, v]) => v.mode !== "none",
  );
  for (const [key, config] of activeAddons) {
    const addon = addons.find((a) => a.key === key);
    if (!addon) continue;
    if (config.mode === "credits") {
      addonsCostPerCycle += Math.round(
        addon.price * config.perCycle * (1 - discountPct / 100),
      );
    } else {
      addonsCostPerCycle += Math.round(
        addon.price * sessionsPerCycle * (1 - discountPct / 100),
      );
    }
  }

  const cycleAmount = cycleBaseAmount + addonsCostPerCycle;
  const totalContractAmount = cycleAmount * durationMonths;

  // ── FULL (pay-upfront) display totals — mirror the backend ──
  const pixExtraDiscountPct = getRule("pix_extra_discount_pct");
  const pixFullTotal = Math.round(
    totalContractAmount * (1 - pixExtraDiscountPct / 100),
  );
  // Amount charged on the 1st (and only) invoice for the FULL plan, by method.
  const fullChargeAmount =
    paymentMethod === "PIX" ? pixFullTotal : totalContractAmount;

  const episodes3 = getRule("episodes_3months");
  const episodes6 = getRule("episodes_6months");
  const nextThreshold =
    totalSessions < episodes3
      ? episodes3
      : totalSessions < episodes6
        ? episodes6
        : null;
  const sessionsToNextDiscount = nextThreshold
    ? nextThreshold - totalSessions
    : 0;

  // ─── Schedule builder ────────────────────────────────
  const schedule = selectedDays.map((day) => ({
    day,
    time: dayTimes[day] || POSSIBLE_SLOTS[selectedTier]?.[0] || "10:00",
  }));

  const toggleDay = (day: number) => {
    if (selectedDays.includes(day)) {
      setSelectedDays((prev) => prev.filter((d) => d !== day));
      setDayTimes((prev) => {
        const n = { ...prev };
        delete n[day];
        return n;
      });
    } else {
      setSelectedDays((prev) => [...prev, day].sort());
      setDayTimes((prev) => ({
        ...prev,
        [day]: POSSIBLE_SLOTS[selectedTier]?.[0] || "10:00",
      }));
    }
  };

  const setDayTime = (day: number, time: string) => {
    setDayTimes((prev) => ({ ...prev, [day]: time }));
  };

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const startDateStr = tomorrow.toISOString().split("T")[0];

  // ─── Handlers ────────────────────────────────────────
  const executeCreation = async (resolutions: any[] = [], cpfChecked = false) => {
    // PIX is emitted as a Cora invoice in the user's name → requires a CPF/CNPJ.
    if (!cpfChecked && paymentMethod === "PIX" && !isValidCpfCnpj(user?.cpfCnpj)) {
      // Belt-and-braces: o contexto pode estar com um user parcial (ex.: sessão
      // antiga) — confere no servidor antes de pedir o CPF de novo.
      try {
        const { user: fresh } = await authApi.me();
        updateUser(fresh);
        if (isValidCpfCnpj(fresh?.cpfCnpj)) {
          return executeCreation(resolutions, true);
        }
      } catch { /* offline/expirado — cai no prompt normalmente */ }
      pendingResolutions.current = resolutions;
      setShowCpfPrompt(true);
      return;
    }
    setSubmitting(true);
    setError("");
    setStep(5);

    try {
      const activeAddonKeys = Object.entries(addonConfig)
        .filter(([, v]) => v.mode !== "none")
        .map(([k]) => k);
      const addonConfigPayload: Record<
        string,
        { mode: "all" | "credits"; perCycle?: number }
      > = {};
      for (const [key, config] of activeAddons) {
        addonConfigPayload[key] = {
          mode: config.mode as "all" | "credits",
          ...(config.mode === "credits" ? { perCycle: config.perCycle } : {}),
        };
      }

      const res = await contractsApi.createCustom({
        name: contractName,
        tier: selectedTier as "COMERCIAL" | "AUDIENCIA" | "SABADO",
        durationMonths,
        schedule,
        paymentMethod: paymentMethod!,
        paymentPlan,
        addOns: activeAddonKeys,
        addonConfig:
          activeAddonKeys.length > 0 ? addonConfigPayload : undefined,
        resolvedConflicts: resolutions.length > 0 ? resolutions : undefined,
        startDate: startDateStr,
      });

      if (paymentMethod === "CARTAO" && (res.clientSecret || res.firstPaymentId)) {
        if (res.clientSecret) setCardClientSecret(res.clientSecret);
        if (res.firstPaymentId) setFirstPaymentId(res.firstPaymentId);
        setStep(8);
      } else if (paymentMethod === "PIX") {
        if (res.firstPaymentId) setFirstPaymentId(res.firstPaymentId);
        if (res.firstPixString) setFirstPixString(res.firstPixString);
        setStep(8);
      } else {
        setStep(6);
      }
    } catch (err: unknown) {
      setError(getErrorMessage(err) || "Erro ao criar contrato personalizado");
      setStep(3);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCheckAndSubmit = async () => {
    if (!tierConfig || selectedDays.length === 0) return;
    setSubmitting(true);
    setError("");

    try {
      const res = await contractsApi.checkCustom({
        tier: selectedTier,
        durationMonths,
        schedule,
        startDate: startDateStr,
      });

      if (!res.available && res.conflicts.length > 0) {
        setConflicts(res.conflicts);
        const autoResolutions = res.conflicts
          .filter((c) => c.suggestedReplacement)
          .map((c) => ({
            originalDate: c.date,
            originalTime: c.originalTime,
            newDate: c.suggestedReplacement!.date,
            newTime: c.suggestedReplacement!.time,
          }));
        setResolvedConflicts(autoResolutions);
        setStep(7);
        setSubmitting(false);
        return;
      }

      await executeCreation([]);
    } catch (err: unknown) {
      setError(getErrorMessage(err) || "Erro ao validar agenda");
      setStep(4);
      setSubmitting(false);
    }
  };

  const availableSlots = POSSIBLE_SLOTS[selectedTier] || [];
  const allDays = [1, 2, 3, 4, 5, 6];
  const isSaturdayLocked = selectedTier !== "SABADO";

  const progressSteps = step >= 5 && step !== 7 ? 4 : step;

  return (
    <BottomSheetModal isOpen={true} onClose={onClose} title="🎨 Plano Personalizado" preventClose={submitting} maxWidth="600px">
      <div className="wizard-modal-inner">
        {showCpfPrompt && (
          <div className="wizard-cancel-overlay" onClick={() => setShowCpfPrompt(false)}>
            <div className="wizard-cancel-modal" onClick={e => e.stopPropagation()}>
              <CpfCnpjPrompt
                saveLabel="Salvar e continuar"
                onSaved={() => { setShowCpfPrompt(false); executeCreation(pendingResolutions.current, true); }}
                onCancel={() => setShowCpfPrompt(false)}
              />
            </div>
          </div>
        )}
        {/* Progress */}
        <div className="wizard-progress">
          {[1, 2, 3, 4].map((s) => (
            <div
              key={s}
              className={`wizard-progress__step ${progressSteps >= s ? "wizard-progress__step--active" : ""}`}
            />
          ))}
        </div>

        {/* ══════════ STEP 5: LOADING ══════════ */}
        {step === 5 && (
          <div className="wizard-state-screen">
            <div
              className="spinner"
              style={{ margin: "0 auto 20px", width: 40, height: 40 }}
            />
            <h3 className="wizard-state-screen__title">Processando...</h3>
            <p className="wizard-state-screen__desc">
              Gerando {totalSessions} agendamentos. Aguarde um instante.
            </p>
          </div>
        )}

        {/* ══════════ STEP 6: SUCCESS ══════════ */}
        {step === 6 && (
          <div className="wizard-success">
            <div className="wizard-success__confetti">
              <div className="wizard-success__icon-wrap">
                <CheckCircle2 size={48} />
              </div>
            </div>
            <h3 className="wizard-success__title">Parabéns! Plano Ativado</h3>
            <p className="wizard-success__desc">
              Seu plano personalizado de <strong>{sessionsPerWeek}x/semana</strong> com <strong>{totalSessions} sessões</strong> em <strong>{durationMonths} {durationMonths === 1 ? 'ciclo' : 'ciclos'}</strong> foi confirmado.
            </p>
            <div className="wizard-success__details">
              <div className="wizard-success__detail-row">
                <CalendarDays size={14} />
                <span>{totalSessions} sessões agendadas automaticamente</span>
              </div>
              <div className="wizard-success__detail-row">
                <Clock size={14} />
                <span>Desconto de {discountPct}% aplicado</span>
              </div>
            </div>
            <p className="wizard-success__next">
              Acompanhe seus agendamentos e pagamentos na sua área do cliente.
            </p>
            <button className="wizard-cta-pay" style={{ width: '100%' }} onClick={() => { onComplete(); onClose(); }}>
              <CalendarDays size={18} /> Ver Minha Agenda
            </button>
          </div>
        )}

        {/* ══════════ STEP 8 (PIX): INLINE PIX CHECKOUT ══════════ */}
        {step === 8 && !cardClientSecret && paymentMethod === "PIX" && firstPaymentId && (
          <div className="wizard-payment-step">
            <div className="wizard-payment-step__header">
              <div className="wizard-payment-step__icon-v2">
                <ShieldCheck size={28} />
              </div>
              <h3 className="wizard-payment-step__title">
                {paymentPlan === "FULL" ? "Pagamento Integral" : "Pagamento do 1º Ciclo"}
              </h3>
              <p className="wizard-payment-step__desc">
                Escaneie o QR Code PIX para confirmar seu plano personalizado.
              </p>
            </div>

            <div className="wizard-receipt" style={{ marginBottom: 16, padding: '12px 16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                  {paymentPlan === "FULL" ? "Contrato integral à vista" : `1º de ${durationMonths} ciclos`}
                </span>
                <span style={{ fontWeight: 800, fontSize: '1.125rem', color: 'var(--accent-primary)' }}>
                  {formatBRL(paymentPlan === "FULL" ? fullChargeAmount : cycleAmount)}
                </span>
              </div>
            </div>

            <InlineCheckout
              amount={paymentPlan === "FULL" ? fullChargeAmount : cycleAmount}
              paymentId={firstPaymentId}
              description={paymentPlan === "FULL" ? `Pagamento integral - ${contractName}` : `1º ciclo - ${contractName}`}
              contractDuration={paymentPlan === "FULL" ? 1 : durationMonths}
              allowedMethods={["PIX"]}
              context="contract"
              createPaymentFn={async () => ({ paymentId: firstPaymentId, pixString: firstPixString || undefined })}
              onSuccess={() => setStep(6)}
              onError={(msg) => { setError(msg); setStep(3); }}
              onCancel={() => { onComplete(); onClose(); }}
            />
          </div>
        )}

        {/* ══════════ STEP 8: INLINE CARD PAYMENT ══════════ */}
        {step === 8 && paymentMethod === "CARTAO" && firstPaymentId && (
          <div className="wizard-payment-step">
            <div className="wizard-payment-step__header">
              <div className="wizard-payment-step__icon-v2">
                <ShieldCheck size={28} />
              </div>
              <h3 className="wizard-payment-step__title">
                {paymentPlan === "FULL" ? "Pagamento Integral" : "Pagamento do 1º Ciclo"}
              </h3>
              <p className="wizard-payment-step__desc">
                {paymentPlan === "FULL"
                  ? "Complete o pagamento integral para ativar seu plano personalizado."
                  : "Complete o pagamento para ativar seu plano personalizado."}
              </p>
            </div>

            <div className="wizard-info-banner wizard-info-banner--warning">
              <AlertTriangle size={14} />
              <span>O contrato só será criado após a confirmação do pagamento. Sem pagamento, nenhum agendamento será reservado.</span>
            </div>

            <div className="wizard-receipt" style={{ marginBottom: 16, padding: '12px 16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                  {paymentPlan === "FULL" ? "Contrato integral à vista" : `1º de ${durationMonths} ciclos`}
                </span>
                <span style={{ fontWeight: 800, fontSize: '1.125rem', color: 'var(--accent-primary)' }}>
                  {formatBRL(paymentPlan === "FULL" ? fullChargeAmount : cycleAmount)}
                </span>
              </div>
            </div>

            <InlineCheckout
              amount={paymentPlan === "FULL" ? fullChargeAmount : cycleAmount}
              paymentId={firstPaymentId}
              description={paymentPlan === "FULL" ? `Pagamento integral - ${contractName}` : `1º ciclo - ${contractName}`}
              contractDuration={paymentPlan === "FULL" ? durationMonths : 1}
              allowedMethods={["CARTAO"]}
              context="contract"
              createPaymentFn={async () => ({ paymentId: firstPaymentId })}
              onSuccess={() => setStep(6)}
              onError={(msg) => { setError(msg); setStep(3); }}
              onCancel={() => setShowCancelModal(true)}
            />

            <button className="wizard-cancel-link" onClick={() => setShowCancelModal(true)}>
              Cancelar
            </button>

            {showCancelModal && (
              <div className="wizard-cancel-overlay" onClick={() => setShowCancelModal(false)}>
                <div className="wizard-cancel-modal" onClick={e => e.stopPropagation()}>
                  <div className="wizard-cancel-modal__icon">
                    <AlertTriangle size={32} />
                  </div>
                  <h4 className="wizard-cancel-modal__title">Tem certeza que deseja sair?</h4>
                  <p className="wizard-cancel-modal__desc">
                    Seu plano <strong>não será criado</strong> sem o pagamento do 1º ciclo. Nenhum horário será reservado na agenda.
                  </p>
                  <p className="wizard-cancel-modal__sub">
                    Você pode voltar a qualquer momento e iniciar uma nova contratação.
                  </p>
                  <button className="wizard-cta-pay" style={{ width: '100%', marginBottom: 10 }} onClick={() => setShowCancelModal(false)}>
                    <ShieldCheck size={16} /> Continuar Pagamento
                  </button>
                  <button className="wizard-cancel-modal__exit" onClick={() => { setShowCancelModal(false); onClose(); }}>
                    Sair sem pagar
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ══════════ STEP 1: TIER + SCHEDULE ══════════ */}
        {step === 1 && (
          <div>
            <h3 className="wizard-step__title">1. Construa sua Grade</h3>

            <div className="form-group" style={{ marginBottom: 20 }}>
              <label className="form-label">
                Nome do Projeto (Obrigatório)
              </label>
              <input
                className="form-input"
                type="text"
                value={contractName}
                onChange={(e) => setContractName(e.target.value)}
                placeholder="Ex: Podcast de Tecnologia, Mesa Cast VIP"
              />
            </div>

            {/* Tier Tabs — same pattern as ContractWizard */}
            <div className="modal-tabs">
              {pricing.map((p) => {
                const info = TIER_INFO[p.tier];
                return (
                  <button
                    key={p.tier}
                    className={`modal-tab ${selectedTier === p.tier ? "modal-tab--active" : ""}`}
                    onClick={() => {
                      setSelectedTier(p.tier);
                      if (p.tier !== "SABADO") {
                        setSelectedDays((prev) => prev.filter((d) => d !== 6));
                        setDayTimes((prev) => {
                          const n = { ...prev };
                          delete n[6];
                          return n;
                        });
                      } else {
                        setSelectedDays([]);
                        setDayTimes({});
                      }
                    }}
                  >
                    {info?.emoji} {p.label}
                  </button>
                );
              })}
            </div>

            {/* Tier description */}
            {tierConfig && TIER_INFO[selectedTier] && (
              <div className="wizard-tier-desc">
                <span className="wizard-tier-desc__hours">
                  🕐 {TIER_INFO[selectedTier].hours}
                </span>
                <span>·</span>
                <span>{TIER_INFO[selectedTier].desc}</span>
              </div>
            )}

            {/* Duration Selection */}
            <div className="form-group" style={{ marginBottom: 20 }}>
              <label className="form-label">
                Quantidade de Ciclos (1 ciclo = 4 semanas)
              </label>
              <div className="wizard-price-grid">
                {[1, 3, 6, 9, 12].map((m) => (
                  <div
                    key={m}
                    className={`wizard-price-card ${durationMonths === m ? "wizard-price-card--selected" : ""}`}
                    onClick={() => setDurationMonths(m)}
                    style={{
                      minHeight: "unset",
                      padding: "14px 12px",
                      textAlign: "center",
                    }}
                  >
                    <div
                      className="wizard-price-card__price"
                      style={{ fontSize: "1.25rem" }}
                    >
                      {m}
                    </div>
                    <div className="wizard-price-card__per">
                      {m === 1 ? "ciclo" : "ciclos"}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Day Selection */}
            <div className="form-group" style={{ marginBottom: 20 }}>
              <label className="form-label">
                Quais dias da semana você vai gravar?
              </label>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(6, 1fr)",
                  gap: 8,
                }}
              >
                {allDays.map((day) => {
                  const isSelected = selectedDays.includes(day);
                  const isLocked = day === 6 && isSaturdayLocked;
                  return (
                    <div
                      key={day}
                      className={`wizard-price-card ${isSelected ? "wizard-price-card--selected" : ""}`}
                      onClick={() => !isLocked && toggleDay(day)}
                      style={{
                        minHeight: "unset",
                        padding: "14px 4px",
                        textAlign: "center",
                        opacity: isLocked ? 0.4 : 1,
                        cursor: isLocked ? "not-allowed" : "pointer",
                      }}
                    >
                      <div style={{ fontWeight: 700, fontSize: "0.9375rem" }}>
                        {DAY_NAMES[day]}
                      </div>
                      {isLocked && (
                        <Lock
                          size={12}
                          style={{ margin: "4px auto 0", opacity: 0.6 }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Time pickers — inside wizard-summary box like ContractWizard step 4 */}
            {selectedDays.length > 0 && (
              <div className="wizard-summary" style={{ marginBottom: 20 }}>
                <div className="wizard-summary__label">
                  📅 Selecione o horário de cada dia
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                  }}
                >
                  {selectedDays.map((day) => (
                    <div
                      key={day}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                      }}
                    >
                      <span
                        style={{
                          minWidth: 70,
                          fontWeight: 600,
                          fontSize: "0.875rem",
                        }}
                      >
                        {DAY_NAMES_FULL[day]}:
                      </span>
                      <select
                        className="form-input"
                        style={{ flex: 1, maxWidth: 220 }}
                        value={dayTimes[day] || availableSlots[0]}
                        onChange={(e) => setDayTime(day, e.target.value)}
                      >
                        {availableSlots.map((slot) => {
                          const [h] = slot.split(":").map(Number);
                          return (
                            <option key={slot} value={slot}>
                              {slot} às {h + 2}:{slot.split(":")[1]} (2h)
                            </option>
                          );
                        })}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Discount Progress Bar */}
            {selectedDays.length > 0 && (
              <div
                className={`info-box ${discountPct >= 40 ? "info-box--success" : discountPct >= 30 ? "info-box--warning" : "info-box--neutral"}`}
                style={{ marginBottom: 20 }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 8,
                  }}
                >
                  <span style={{ fontWeight: 600, fontSize: "0.875rem" }}>
                    {discountPct >= 40
                      ? "🏆 Desconto Ouro Alcançado"
                      : discountPct >= 30
                        ? "🥈 Desconto Prata Alcançado"
                        : "📊 Progresso de Desconto"}
                  </span>
                  <span
                    style={{
                      fontWeight: 800,
                      fontSize: "1.125rem",
                      color:
                        discountPct >= 40
                          ? "#16a34a"
                          : discountPct >= 30
                            ? "#ca8a04"
                            : "var(--text-muted)",
                    }}
                  >
                    {discountPct > 0 ? `-${discountPct}%` : "0%"}
                  </span>
                </div>
                <div
                  style={{
                    height: 6,
                    borderRadius: 3,
                    background: "var(--bg-elevated)",
                    overflow: "hidden",
                    marginBottom: 8,
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      borderRadius: 3,
                      transition: "width 0.5s ease, background 0.3s",
                      width: `${Math.min(100, (totalSessions / 24) * 100)}%`,
                      background:
                        discountPct >= 40
                          ? "#16a34a"
                          : discountPct >= 30
                            ? "#eab308"
                            : "var(--accent-primary)",
                    }}
                  />
                </div>
                <div
                  style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}
                >
                  Volume: {totalSessions} sessões no plano
                  {nextThreshold &&
                    ` · Faltam apenas ${sessionsToNextDiscount} para ${nextThreshold >= 24 ? "40%" : "30%"} de desconto.`}
                </div>
              </div>
            )}

            {/* Summary mini-cart inline — mirrors ContractWizard Step 4 summary */}
            {selectedDays.length > 0 && (
              <div className="wizard-summary">
                <div className="wizard-summary__label">Resumo do Plano</div>

                <div className="wizard-summary__row">
                  <div>
                    <div className="wizard-summary__item-name">
                      {tierConfig?.label} · {sessionsPerWeek}x/semana
                    </div>
                    <div className="wizard-summary__item-desc">
                      {totalSessions} sessões em {durationMonths}{" "}
                      {durationMonths === 1 ? "ciclo" : "ciclos"} ·{" "}
                      {selectedDays
                        .map((d) => `${DAY_NAMES[d]} ${dayTimes[d] || ""}`)
                        .join(" · ")}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <span className="wizard-summary__item-price">
                      {formatBRL(cycleAmount)}/ciclo
                    </span>
                    {discountPct > 0 && (
                      <div className="wizard-summary__discount-note">
                        -{discountPct}% aplicado
                      </div>
                    )}
                  </div>
                </div>

                <div className="wizard-summary__total">
                  <span className="wizard-summary__total-label">
                    Total do Contrato ({durationMonths}x)
                  </span>
                  <span className="wizard-summary__total-value">
                    {formatBRL(totalContractAmount)}
                  </span>
                </div>

                {basePrice > 0 && discountPct > 0 && (
                  <div className="wizard-summary__full-total">
                    <span className="wizard-summary__full-total-label">
                      Média por sessão
                    </span>
                    <span className="wizard-summary__full-total-value">
                      <span
                        style={{
                          textDecoration: "line-through",
                          marginRight: 8,
                        }}
                      >
                        {formatBRL(basePrice)}
                      </span>
                      <span
                        style={{
                          fontWeight: 700,
                          color: discountPct >= 40 ? "#16a34a" : "#ca8a04",
                        }}
                      >
                        {formatBRL(discountedSessionPrice)}
                      </span>
                    </span>
                  </div>
                )}
              </div>
            )}

            <div className="wizard-actions">
              <div />
              <button
                className="btn btn-primary"
                style={{ flex: 1 }}
                onClick={() => setStep(2)}
                disabled={!contractName.trim() || selectedDays.length === 0}
              >
                Continuar ➔
              </button>
            </div>
          </div>
        )}

        {/* ══════════ STEP 2: ADDONS ══════════ */}
        {step === 2 && (
          <div>
            <h3 className="wizard-step__title">
              2. Serviços Adicionais (Opcionais)
            </h3>
            <p className="wizard-step__subtitle">
              Potencialize a entrega do seu projeto. Seu plano te garante{" "}
              <strong>{discountPct}% de desconto</strong> nos extras
              selecionados abaixo. Contratação 100% opcional.
            </p>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 16,
                marginBottom: 28,
              }}
            >
              {addons
                .filter((a) => !a.monthly)
                .map((addon) => {
                  const config = addonConfig[addon.key] || {
                    mode: "none",
                    perCycle: 4,
                  };
                  const isActive = config.mode !== "none";
                  const priceAll = Math.round(
                    addon.price * sessionsPerCycle * (1 - discountPct / 100),
                  );
                  const pricePerCredit = Math.round(
                    addon.price * (1 - discountPct / 100),
                  );

                  return (
                    <div
                      key={addon.key}
                      className={`wizard-addon ${isActive ? "wizard-addon--selected" : ""}`}
                      style={{
                        flexDirection: "column",
                        alignItems: "stretch",
                        cursor: "default",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "flex-start",
                          marginBottom: 16,
                        }}
                      >
                        <div>
                          <div
                            className={`wizard-addon__name ${isActive ? "wizard-addon__name--selected" : ""}`}
                          >
                            {addon.name}
                          </div>
                          <div className="wizard-addon__desc">
                            {addon.description ||
                              "Potencialize a qualidade do seu projeto."}
                          </div>
                        </div>
                        {discountPct > 0 && (
                          <span className="wizard-addon__discount">
                            -{discountPct}% off
                          </span>
                        )}
                      </div>

                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 8,
                          background: "var(--bg-card)",
                          padding: 12,
                          borderRadius: "var(--radius-sm)",
                          border: "1px solid var(--border-subtle)",
                        }}
                      >
                        <label
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            cursor: "pointer",
                            padding: "6px 0",
                          }}
                        >
                          <input
                            type="radio"
                            checked={config.mode === "none"}
                            onChange={() => {}}
                            onClick={() =>
                              setAddonConfig((prev) => ({
                                ...prev,
                                [addon.key]: { mode: "none", perCycle: 4 },
                              }))
                            }
                            style={{
                              accentColor: "var(--accent-primary)",
                              width: 16,
                              height: 16,
                            }}
                          />
                          <span
                            style={{
                              fontSize: "0.875rem",
                              fontWeight: 500,
                              color: "var(--text-secondary)",
                            }}
                          >
                            Não adicionar no plano
                          </span>
                        </label>

                        <label
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            cursor: "pointer",
                            padding: "6px 0",
                            borderTop: "1px solid var(--border-subtle)",
                          }}
                        >
                          <input
                            type="radio"
                            checked={config.mode === "all"}
                            onChange={() => {}}
                            onClick={() =>
                              setAddonConfig((prev) => ({
                                ...prev,
                                [addon.key]: { mode: "all", perCycle: 4 },
                              }))
                            }
                            style={{
                              accentColor: "var(--accent-primary)",
                              width: 16,
                              height: 16,
                            }}
                          />
                          <span
                            style={{ fontSize: "0.875rem", fontWeight: 500 }}
                          >
                            Aplicar em <strong>todas</strong> as gravações (x
                            {sessionsPerCycle})
                          </span>
                          <span style={{ marginLeft: "auto", textAlign: "right" }}>
                            <span style={{ display: "block", fontWeight: 600, fontSize: "0.875rem", color: "var(--accent-primary)" }}>
                              +{formatBRL(priceAll)}
                            </span>
                            <span style={{ fontSize: "0.6875rem", color: "var(--text-muted)" }}>
                              {formatBRL(pricePerCredit)}/gravação
                            </span>
                          </span>
                        </label>

                        <label
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            cursor: "pointer",
                            padding: "6px 0",
                            borderTop: "1px solid var(--border-subtle)",
                          }}
                        >
                          <input
                            type="radio"
                            checked={config.mode === "credits"}
                            onChange={() => {}}
                            onClick={() =>
                              setAddonConfig((prev) => ({
                                ...prev,
                                [addon.key]: {
                                  mode: "credits",
                                  perCycle: prev[addon.key]?.perCycle || 4,
                                },
                              }))
                            }
                            style={{
                              accentColor: "var(--accent-primary)",
                              width: 16,
                              height: 16,
                            }}
                          />
                          <span
                            style={{ fontSize: "0.875rem", fontWeight: 500 }}
                          >
                            Sessões avulsas (Banco de Créditos)
                          </span>
                        </label>

                        {config.mode === "credits" && (
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 16,
                              marginTop: 4,
                              padding: "12px 16px",
                              background: "var(--bg-elevated)",
                              borderRadius: "var(--radius-sm)",
                            }}
                          >
                            <span
                              style={{
                                fontSize: "0.8125rem",
                                color: "var(--text-muted)",
                              }}
                            >
                              Créditos por ciclo:
                            </span>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                background: "var(--bg-card)",
                                border: "1px solid var(--border-subtle)",
                                borderRadius: "var(--radius-sm)",
                              }}
                            >
                              <button
                                className="btn btn-ghost btn-sm"
                                style={{
                                  padding: "4px 12px",
                                  borderRight: "1px solid var(--border-subtle)",
                                  borderRadius: 0,
                                }}
                                onClick={() =>
                                  setAddonConfig((prev) => ({
                                    ...prev,
                                    [addon.key]: {
                                      ...prev[addon.key],
                                      perCycle: Math.max(
                                        1,
                                        (prev[addon.key]?.perCycle || 4) - 1,
                                      ),
                                    },
                                  }))
                                }
                              >
                                −
                              </button>
                              <span
                                style={{
                                  fontWeight: 600,
                                  fontSize: "0.9375rem",
                                  minWidth: 32,
                                  textAlign: "center",
                                }}
                              >
                                {config.perCycle}
                              </span>
                              <button
                                className="btn btn-ghost btn-sm"
                                style={{
                                  padding: "4px 12px",
                                  borderLeft: "1px solid var(--border-subtle)",
                                  borderRadius: 0,
                                }}
                                onClick={() =>
                                  setAddonConfig((prev) => ({
                                    ...prev,
                                    [addon.key]: {
                                      ...prev[addon.key],
                                      perCycle: Math.min(
                                        sessionsPerCycle,
                                        (prev[addon.key]?.perCycle || 4) + 1,
                                      ),
                                    },
                                  }))
                                }
                              >
                                +
                              </button>
                            </div>
                            <span style={{ marginLeft: "auto", textAlign: "right" }}>
                              <span style={{ display: "block", fontWeight: 600, fontSize: "0.875rem", color: "var(--accent-primary)" }}>
                                +{formatBRL(pricePerCredit * config.perCycle)}
                              </span>
                              <span style={{ fontSize: "0.6875rem", color: "var(--text-muted)" }}>
                                {formatBRL(pricePerCredit)}/gravação
                              </span>
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>

            <div className="wizard-actions">
              <button className="btn btn-secondary" onClick={() => setStep(1)}>
                ⬅ Voltar
              </button>
              <button className="btn btn-primary" onClick={() => setStep(3)}>
                {activeAddons.length > 0
                  ? "Continuar ➔"
                  : "Pular Serviços Extras ➔"}
              </button>
            </div>
          </div>
        )}

        {/* ══════════ STEP 3: PAYMENT + TERMS ══════════ */}
        {step === 3 && (
          <div>
            <h3 className="wizard-step__title">3. Resumo e Checkout</h3>

            {error && (
              <div
                className="info-box info-box--error"
                style={{ marginBottom: 20 }}
              >
                ❌ {error}
              </div>
            )}

            {/* Order Summary — matches ContractWizard Step 4 */}
            <div className="wizard-summary">
              <div className="wizard-summary__label">Carrinho de Compras</div>

              <div className="wizard-summary__row">
                <div>
                  <div className="wizard-summary__item-name">
                    Plano {tierConfig?.label} Personalizado ({durationMonths}{" "}
                    ciclos)
                  </div>
                  <div className="wizard-summary__item-desc">
                    {totalSessions} sessões · {sessionsPerWeek}x/semana ·{" "}
                    {selectedDays
                      .map((d) => `${DAY_NAMES[d]} ${dayTimes[d] || ""}`)
                      .join(", ")}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <span className="wizard-summary__item-price">
                    {formatBRL(cycleBaseAmount)}/ciclo
                  </span>
                  {discountPct > 0 && (
                    <div className="wizard-summary__discount-note">
                      -{discountPct}% aplicado
                    </div>
                  )}
                </div>
              </div>

              {activeAddons.length > 0 && (
                <div className="wizard-summary__addons">
                  <div className="wizard-summary__addons-label">
                    Serviços Adicionais Escolhidos:
                  </div>
                  {activeAddons.map(([key, config]) => {
                    const addon = addons.find((a) => a.key === key);
                    if (!addon) return null;
                    return (
                      <div key={key} className="wizard-summary__addon-row">
                        <span className="wizard-summary__addon-name">
                          • {addon.name} (
                          {config.mode === "all"
                            ? "em todas"
                            : `${config.perCycle}x/ciclo`}
                          )
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="wizard-summary__total">
                <span className="wizard-summary__total-label">
                  Subtotal (por Ciclo)
                </span>
                <span className="wizard-summary__total-value">
                  {formatBRL(cycleAmount)}
                </span>
              </div>
              <div className="wizard-summary__full-total">
                <span className="wizard-summary__full-total-label">
                  Valor do Contrato Completo ({durationMonths}x)
                </span>
                <span className="wizard-summary__full-total-value">
                  {formatBRL(totalContractAmount)}
                </span>
              </div>
            </div>

            {/* Payment Plan — Mensal / À vista PIX / À vista Cartão */}
            <div className="wizard-summary">
              <div className="wizard-summary__label">Plano de Pagamento</div>

              {/* Mensal */}
              <div
                className="wizard-payment-card"
                onClick={() => setPaymentPlan("MONTHLY")}
                style={{
                  background:
                    paymentPlan === "MONTHLY"
                      ? "var(--bg-elevated)"
                      : "var(--bg-card)",
                  border: `2px solid ${paymentPlan === "MONTHLY" ? "var(--accent-primary)" : "var(--border-subtle)"}`,
                }}
              >
                <div className="wizard-payment-card__row">
                  <div>
                    <div className="wizard-payment-card__name">📆 Mensal (por ciclo)</div>
                    <div className="wizard-payment-card__desc">
                      {durationMonths} {durationMonths === 1 ? "ciclo" : "ciclos"} de {formatBRL(cycleAmount)}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div className="wizard-payment-card__price">
                      {durationMonths}x {formatBRL(cycleAmount)}
                    </div>
                    <div className="wizard-payment-card__sub-price">
                      Total: {formatBRL(totalContractAmount)}
                    </div>
                  </div>
                </div>
              </div>

              {/* À vista no PIX */}
              <div
                className="wizard-payment-card"
                onClick={() => { setPaymentPlan("FULL"); setPaymentMethod("PIX"); }}
                style={{
                  background:
                    paymentPlan === "FULL" && paymentMethod === "PIX"
                      ? "var(--bg-elevated)"
                      : "var(--bg-card)",
                  border: `2px solid ${paymentPlan === "FULL" && paymentMethod === "PIX" ? "#22c55e" : "var(--border-subtle)"}`,
                }}
              >
                <div className="wizard-payment-card__row">
                  <div>
                    <div className="wizard-payment-card__name">
                      ⚡ À vista no PIX
                      {pixExtraDiscountPct > 0 && (
                        <span
                          className="wizard-payment-card__badge"
                          style={{ background: "#22c55e", color: "#fff" }}
                        >
                          -{pixExtraDiscountPct}%
                        </span>
                      )}
                    </div>
                    <div className="wizard-payment-card__desc">
                      Pague o contrato inteiro agora com desconto
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div className="wizard-payment-card__price" style={{ color: "#22c55e" }}>
                      {formatBRL(pixFullTotal)}
                    </div>
                    {pixExtraDiscountPct > 0 && (
                      <div
                        className="wizard-payment-card__sub-price"
                        style={{ textDecoration: "line-through" }}
                      >
                        {formatBRL(totalContractAmount)}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* À vista no Cartão */}
              <div
                className="wizard-payment-card"
                onClick={() => { setPaymentPlan("FULL"); setPaymentMethod("CARTAO"); }}
                style={{
                  background:
                    paymentPlan === "FULL" && paymentMethod === "CARTAO"
                      ? "var(--bg-elevated)"
                      : "var(--bg-card)",
                  border: `2px solid ${paymentPlan === "FULL" && paymentMethod === "CARTAO" ? "var(--accent-primary)" : "var(--border-subtle)"}`,
                }}
              >
                <div className="wizard-payment-card__row">
                  <div>
                    <div className="wizard-payment-card__name">💳 À vista no Cartão</div>
                    <div className="wizard-payment-card__desc">
                      Valor integral à vista (ou parcelado no cartão)
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div className="wizard-payment-card__price">
                      {formatBRL(totalContractAmount)}
                    </div>
                    <div className="wizard-payment-card__sub-price">ou parcelado</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Payment Options (MONTHLY only) — same as ContractWizard */}
            {paymentPlan === "MONTHLY" && (
            <div className="wizard-summary">
              <div className="wizard-summary__label">
                Opções de Pagamento (Formato Final)
              </div>
              {getClientPaymentMethods().map((pm) => {
                const isSelected = paymentMethod === pm.key;
                let displayPrice = "";
                let subPrice = "";
                let badge: React.ReactNode = null;
                let desc = "";

                if (pm.key === "PIX") {
                  displayPrice = formatBRL(
                    Math.round(
                      totalContractAmount * (1 - pixExtraDiscountPct / 100),
                    ),
                  );
                  subPrice = formatBRL(totalContractAmount);
                  badge =
                    pixExtraDiscountPct > 0 ? (
                      <span
                        className="wizard-payment-card__badge"
                        style={{ background: "#22c55e", color: "#fff" }}
                      >
                        -{pixExtraDiscountPct}%
                      </span>
                    ) : null;
                  desc = "Desconto aplicado no valor do contrato completo";
                } else if (pm.key === "CARTAO") {
                  // O backend do custom cobra o valor PLANO (sem surcharge) no
                  // cartão — então o display mostra o valor REAL cobrado.
                  displayPrice = `${durationMonths}x ${formatBRL(cycleAmount)}`;
                  subPrice = `Total: ${formatBRL(totalContractAmount)}`;
                  desc = "Parcelado no cartão, sem acréscimo";
                } else {
                  displayPrice = `${durationMonths}x ${formatBRL(cycleAmount)}`;
                  subPrice = `Total: ${formatBRL(totalContractAmount)}`;
                  desc =
                    "Sem juros mensais. 1º vencimento no envio do contrato";
                }

                return (
                  <div
                    key={pm.key}
                    className="wizard-payment-card"
                    onClick={() => setPaymentMethod(pm.key as "CARTAO" | "PIX")}
                    style={{
                      background: isSelected ? pm.bgActive : pm.bgInactive,
                      border: `2px solid ${isSelected ? pm.borderActive : pm.borderInactive}`,
                    }}
                  >
                    <div className="wizard-payment-card__row">
                      <div>
                        <div className="wizard-payment-card__name">
                          {pm.emoji}{" "}
                          {pm.accessMode === "FULL" && pm.key === "PIX"
                            ? `${pm.label} à vista`
                            : pm.accessMode === "FULL"
                              ? `${pm.shortLabel} em ${durationMonths}x`
                              : `${pm.label} Mensal`}{" "}
                          {badge}
                        </div>
                        <div className="wizard-payment-card__desc">{desc}</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div
                          className="wizard-payment-card__price"
                          style={{ color: pm.color }}
                        >
                          {displayPrice}
                        </div>
                        <div
                          className="wizard-payment-card__sub-price"
                          style={{
                            textDecoration:
                              pm.key === "PIX" ? "line-through" : "none",
                          }}
                        >
                          {subPrice}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            )}

            {/* Progressive access warning */}
            {paymentPlan === "MONTHLY" && paymentMethod &&
              getClientPaymentMethods().find((pm) => pm.key === paymentMethod)
                ?.accessMode === "PROGRESSIVE" && (
                <div
                  className="info-box info-box--warning"
                  style={{ marginBottom: 16 }}
                >
                  ⚠️ <strong>Importante:</strong> No formato mensal, as sessões
                  do próximo ciclo só aparecem na agenda após a compensação do
                  respectivo pagamento. Seus horários fixos estão protegidos
                  pela sua fidelidade.
                </div>
              )}

            {/* Terms */}
            <div className="wizard-terms">
              <div className="wizard-terms__title">📋 Termos e Regras</div>
              <ul className="wizard-terms__list">
                <li>
                  Os pagamentos ocorrem em ciclos pré-pagos a cada{" "}
                  <strong>4 semanas</strong> (total de {durationMonths} ciclos).
                </li>
                <li>
                  Cancelamento com menos de <strong>24 horas</strong> de
                  antecedência resulta na perda do crédito.
                </li>
                <li>
                  Remarcação permitida com até <strong>7 dias</strong> de
                  antecedência.
                </li>
                <li>
                  Créditos não utilizados dentro da vigência do contrato expiram
                  ao final do período.
                </li>
                <li>
                  A grade escolhida bloqueará preventivamente outros
                  agendamentos sobrepostos durante a vigência.
                </li>
              </ul>
              <label className="wizard-terms__accept">
                <input
                  type="checkbox"
                  checked={acceptedTerms}
                  onChange={(e) => setAcceptedTerms(e.target.checked)}
                  className="wizard-terms__checkbox"
                />
                Li e aceito as regras acima
              </label>
            </div>

            <div className="wizard-actions">
              <button className="btn btn-secondary" onClick={() => setStep(2)}>
                ⬅ Voltar
              </button>
              <button
                className="btn btn-primary"
                onClick={handleCheckAndSubmit}
                disabled={!acceptedTerms || submitting || !paymentMethod}
              >
                {submitting ? "⏳ Processando..." : "🔒 Ir para Pagamento"}
              </button>
            </div>
          </div>
        )}

        {/* ══════════ STEP 7: CONFLICTS ══════════ */}
        {step === 7 && (
          <div>
            <div className="wizard-state-screen" style={{ padding: "24px 0" }}>
              <div className="wizard-state-screen__icon">⚠️</div>
              <h3
                className="wizard-state-screen__title"
                style={{ color: "#ef4444" }}
              >
                Conflitos de Agenda Encontrados
              </h3>
              <p className="wizard-state-screen__desc">
                Alguns dos horários planejados já encontram-se ocupados por
                outros agendamentos.
              </p>
            </div>

            <div
              style={{
                background: "var(--bg-secondary)",
                padding: 16,
                borderRadius: "var(--radius-md)",
                marginBottom: 24,
              }}
            >
              <div
                style={{
                  fontWeight: 700,
                  marginBottom: 12,
                  fontSize: "0.875rem",
                }}
              >
                Datas em conflito:
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                  maxHeight: 320,
                  overflowY: "auto",
                }}
              >
                {conflicts.map((c, i) => {
                  const [y, m, d] = c.date.split("-");
                  return (
                    <div key={i} className="wizard-conflict">
                      <div className="wizard-conflict__header">
                        <span className="wizard-conflict__date">
                          {DAY_NAMES_FULL[c.day]}, {d}/{m}/{y} às{" "}
                          {c.originalTime}
                        </span>
                        <span className="wizard-conflict__badge">Ocupado</span>
                      </div>

                      {c.suggestedReplacement ? (
                        <div className="wizard-conflict__suggestion">
                          <span>💡 Nossa sugestão:</span>
                          <span className="wizard-conflict__alt">
                            {c.suggestedReplacement.time} no mesmo dia
                          </span>
                        </div>
                      ) : (
                        <div className="wizard-conflict__warning">
                          <span>
                            ⚠️ Este dia está completamente lotado. A sessão
                            passará para o fim do seu contrato.
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="wizard-actions wizard-actions--stack">
              <button
                className="btn btn-primary"
                style={{ width: "100%", padding: 14 }}
                onClick={() => executeCreation(resolvedConflicts)}
              >
                ✅ Aceitar Sugestões e Concluir
              </button>
              <button
                className="btn btn-secondary"
                style={{ width: "100%", padding: 14 }}
                onClick={() => setStep(1)}
              >
                ⬅ Voltar e escolher outro Plano/Horário
              </button>
            </div>
          </div>
        )}
      </div>
    </BottomSheetModal>
  );
}
