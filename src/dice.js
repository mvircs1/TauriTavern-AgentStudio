// Métodos de rolagem configuráveis.
//
// Um método diz:
// - countMode: quantos dados rolar: 'fixed' (sempre fixedCount) ou 'attribute' (o valor do atributo);
// - sides: tipo do dado (20 = d20);
// - keep: 'highest' (fica o maior), 'lowest' (fica o menor) ou 'sum' (soma todos);
// - attributeBonus: como o atributo entra no total do teste: 'modifier' (D&D: (valor-10)/2),
//   'value' (o próprio valor) ou 'none' (só define a quantidade de dados);
// - zeroRule: com 0 dados ou menos, 'lowest2' rola 2 (mais 1 por ponto negativo) e fica o menor;
//   'none' rola 1.

export const DICE_PRESETS = Object.freeze({
    dnd: {
        label: 'D&D: 1d20 + modificador do atributo',
        description: 'Um d20 por teste. O atributo vira modificador: (valor − 10) ÷ 2. Atributos padrão 10.',
        dice: { countMode: 'fixed', fixedCount: 1, sides: 20, keep: 'highest', attributeBonus: 'modifier', zeroRule: 'lowest2' },
        defaultScore: 10,
        training: [2, 4, 6],
    },
    ordem: {
        label: 'Ordem: atributo = nº de d20, fica o maior',
        description: 'Rola tantos d20 quanto o valor do atributo e fica com o maior. Com atributo 0, rola 2d20 e fica com o menor. O bônus vem do treinamento da perícia. Atributos padrão 1.',
        dice: { countMode: 'attribute', fixedCount: 1, sides: 20, keep: 'highest', attributeBonus: 'none', zeroRule: 'lowest2' },
        defaultScore: 1,
        training: [5, 10, 15],
    },
    direto: {
        label: 'Direto: 1d20 + valor do atributo',
        description: 'Um d20 por teste, somado ao valor do atributo (sem tabela de modificador). Atributos padrão 2.',
        dice: { countMode: 'fixed', fixedCount: 1, sides: 20, keep: 'highest', attributeBonus: 'value', zeroRule: 'lowest2' },
        defaultScore: 2,
        training: [2, 4, 6],
    },
});

export const DEFAULT_DICE = Object.freeze({ preset: 'dnd', ...DICE_PRESETS.dnd.dice });

const COUNT_MODES = ['fixed', 'attribute'];
const KEEP_MODES = ['highest', 'lowest', 'sum'];
const ATTRIBUTE_BONUS = ['modifier', 'value', 'none'];
const ZERO_RULES = ['lowest2', 'none'];
const MAX_DICE = 30;

export function modifierOf(score) {
    return Math.floor((Number(score) - 10) / 2);
}

function pick(value, options, fallback) {
    return options.includes(value) ? value : fallback;
}

