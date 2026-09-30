import React from 'react';
import {
    Sparkles, Share2, TrendingUp, Scissors, Film, Youtube, Search, FileText,
    Mic, Video, Camera, Megaphone, Palette, BarChart3, Calendar, Headphones,
    Pencil, Image, Rocket, Star, User,
} from 'lucide-react';

// Curated set of lucide icons offered for services (admin picker + rendering). Admin may
// also type an emoji; anything not in this map is rendered as a text glyph (emoji fallback).
const ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
    Sparkles, Share2, TrendingUp, Scissors, Film, Youtube, Search, FileText,
    Mic, Video, Camera, Megaphone, Palette, BarChart3, Calendar, Headphones,
    Pencil, Image, Rocket, Star, User,
};

/** Icon names offered in the admin service icon picker. */
export const SERVICE_ICON_OPTIONS = Object.keys(ICONS);

/**
 * Nome legível (pt-BR) de cada ícone, para o seletor do admin — o valor gravado continua sendo o
 * nome técnico do lucide (`AddOnConfig.icon`), que o admin nunca precisa ler (E8).
 */
const ICON_LABELS: Record<string, string> = {
    Sparkles: 'Brilhos (padrão)',
    Share2: 'Compartilhar (redes sociais)',
    TrendingUp: 'Crescimento (tráfego)',
    Scissors: 'Tesoura (cortes)',
    Film: 'Filme (edição)',
    Youtube: 'YouTube',
    Search: 'Lupa (busca / SEO)',
    FileText: 'Documento (roteiro)',
    Mic: 'Microfone',
    Video: 'Câmera de vídeo',
    Camera: 'Câmera fotográfica',
    Megaphone: 'Megafone (divulgação)',
    Palette: 'Paleta (design)',
    BarChart3: 'Gráfico (relatórios)',
    Calendar: 'Calendário',
    Headphones: 'Fones de ouvido (áudio)',
    Pencil: 'Lápis (texto)',
    Image: 'Imagem (capa / arte)',
    Rocket: 'Foguete (lançamento)',
    Star: 'Estrela (destaque)',
    User: 'Pessoa (atendimento)',
};

/** Rótulo legível de um ícone do seletor (desconhecido → o próprio valor). */
export function serviceIconLabel(icon: string): string {
    return ICON_LABELS[icon] ?? icon;
}

// Palavras comuns em chaves de serviço que perdem o acento ao virar chave (MAIÚSCULAS sem acento).
const KEY_WORD_ACCENTS: Record<string, string> = {
    TRAFEGO: 'TRÁFEGO', ANUNCIO: 'ANÚNCIO', ANUNCIOS: 'ANÚNCIOS', VIDEO: 'VÍDEO', VIDEOS: 'VÍDEOS',
    AUDIO: 'ÁUDIO', MIDIA: 'MÍDIA', MIDIAS: 'MÍDIAS', RELATORIO: 'RELATÓRIO', RELATORIOS: 'RELATÓRIOS',
    METRICA: 'MÉTRICA', METRICAS: 'MÉTRICAS', CONTEUDO: 'CONTEÚDO', CONTEUDOS: 'CONTEÚDOS',
    EPISODIO: 'EPISÓDIO', EPISODIOS: 'EPISÓDIOS', ESTUDIO: 'ESTÚDIO', ANALISE: 'ANÁLISE',
    ESTRATEGIA: 'ESTRATÉGIA', BASICO: 'BÁSICO', AVANCADO: 'AVANÇADO', DIARIA: 'DIÁRIA',
    PUBLICO: 'PÚBLICO', AUDIENCIA: 'AUDIÊNCIA', SABADO: 'SÁBADO', PAGINA: 'PÁGINA', MUSICA: 'MÚSICA',
    SERVICO: 'SERVIÇO', SERVICOS: 'SERVIÇOS', FOTOGRAFICO: 'FOTOGRÁFICO', BUZIOS: 'BÚZIOS',
    MES: 'MÊS', PREMIO: 'PRÊMIO', TECNICO: 'TÉCNICO', TECNICA: 'TÉCNICA', RAPIDO: 'RÁPIDO',
};

/**
 * Rótulo legível de uma chave técnica de serviço, para quando o serviço não tem nome (E8):
 * `GESTAO_SOCIAL` → "GESTÃO SOCIAL", `EDICAO_VIDEO` → "EDIÇÃO VÍDEO". Nunca exibir a chave crua.
 */
export function humanizeServiceKey(key: string | null | undefined): string {
    return (key ?? '')
        .split(/[_\s]+/)
        .filter(Boolean)
        .map(raw => {
            const w = raw.toUpperCase();
            if (KEY_WORD_ACCENTS[w]) return KEY_WORD_ACCENTS[w];
            if (w.length > 3 && w.endsWith('COES')) return `${w.slice(0, -4)}ÇÕES`;
            if (w.length > 3 && w.endsWith('CAO')) return `${w.slice(0, -3)}ÇÃO`;
            if (w.length > 3 && w.endsWith('OES')) return `${w.slice(0, -3)}ÕES`;
            if (w.length > 2 && w.endsWith('AO')) return `${w.slice(0, -2)}ÃO`;
            return w;
        })
        .join(' ');
}

/**
 * Sugere a chave técnica (código interno) a partir do nome do serviço: sem acento, MAIÚSCULAS,
 * separada por `_` e única entre `taken` (sufixo _2, _3…). Nome sem letra/número → ''.
 */
export function suggestServiceKey(name: string, taken: readonly string[] = []): string {
    const base = name
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40)
        .replace(/_+$/g, '');
    if (!base) return '';
    if (!taken.includes(base)) return base;
    for (let n = 2; n < 1000; n++) {
        const candidate = `${base}_${n}`;
        if (!taken.includes(candidate)) return candidate;
    }
    return base;
}

/**
 * Render a service icon from an `AddOnConfig.icon` value: a known lucide name → the icon,
 * otherwise the raw string as a glyph (emoji), falling back to Sparkles when empty.
 */
export function renderServiceIcon(icon: string | null | undefined, size = 24): React.ReactNode {
    if (!icon) return <Sparkles size={size} />;
    const Comp = ICONS[icon];
    if (Comp) return <Comp size={size} />;
    return <span style={{ fontSize: size, lineHeight: 1 }} aria-hidden>{icon}</span>;
}
