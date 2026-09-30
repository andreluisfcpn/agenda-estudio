// Fixture do autoteste do verificador de tooltips (NÃO é código do app: fica fora de src/, não entra
// no build nem no tsc). Uso, na pasta frontend/:
//
//     node scripts/check-icon-buttons.cjs scripts/__fixtures__
//
// Resultado esperado: código de saída 1 e EXATAMENTE os 7 gatilhos marcados com "ACUSAR" na lista
// ("Gatilhos só-ícone: 9 · com Tooltip: 2 · exceções: 0 · SEM Tooltip: 7").
// Se a contagem mudar, o verificador regrediu (ou ganhou uma regra nova — atualize esta fixture).
import React from 'react';

export function Fixture({ icon, cfg, label }: any) {
    return (
        <div>
            {/* ACUSAR 1 — role="button" só-ícone fora de Tooltip */}
            <span role="button" tabIndex={0} aria-label="Excluir"><Trash2 /></span>

            {/* ACUSAR 2 — motion.button só-ícone */}
            <motion.button aria-label="Excluir"><Trash2 /></motion.button>

            {/* ACUSAR 3 e 4 — expressão com nome de ícone */}
            <button aria-label="Excluir">{icon}</button>
            <button aria-label="Excluir">{cfg.icon}</button>

            {/* ACUSAR 5 — emoji (3 unidades UTF-16 com o seletor de variação) */}
            <button>🗑️</button>

            {/* ACUSAR 6 — Tooltip sem conteúdo não conta como Tooltip */}
            <Tooltip content={null}><button aria-label="Excluir"><Trash2 /></button></Tooltip>

            {/* ACUSAR 7 — o caso clássico: title= nativo em botão só-ícone */}
            <button title="Excluir"><Trash2 /></button>

            {/* NÃO acusar — dentro de Tooltip com conteúdo (contam em "com Tooltip") */}
            <Tooltip content="Excluir" describe={false}>
                <button type="button" aria-label="Excluir cliente"><Trash2 /></button>
            </Tooltip>
            <Tooltip content="Marcar como lida" describe={false}>
                <span role="button" tabIndex={0} aria-label="Marcar como lida"><Check /></span>
            </Tooltip>

            {/* NÃO acusar — limites conhecidos / botões com texto (nem entram na contagem) */}
            <div onClick={() => {}}><Trash2 /></div>
            <button title="Excluir cliente">Excluir</button>
            <button><Trash2 /> Excluir</button>
            <button>{label}</button>
            <motion.a href="/x">Abrir</motion.a>
        </div>
    );
}
