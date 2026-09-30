#!/usr/bin/env node
/**
 * check:tooltips — anti-regressão da regra E7 (docs/tecnico/design-system.md §6):
 * todo botão/link de ação cujo conteúdo visível é SÓ ícone (ou só um símbolo como × − +)
 * precisa de `aria-label` + `<Tooltip>` (components/ui/Tooltip).
 *
 * Varre todos os .tsx de src/ com o compilador do TypeScript (AST, sem executar nada) e lista os
 * gatilhos só-ícone que NÃO estão dentro de um <Tooltip> COM conteúdo. Gatilho = <button>, <a>, <Link>,
 * <NavLink>, <motion.button>, <motion.a> ou qualquer elemento com role="button".
 * Sai com código 1 se sobrar algum fora da lista de exceções abaixo.
 *
 * Conta como "só-ícone": componente/svg/img sem texto, símbolo ou emoji curto (× − + ⋯ 🗑️) e expressão
 * cujo nome termina em "icon" ({icon}, {cfg.icon}, {StatusIcon}).
 * Um <Tooltip> sem `content` (ou com content literal null/undefined/false/'') NÃO conta como Tooltip.
 *
 * Uso:  npm run check:tooltips        (na pasta frontend/)
 *       node scripts/check-icon-buttons.cjs [pasta]     (padrão: src/)
 *
 * Autoteste do próprio verificador (tem de sair com código 1 e listar os 7 casos da fixture):
 *       node scripts/check-icon-buttons.cjs scripts/__fixtures__
 *
 * Limites conhecidos (a varredura é estática):
 *  - `<div>`/`<span>` com onClick e SEM role="button" não são gatilho (toggles, cartões e overlays
 *    cairiam como falso positivo);
 *  - `title=` nativo em botão/link COM texto não é verificado (só aparece como dica no gatilho só-ícone);
 *  - conteúdo dinâmico do Tooltip (content={variavel}) é aceito sem avaliar se fica vazio em runtime;
 *  - um componente sem filhos dentro do botão conta como ícone (por isso a exceção do ChoiceText);
 *  - uma chamada ({renderIcon()}) é tratada como texto dinâmico;
 *  - o <Tooltip> precisa estar até 4 elementos JSX acima do gatilho (ex.: Tooltip > span > button).
 */
const ts = require('typescript');
const fs = require('fs');
const path = require('path');

// Raiz da varredura: src/ por padrão; aceita outra pasta por argumento (fixture do autoteste).
const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'src'));
// Prefixo mostrado nos caminhos do relatório ("src" na execução normal).
const ROOT_LABEL = path.relative(path.join(__dirname, '..'), ROOT).replace(/\\/g, '/') || '.';

/**
 * Exceções explícitas — gatilhos que o scanner classifica como "só-ícone" mas onde o Tooltip NÃO se
 * aplica. Cada entrada casa pelo arquivo + um traço estável do gatilho (classe ou filhos), nunca pelo
 * número da linha. Para acrescentar uma exceção, explique o porquê em `why`.
 */
const EXCEPTIONS = [
    {
        file: 'components/ui/fields/ToggleField.tsx',
        test: r => /sf-toggle-switch/.test(r.className),
        why: 'É um switch (role="switch"), não um botão de ação: o rótulo visível fica ao lado, no <label>.',
    },
    {
        file: 'pages/LandingPage.tsx',
        test: r => /landing-navbar-hamburger/.test(r.className),
        why: 'Hambúrguer da landing: só existe no mobile (toque) e o Tooltip nunca abre no toque.',
    },
    {
        file: 'components/admin/coupons/CouponModal.tsx',
        test: r => /<ChoiceText\b/.test(r.children),
        why: 'Cartões de escolha (tipo de desconto, escopo, elegibilidade): o ChoiceText renderiza rótulo e '
            + 'descrição VISÍVEIS — o scanner só não vê o texto porque ele está dentro do componente.',
    },
    {
        file: 'components/BottomTabBar.tsx',
        test: () => true,
        why: 'Barra inferior do mobile: navegação por toque (Tooltip não abre) e cada aba já tem rótulo visível.',
    },
];

const TRIGGERS = new Set(['button', 'a', 'Link', 'NavLink', 'motion.button', 'motion.a']);

