// ─── BR Code (PIX copia-e-cola / EMV MPM) ───────────────
// Funções PURAS para validar e montar o "BR Code" do PIX (padrão EMV® QRCPS-MPM adotado pelo
// Bacen). Formato TLV: ID(2 dígitos) + TAMANHO(2 dígitos) + VALOR, terminando na tag 63 com o
// CRC16-CCITT (poly 0x1021, init 0xFFFF) calculado sobre todo o payload até "6304" inclusive.
//
// Uso:
//  • isValidBrCode  → valida o EMV devolvido pelo provedor antes de exibir (o sandbox do Sicoob
//                     devolve texto aleatório — "lorem ipsum" — que nenhum banco lê).
//  • buildStaticBrCode → BR Code SINTÉTICO, só para sandbox/dev (a trava de ambiente fica em quem
//                     chama: sicoobService/paymentGateway). Em produção NUNCA é usado.

/** CRC16-CCITT-FALSE (poly 0x1021, init 0xFFFF, sem reflexão, xorout 0) → 4 hex MAIÚSCULOS. */
export function crc16(payload: string): string {
    let crc = 0xffff;
    const bytes = Buffer.from(payload, 'utf-8');
    for (const byte of bytes) {
        crc ^= byte << 8;
        for (let i = 0; i < 8; i++) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
            crc &= 0xffff;
        }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Um campo TLV já decodificado. */
export interface BrCodeField {
    id: string;
    value: string;
}

/**
 * Decodifica uma sequência TLV (nível de cima ou um template). Retorna `null` se a estrutura
 * estiver quebrada (tamanho não numérico, estouro do fim, id inválido).
 */
export function parseTlv(input: string): BrCodeField[] | null {
    const out: BrCodeField[] = [];
    let i = 0;
    while (i < input.length) {
        const id = input.slice(i, i + 2);
        const lenStr = input.slice(i + 2, i + 4);
        if (!/^\d{2}$/.test(id) || !/^\d{2}$/.test(lenStr)) return null;
        const len = Number(lenStr);
        const value = input.slice(i + 4, i + 4 + len);
        if (value.length !== len) return null;
        out.push({ id, value });
        i += 4 + len;
    }
    return out;
}

function tlv(id: string, value: string): string {
    if (value.length > 99) throw new Error(`Campo ${id} do BR Code excede 99 caracteres.`);
    return `${id}${String(value.length).padStart(2, '0')}${value}`;
}

const PIX_GUI = 'br.gov.bcb.pix';

/**
 * O texto é um BR Code PIX estruturalmente válido?
 *  - começa com "000201" (Payload Format Indicator = 01);
 *  - TLV íntegro até o fim, com a tag 63 (tamanho 04) como ÚLTIMO campo;
 *  - CRC16 da tag 63 confere com o payload;
 *  - tem um Merchant Account Information (tags 26–51) com GUI "br.gov.bcb.pix";
 *  - tem moeda (53), país (58), nome (59) e cidade (60).
 * Não valida a chave nem o valor (isso é responsabilidade do provedor/conciliação).
 */
export function isValidBrCode(emv: unknown): boolean {
    if (typeof emv !== 'string') return false;
    const s = emv.trim();
    if (!s.startsWith('000201') || s.length < 30) return false;
    const fields = parseTlv(s);
    if (!fields || fields.length === 0) return false;

    const last = fields[fields.length - 1]!;
    if (last.id !== '63' || last.value.length !== 4) return false;
    // A tag 63 só pode aparecer no fim.
    if (fields.slice(0, -1).some(f => f.id === '63')) return false;
    const payloadForCrc = s.slice(0, s.length - 4); // inclui "6304"
    if (crc16(payloadForCrc) !== last.value.toUpperCase()) return false;

    const byId = new Map(fields.map(f => [f.id, f.value]));
    if (byId.get('00') !== '01') return false;
    for (const req of ['53', '58', '59', '60']) {
        if (!byId.get(req)) return false;
    }
    const hasPixAccount = fields.some(f => {
        const n = Number(f.id);
        if (n < 26 || n > 51) return false;
        const sub = parseTlv(f.value);
        return !!sub && sub.some(x => x.id === '00' && x.value.toLowerCase() === PIX_GUI);
    });
    return hasPixAccount;
}

/** Valor (tag 54) do BR Code em centavos, ou `null` se ausente/ilegível (ex.: QR dinâmico sem valor). */
export function brCodeAmountCents(emv: string): number | null {
    const fields = parseTlv(emv.trim());
    const v = fields?.find(f => f.id === '54')?.value;
    if (!v || !/^\d+(\.\d{1,2})?$/.test(v)) return null;
    return Math.round(Number(v) * 100);
}

/** Remove acentos e caracteres fora do ASCII imprimível (os campos 59/60 do BR Code são ASCII). */
function asciiField(text: string, max: number, fallback: string): string {
    const clean = (text || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^\x20-\x7E]/g, '')
        .trim()
        .slice(0, max)
        .trim();
    return clean || fallback;
}

export interface StaticBrCodeInput {
    /** Chave PIX do recebedor (tag 26.01). */
    key: string;
    /** Valor em centavos (> 0). */
    amountCents: number;
    /** Identificador da transação. No QR estático o limite é 25 alfanuméricos — o excedente é cortado. */
    txid?: string;
    /** Nome do recebedor (máx. 25, ASCII). */
    merchantName?: string;
    /** Cidade do recebedor (máx. 15, ASCII). */
    city?: string;
}

/**
 * Monta um BR Code PIX ESTÁTICO válido (CRC correto) com a chave, o valor e o txid informados.
 * EXCLUSIVO para sandbox/dev — o banco lê o QR e mostra valor e recebedor, mas a cobrança não
 * existe no provedor (a confirmação em sandbox é pelo "Simular pagamento"). A trava de ambiente
 * fica em quem chama; esta função é pura.
 */
export function buildStaticBrCode(input: StaticBrCodeInput): string {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
        throw new Error('Valor do BR Code inválido (centavos > 0).');
    }
    const key = (input.key || '').trim();
    if (!key) throw new Error('Chave PIX ausente para montar o BR Code.');
    const txid = (input.txid || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 25) || '***';

    const merchantAccount = tlv('00', PIX_GUI) + tlv('01', key.slice(0, 77));
    const payload =
        tlv('00', '01') +
        tlv('26', merchantAccount) +
        tlv('52', '0000') +
        tlv('53', '986') +
        tlv('54', (input.amountCents / 100).toFixed(2)) +
        tlv('58', 'BR') +
        tlv('59', asciiField(input.merchantName || '', 25, 'ESTUDIO')) +
        tlv('60', asciiField(input.city || '', 15, 'BUZIOS')) +
        tlv('62', tlv('05', txid)) +
        '6304';
    return payload + crc16(payload);
}