function intIn(value, min, max, fallback) {
    const number = Math.trunc(Number(value));
    return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

/** Valida um método salvo (ou parcial), completando com o padrão. */
export function normalizeDice(stored) {
    const base = DEFAULT_DICE;
    const value = stored && typeof stored === 'object' ? stored : {};
    return {
        preset: typeof value.preset === 'string' && (DICE_PRESETS[value.preset] || value.preset === 'custom') ? value.preset : base.preset,
        countMode: pick(value.countMode, COUNT_MODES, base.countMode),
        fixedCount: intIn(value.fixedCount, 1, MAX_DICE, base.fixedCount),
        sides: intIn(value.sides, 2, 1000, base.sides),
        keep: pick(value.keep, KEEP_MODES, base.keep),
        attributeBonus: pick(value.attributeBonus, ATTRIBUTE_BONUS, base.attributeBonus),
        zeroRule: pick(value.zeroRule, ZERO_RULES, base.zeroRule),
    };
}

/** Quanto o atributo soma no total de um teste. */
export function attributeRollBonus(dice, score) {
    if (dice.attributeBonus === 'modifier') return modifierOf(score);
    if (dice.attributeBonus === 'value') return Number(score) || 0;
    return 0;
}

/** Quanto o atributo soma numa estatística (Defesa etc.): modificador no D&D, valor nos demais. */
export function attributeStatBonus(dice, score) {
    return dice.attributeBonus === 'modifier' ? modifierOf(score) : Number(score) || 0;
}

/** Quantos dados um teste com esse atributo rola (antes de vantagem/desvantagem). */
export function diceCount(dice, score) {
    if (dice.countMode === 'attribute' && score !== undefined && score !== null) return Math.trunc(Number(score)) || 0;
    return dice.fixedCount;
}

/** Como a quantidade de dados vira texto: "1d20", "3d20 (maior)", "2d20 (menor)", "3d6". */
export function describePool(dice, count) {
    let n = count;
    let keep = dice.keep;
    if (n < 1) {
        if (dice.zeroRule === 'lowest2' && keep !== 'sum') {
            n = 2 - n;
            keep = 'lowest';
        } else {
            n = 1;
        }
    }
    n = Math.min(n, MAX_DICE);
    const base = `${n}d${dice.sides}`;
    if (n === 1 || keep === 'sum') return base;
    return `${base} (${keep === 'highest' ? 'maior' : 'menor'})`;
}

/** "2d20+13", "1d20-1", "3d6"; com 0 dados no Ordem, "2d20 (menor) +5". */
export function formatRoll(dice, count, flat) {
    const described = describePool(dice, count);
    const lowest = described.endsWith('(menor)') && dice.keep !== 'lowest';
    const pool = lowest ? described : described.replace(/ \((maior|menor)\)/, '');
    if (!flat) return pool;
    return `${pool}${lowest ? ' ' : ''}${flat >= 0 ? '+' : ''}${flat}`;
}

/**
 * Rola um conjunto de dados.
 * @param {ReturnType<typeof normalizeDice>} dice
 * @param {number} count dados antes de vantagem/desvantagem
 * @param {{ mode?: 'normal'|'advantage'|'disadvantage', extraDice?: number, rollDie: (sides: number) => number }} options
 * @returns {{ rolls: number[], result: number, keep: string, count: number, label: string }}
 */
export function rollPool(dice, count, { mode = 'normal', extraDice = 0, rollDie }) {
    let n = Math.trunc(count) + Math.trunc(extraDice || 0);
    let keep = dice.keep;

    if (keep === 'sum') {
        // Na soma, vantagem rola um dado a mais e descarta o menor; desvantagem descarta o maior.
        n = Math.max(1, Math.min(n, MAX_DICE));
        const extra = mode === 'normal' ? 0 : 1;
        const rolls = Array.from({ length: n + extra }, () => rollDie(dice.sides));
        const sorted = [...rolls].sort((a, b) => a - b);
        const used = mode === 'advantage' ? sorted.slice(1) : mode === 'disadvantage' ? sorted.slice(0, -1) : rolls;
        const result = used.reduce((total, value) => total + value, 0);
        return { rolls, result, keep: 'sum', count: n, label: `${n}d${dice.sides}` };
    }

    if (mode === 'advantage') n += 1;
    if (mode === 'disadvantage') n -= 1;
    if (n < 1) {
        if (dice.zeroRule === 'lowest2') {
            n = 2 - n;
            keep = keep === 'highest' ? 'lowest' : 'highest';
        } else {
            n = 1;
        }
    }
    n = Math.min(n, MAX_DICE);
    const rolls = Array.from({ length: n }, () => rollDie(dice.sides));
    const result = keep === 'highest' ? Math.max(...rolls) : Math.min(...rolls);
    const label = n === 1 ? `1d${dice.sides}` : `${n}d${dice.sides} (${keep === 'highest' ? 'maior' : 'menor'})`;
    return { rolls, result, keep, count: n, label };
}

/** Explicação do método para a IA (system_info) e para a tela. */
export function describeMethod(dice) {
    const count = dice.countMode === 'attribute'
        ? 'roll as many d' + dice.sides + ' as the attribute value'
        : `roll ${dice.fixedCount}d${dice.sides}`;
    const keep = { highest: 'keep the highest die', lowest: 'keep the lowest die', sum: 'add all dice' }[dice.keep];
    const bonus = {
        modifier: 'add the attribute modifier = floor((score - 10) / 2): 8-9 = -1, 10-11 = +0, 12-13 = +1, 14-15 = +2, 16-17 = +3, 18-19 = +4, 20 = +5',
        value: 'add the attribute value',
        none: 'the attribute only sets the number of dice (it adds nothing to the total)',
    }[dice.attributeBonus];
    const zero = dice.zeroRule === 'lowest2' && dice.keep !== 'sum'
        ? ' With 0 dice or less, roll 2 (plus 1 per negative point) and keep the lowest.'
        : '';
    return `Checks: ${count}, ${keep}, ${bonus}; then add the skill training bonus, the skill's extra modifier and item bonuses.${zero} Advantage/disadvantage add/remove one die.`;
}