// role="button" | role='button' | role={'button'}
const isRoleButton = v => /^\{?\s*['"]button['"]\s*\}?$/.test(v || '');

function isTrigger(node, sf) {
    return TRIGGERS.has(tagName(node)) || isRoleButton(attrs(node.openingElement, sf).role);
}

function tagName(node) {
    const t = node.tagName || (node.openingElement && node.openingElement.tagName);
    return t ? t.getText() : '';
}

function attrs(opening, sf) {
    const out = {};
    for (const p of opening.attributes.properties) {
        if (ts.isJsxAttribute(p)) {
            const n = p.name.getText(sf);
            const v = p.initializer ? p.initializer.getText(sf) : 'true';
            out[n] = v.length > 120 ? v.slice(0, 117) + '...' : v;
        }
    }
    return out;
}

// Classifica os filhos: 'icon' se só há ícones/expressões de ícone; 'text' se há texto visível.
function isIconLikeText(s) {
    const t = s.replace(/\s+/g, '');
    if (!t) return null; // só espaço em branco
    // símbolos curtos sem letras/dígitos (×, ✕, ←, ⋯, ‹ ›, − +) e emoji — contado por code point,
    // porque um emoji com seletor de variação (🗑️) ocupa 3 unidades UTF-16.
    if ([...t].length <= 4 && !/[\p{L}\p{N}]/u.test(t)) return 'icon';
    return 'text';
}

function classifyNode(n, sf) {
    if (ts.isJsxText(n)) return isIconLikeText(n.getText(sf));
    if (ts.isJsxSelfClosingElement(n) || ts.isJsxElement(n)) {
        const tn = tagName(n);
        if (/^[A-Z]/.test(tn) || tn.startsWith('Icons.') || tn === 'svg' || tn === 'img') {
            if (ts.isJsxElement(n) && tn !== 'svg') {
                // componente com filhos (ex.: <Badge>texto</Badge>) → verifica os filhos
                const r = classifyChildren(n.children, sf);
                return r === 'text' ? 'text' : 'icon';
            }
            return 'icon';
        }
        // span/div etc.: olha dentro
        if (ts.isJsxElement(n)) {
            const a = attrs(n.openingElement, sf);
            // texto só para leitor de tela → visualmente continua sendo só ícone
            if (a.className && /sr-only|visually-hidden/.test(a.className)) return 'srtext';
            return classifyChildren(n.children, sf);
        }
        return 'icon';
    }
    if (ts.isJsxExpression(n)) {
        if (!n.expression) return null;
        return classifyExpr(n.expression, sf);
    }
    return 'text';
}

function classifyExpr(e, sf) {
    if (ts.isParenthesizedExpression(e)) return classifyExpr(e.expression, sf);
    if (ts.isJsxSelfClosingElement(e) || ts.isJsxElement(e)) return classifyNode(e, sf);
    if (ts.isJsxFragment(e)) return classifyChildren(e.children, sf);
    if (ts.isConditionalExpression(e)) {
        const a = classifyExpr(e.whenTrue, sf), b = classifyExpr(e.whenFalse, sf);
        if (a === 'text' || b === 'text') return 'text';
        return a || b;
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return classifyExpr(e.right, sf);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return isIconLikeText(e.text);
    if (e.kind === ts.SyntaxKind.NullKeyword) return null;
    // IIFE que devolve ícone (ex.: {(() => { const I = ...; return <I/> })()})
    const txt = e.getText(sf);
    if (/^\(\(\) => \{[\s\S]*return <[A-Z]\w*[^>]*\/>;?\s*\}\)\(\)$/.test(txt)) return 'icon';
    // {icon}, {cfg.icon}, {StatusIcon}: identificador/propriedade com nome de ícone.
    if ((ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) && /icon$/i.test(txt)) return 'icon';
    return 'text'; // outro identificador/chamada: assume texto dinâmico
}

function classifyChildren(children, sf) {
    let sawIcon = false;
    for (const c of children) {
        const r = classifyNode(c, sf);
        if (r === 'text') return 'text';
        if (r === 'icon' || r === 'srtext') sawIcon = true;
    }
    return sawIcon ? 'icon' : null;
}

// <Tooltip> sem `content`, ou com content literal null/undefined/false/'' → o componente devolve o
// filho intacto (sem dica): não conta.
function hasTooltipContent(opening, sf) {
    const c = attrs(opening, sf).content;
    if (!c || c === 'true') return false; // ausente, ou `content` solto (booleano)
    return !/^(\{\s*(null|undefined|false|''|""|``)\s*\}|''|"")$/.test(c);
}

function insideTooltip(node, sf) {
    let p = node.parent;
    let depth = 0;
    while (p && depth < 4) {
        if (ts.isJsxElement(p) && tagName(p) === 'Tooltip' && hasTooltipContent(p.openingElement, sf)) return true;
        if (ts.isJsxElement(p) || ts.isJsxFragment(p)) depth++;
        p = p.parent;
    }
    return false;
}

const files = [];
(function walk(d) {
    for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.tsx')) files.push(p);
    }
})(ROOT);

const results = [];
for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    (function visit(node) {
        if (ts.isJsxElement(node) && isTrigger(node, sf) && classifyChildren(node.children, sf) === 'icon') {
            const a = attrs(node.openingElement, sf);
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            results.push({
                file: path.relative(ROOT, file).replace(/\\/g, '/'),
                line: line + 1,
                tag: tagName(node),
                tooltip: insideTooltip(node, sf),
                ariaLabel: a['aria-label'] || '',
                title: a['title'] || '',
                className: a['className'] || '',
                children: node.children.map(c => c.getText(sf)).join('').replace(/\s+/g, ' ').trim().slice(0, 80),
            });
        }
        ts.forEachChild(node, visit);
    })(sf);
}

const isException = r => EXCEPTIONS.some(x => x.file === r.file && x.test(r));
const withTip = results.filter(r => r.tooltip);
const excepted = results.filter(r => !r.tooltip && isException(r));
const offenders = results.filter(r => !r.tooltip && !isException(r));

console.log(
    `Gatilhos só-ícone: ${results.length} · com Tooltip: ${withTip.length} · `
    + `exceções: ${excepted.length} · SEM Tooltip: ${offenders.length}`,
);

if (offenders.length > 0) {
    console.log('\nBotões/links só com ícone fora de <Tooltip> (regra E7 — aria-label + <Tooltip>):');
    for (const r of offenders) {
        const hints = [
            r.ariaLabel ? `aria-label=${r.ariaLabel}` : 'SEM aria-label',
            r.title ? `title=${r.title} (trocar por Tooltip)` : '',
            r.className ? `class=${r.className}` : '',
        ].filter(Boolean).join(' · ');
        console.log(`  ${ROOT_LABEL}/${r.file}:${r.line} <${r.tag}> ${hints} :: ${r.children}`);
    }
    console.log('\nComo corrigir: <Tooltip content="Editar cupom" describe={false}><button type="button" aria-label="Editar cupom X">…</button></Tooltip>');
    console.log('Botão que pode ficar disabled: ponha o Tooltip num <span style={{ display: \'inline-flex\' }}> em volta.');
    process.exit(1);
}

console.log('OK — nenhum botão só-ícone fora de <Tooltip>.');
