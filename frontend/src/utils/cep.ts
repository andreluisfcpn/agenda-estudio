/** Máscara de CEP brasileiro: 00000-000. */
export function maskCep(v: string): string {
    const d = v.replace(/\D/g, '').slice(0, 8);
    return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}

export interface CepResult {
    street: string;       // logradouro
    neighborhood: string; // bairro
    city: string;         // localidade
    state: string;        // uf
}

/**
 * Consulta o ViaCEP (API pública gratuita, sem auth). Retorna null se o CEP
 * for inválido, não existir, ou a rede falhar — o chamador trata como "manual".
 */
export async function lookupCep(cep: string): Promise<CepResult | null> {
    const digits = cep.replace(/\D/g, '');
    if (digits.length !== 8) return null;
    // Timeout de 8s — sem isso, uma conexão pendurada (nem resolve nem rejeita)
    // deixaria o spinner girando para sempre.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const res = await fetch(`https://viacep.com.br/ws/${digits}/json/`, { signal: controller.signal });
        if (!res.ok) return null;
        const data = await res.json();
        if (data.erro) return null;
        return {
            street: data.logradouro || '',
            neighborhood: data.bairro || '',
            city: data.localidade || '',
            state: data.uf || '',
        };
    } catch {
        return null; // erro de rede / timeout / abort → trata como preenchimento manual
    } finally {
        clearTimeout(timer);
    }
}
