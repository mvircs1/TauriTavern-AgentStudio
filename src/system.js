// Sistema de RPG simples (sem nível/XP): atributos, perícias ligadas a atributos e recursos
// (Vida, Mana...). Modificador no estilo D&D: floor((valor - 10) / 2).
//
// Onde cada coisa fica:
// - Regras (o "sistema"): globais, no armazenamento do plugin (meta/system).
// - Ficha do jogador: uma por personagem (card) ou por grupo, no armazenamento do plugin.
// - Fichas de NPC: no chat (chat_metadata.agent_studio.sheets), então acompanham branches e exportações.
// - Fichas de NPC vinculadas a uma entrada de lorebook: no armazenamento do plugin, visíveis
//   em todo chat onde aquele lorebook estiver ativo.

import {
    attributeRollBonus,
    attributeStatBonus,
    DEFAULT_DICE,
    describeMethod,
    DICE_PRESETS,
    diceCount,
    formatRoll,
    normalizeDice,
    rollPool,
} from './dice.js';
import { createSerialQueue, generateId, LOG_PREFIX } from './util.js';

const META_TABLE = 'meta';
const SYSTEM_KEY = 'system';
const SHEET_INDEX_KEY = 'sheets';
const SHEETS_TABLE = 'sheets';
const CHAT_META_KEY = 'agent_studio';

const MAX_NAME = 60;
const MAX_DESCRIPTION = 2000;
const MAX_NOTES = 20_000;
const SCORE_RANGE = { min: 0, max: 99 };
const BONUS_RANGE = { min: -50, max: 50 };
const RESOURCE_RANGE = { min: 0, max: 1_000_000 };
const PLAYER_ALIASES = new Set(['', 'player', 'jogador', 'me', 'eu', 'user', 'usuario']);

export const KINDS = Object.freeze({
    attributes: 'attributes',
    skills: 'skills',
    resources: 'resources',
    stats: 'stats',
    abilityFields: 'abilityFields',
    trainingLevels: 'trainingLevels',
    slots: 'slots',
});

const MAX_ITEMS = 200;
const MAX_ABILITIES = 60;
const MAX_FIELD_VALUE = 500;
const MAX_EFFECT = 300;

export const DEFAULT_SYSTEM = Object.freeze({
    version: 1,
    defaultScore: 10,
    attributes: [
        { id: 'forca', name: 'Força', description: 'Poder físico: levantar, empurrar, golpear, quebrar.' },
        { id: 'destreza', name: 'Destreza', description: 'Agilidade, reflexos, precisão e equilíbrio.' },
        { id: 'constituicao', name: 'Constituição', description: 'Resistência física, saúde e fôlego.' },
        { id: 'inteligencia', name: 'Inteligência', description: 'Raciocínio, memória, conhecimento e atenção aos detalhes.' },
        { id: 'carisma', name: 'Carisma', description: 'Presença, persuasão, força de vontade e liderança.' },
    ],
    skills: [
        { id: 'atletismo', name: 'Atletismo', attribute: 'forca', description: 'Escalar, nadar, saltar, agarrar.' },
        { id: 'acrobacia', name: 'Acrobacia', attribute: 'destreza', description: 'Equilíbrio, piruetas, escapar de quedas.' },
        { id: 'furtividade', name: 'Furtividade', attribute: 'destreza', description: 'Mover-se sem ser visto ou ouvido.' },
        { id: 'resistencia', name: 'Resistência', attribute: 'constituicao', description: 'Aguentar dor, venenos, cansaço e clima.' },
        { id: 'investigacao', name: 'Investigação', attribute: 'inteligencia', description: 'Procurar pistas, deduzir, pesquisar.' },
        { id: 'percepcao', name: 'Percepção', attribute: 'inteligencia', description: 'Notar coisas, ouvir, perceber perigos.' },
        { id: 'persuasao', name: 'Persuasão', attribute: 'carisma', description: 'Convencer, negociar, inspirar.' },
        { id: 'intimidacao', name: 'Intimidação', attribute: 'carisma', description: 'Ameaçar, impor medo ou respeito.' },
    ],
    resources: [
        { id: 'vida', name: 'Vida', description: 'Pontos de vida. Em 0, o personagem cai (inconsciente ou pior, conforme a história).', defaultMax: 10 },
        { id: 'mana', name: 'Mana', description: 'Energia para magias e habilidades especiais.', defaultMax: 10 },
    ],
    // Estatísticas derivadas: total = base + modificador do atributo + bônus da ficha.
    stats: [
        { id: 'defesa', name: 'Defesa', description: 'Dificuldade para acertar o personagem: é a CD dos ataques contra ele. Bônus vêm de armadura, escudo, cobertura.', base: 10, attribute: 'destreza', defense: true },
        { id: 'iniciativa', name: 'Iniciativa', description: 'Ordem de ação no combate: role d20 + Iniciativa.', base: 0, attribute: 'destreza', defense: false },
        { id: 'deslocamento', name: 'Deslocamento', description: 'Metros que o personagem anda por turno.', base: 9, attribute: null, defense: false },
    ],
    // Campos extras de cada habilidade (além de custo, teste e efeito, que já existem sempre).
    abilityFields: [
        { id: 'alcance', name: 'Alcance', description: 'Até onde a habilidade chega (toque, 9 m, linha de visão...).' },
        { id: 'duracao', name: 'Duração', description: 'Quanto tempo o efeito dura (instantâneo, 1 minuto, até o fim da cena...).' },
        { id: 'recarga', name: 'Recarga', description: 'Com que frequência pode ser usada (à vontade, 1x por cena, 1x por descanso...).' },
    ],
    // Como os testes são rolados (ver dice.js). O padrão é o D&D.
    dice: { ...DEFAULT_DICE },
    // Níveis de treinamento das perícias (nome e bônus editáveis).
    trainingLevels: [
        { id: 'treinado', name: 'Treinado', description: '', bonus: 2 },
        { id: 'veterano', name: 'Veterano', description: '', bonus: 4 },
        { id: 'especialista', name: 'Especialista', description: '', bonus: 6 },
    ],
    // Partes do corpo onde itens podem ser equipados (o resto fica na mochila).
    slots: [
        { id: 'cabeca', name: 'Cabeça', description: 'Chapéus, elmos, máscaras, óculos.' },
        { id: 'torso', name: 'Torso', description: 'Armaduras, roupas, capas.' },
        { id: 'mao-principal', name: 'Mão principal', description: 'Arma ou ferramenta principal.' },
        { id: 'mao-secundaria', name: 'Mão secundária', description: 'Escudo, segunda arma, tocha, foco mágico.' },
        { id: 'pernas', name: 'Pernas', description: 'Calças, grevas.' },
        { id: 'pes', name: 'Pés', description: 'Botas, sapatos.' },
        { id: 'acessorios', name: 'Acessórios', description: 'Anéis, amuletos, cintos, brincos.' },
    ],
});

/** Regras em texto para a IA, de acordo com o método de rolagem atual. */
export function rulesText(definition) {
    const dice = definition.dice;
    const statAttribute = dice.attributeBonus === 'modifier' ? 'modifier' : 'value';
    return `${describeMethod(dice)} `
        + 'Skills: each has an attribute, an optional training level (bonus) and an extra free modifier. '
        + `Stats (like Defesa/Defense, Iniciativa) = base + attribute ${statAttribute} + sheet bonus + bonuses of equipped items. `
        + 'Difficulty classes (DC): 5 very easy, 10 easy, 15 medium, 20 hard, 25 very hard, 30 nearly impossible'
        + (dice.countMode === 'attribute' || dice.attributeBonus === 'none' ? ' (with big training bonuses, raise DCs accordingly)' : '')
        + '. An attack is a check against the target\'s defense stat (system_roll "against" or ability_use "target"). '
        + 'Abilities (spells, powers, techniques) live on each sheet: cost, check used to hit, effect (dice like "2d6+FOR" or text) and extra fields. '
        + 'Items live on each sheet: equipped on a body slot (their bonus counts) or in the backpack (bonus does not count). '
        + 'There are no levels or XP.';
}

/** Normaliza para comparar nomes: minúsculas, sem acentos e sem espaços nas pontas. */
export function normalizeName(value) {
    return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export function modifier(score) {
    return Math.floor((Number(score) - 10) / 2);
}

export function formatModifier(value) {
    return value >= 0 ? `+${value}` : `${value}`;
}

export function abbreviation(name) {
    return normalizeName(name).replace(/[^a-z0-9]/g, '').slice(0, 3).toUpperCase();
}

function slugify(name) {
    return normalizeName(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function toInt(value, label, { min, max }) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`"${label}" must be a number.`);
    const int = Math.trunc(number);
    if (int < min || int > max) throw new Error(`"${label}" must be between ${min} and ${max}.`);
    return int;
}

function normalizeDefinition(stored) {
    const base = structuredClone(DEFAULT_SYSTEM);
    if (!stored || typeof stored !== 'object') return base;
    const clean = (list, extra) => (Array.isArray(list) ? list : [])
        .filter(item => item && typeof item.id === 'string' && typeof item.name === 'string')
        .map(item => ({ id: item.id, name: item.name, description: String(item.description ?? ''), ...extra(item) }));
    return {
        version: 1,
        defaultScore: Number.isFinite(stored.defaultScore) ? stored.defaultScore : 10,
        attributes: Array.isArray(stored.attributes) ? clean(stored.attributes, () => ({})) : base.attributes,
        skills: Array.isArray(stored.skills) ? clean(stored.skills, item => ({ attribute: item.attribute ?? null })) : base.skills,
        resources: Array.isArray(stored.resources)
            ? clean(stored.resources, item => ({ defaultMax: Number.isFinite(item.defaultMax) ? item.defaultMax : 10 }))
            : base.resources,
        // Regras salvas antes da versão 0.5 não têm estatísticas nem campos de habilidade: usa o padrão.
        stats: Array.isArray(stored.stats)
            ? clean(stored.stats, item => ({
                base: Number.isFinite(item.base) ? item.base : 0,
                attribute: item.attribute ?? null,
                defense: item.defense === true,
            }))
            : base.stats,
        abilityFields: Array.isArray(stored.abilityFields) ? clean(stored.abilityFields, () => ({})) : base.abilityFields,
        // Regras salvas antes da versão 0.6 não têm método de rolagem, treinamento nem partes do corpo.
        dice: normalizeDice(stored.dice),
        trainingLevels: Array.isArray(stored.trainingLevels)
            ? clean(stored.trainingLevels, item => ({ bonus: Number.isFinite(item.bonus) ? item.bonus : 0 }))
            : base.trainingLevels,
        slots: Array.isArray(stored.slots) ? clean(stored.slots, () => ({})) : base.slots,
    };
}

function normalizeItem(item) {
    const bonus = item?.bonus && item.bonus.target && Number.isFinite(Number(item.bonus.value)) && Number(item.bonus.value) !== 0
        ? { target: String(item.bonus.target), value: Math.trunc(Number(item.bonus.value)) }
        : null;
    return {
        id: String(item?.id ?? generateId('i')),
        name: String(item?.name ?? 'Item'),
        description: String(item?.description ?? ''),
        quantity: Number.isFinite(Number(item?.quantity)) ? Math.max(0, Math.trunc(Number(item.quantity))) : 1,
        slot: item?.slot ? String(item.slot) : null,
        bonus,
    };
}

const MAX_CONDITIONS = 30;
/** Alvos de condição que valem para todo teste. */
const ALL_CHECKS = new Set(['checks', 'all', 'todos', 'tudo', 'testes', 'todos os testes', 'all checks']);

function normalizeCondition(condition) {
    const rounds = condition?.rounds === null || condition?.rounds === undefined || condition?.rounds === ''
        ? null
        : Math.max(0, Math.trunc(Number(condition.rounds)) || 0);
    const value = Math.trunc(Number(condition?.value)) || 0;
    return {
        id: String(condition?.id ?? generateId('c')),
        name: String(condition?.name ?? 'Condição').slice(0, MAX_NAME),
        description: String(condition?.description ?? '').slice(0, MAX_DESCRIPTION),
        target: value && condition?.target ? String(condition.target) : null,
        value: condition?.target ? value : 0,
        rounds: rounds === 0 ? null : rounds,
    };
}

/** Condição como a IA vê: "Envenenado: -2 em Força, 3 rodadas". */
export function conditionToolView(condition) {
    const result = { name: condition.name };
    if (condition.description) result.description = condition.description;
    if (condition.value) result.effect = `${formatModifier(condition.value)} on ${condition.targetName ?? condition.target}`;
    result.duration = condition.rounds ? `${condition.rounds} round(s) left` : 'until removed';
    return result;
}

/** "Envenenado (-2 Força, 3 rodadas)". */
export function conditionLabel(condition) {
    const bits = [];
    if (condition.value) bits.push(`${formatModifier(condition.value)} ${condition.targetName ?? condition.target}`);
    if (condition.rounds) bits.push(`${condition.rounds} rodada${condition.rounds === 1 ? '' : 's'}`);
    return bits.length ? `${condition.name} (${bits.join(', ')})` : condition.name;
}

const OUTCOME_PT = {
    'CRITICAL SUCCESS': 'SUCESSO CRÍTICO',
    SUCCESS: 'SUCESSO',
    FAILURE: 'FALHA',
    'CRITICAL FAILURE': 'FALHA CRÍTICA',
};

function normalizeAbility(ability) {
    const cost = ability?.cost && Number(ability.cost.amount) > 0 && ability.cost.resource
        ? { amount: Math.trunc(Number(ability.cost.amount)), resource: String(ability.cost.resource) }
        : null;
    return {
        id: String(ability?.id ?? generateId('h')),
        name: String(ability?.name ?? 'Habilidade'),
        description: String(ability?.description ?? ''),
        cost,
        check: ability?.check ? String(ability.check) : null,
        effect: String(ability?.effect ?? ''),
        fields: ability?.fields && typeof ability.fields === 'object' ? { ...ability.fields } : {},
    };
}

function normalizeSheet(sheet) {
    return {
        id: String(sheet.id),
        name: String(sheet.name ?? 'Sem nome'),
        kind: sheet.kind === 'player' ? 'player' : 'npc',
        notes: String(sheet.notes ?? ''),
        attributes: sheet.attributes && typeof sheet.attributes === 'object' ? { ...sheet.attributes } : {},
        skills: sheet.skills && typeof sheet.skills === 'object' ? { ...sheet.skills } : {},
        resources: sheet.resources && typeof sheet.resources === 'object' ? structuredClone(sheet.resources) : {},
        stats: sheet.stats && typeof sheet.stats === 'object' ? { ...sheet.stats } : {},
        training: sheet.training && typeof sheet.training === 'object' ? { ...sheet.training } : {},
        abilities: Array.isArray(sheet.abilities) ? sheet.abilities.map(normalizeAbility) : [],
        items: Array.isArray(sheet.items) ? sheet.items.map(normalizeItem) : [],
        conditions: Array.isArray(sheet.conditions) ? sheet.conditions.map(normalizeCondition) : [],
        link: sheet.link && typeof sheet.link.book === 'string' ? { ...sheet.link } : null,
        updatedAt: sheet.updatedAt ?? null,
    };
}

/**
 * Acha um item pelo id ou nome, tolerando acentos/maiúsculas e nomes dentro de frases
 * ("Teste de Furtividade" acha "Furtividade"). Só aceita um resultado inequívoco.
 */
function findByName(list, reference) {
    const raw = String(reference ?? '').trim();
    if (!raw) return null;
    const wanted = normalizeName(raw);
    const exact = list.find(item => item.id === raw) ?? list.find(item => normalizeName(item.name) === wanted);
    if (exact) return exact;
    const words = name => new RegExp(`(^|[^a-z0-9])${normalizeName(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`);
    const inside = list.filter(item => words(item.name).test(wanted));
    if (inside.length === 1) return inside[0];
    if (inside.length > 1) return inside.sort((a, b) => b.name.length - a.name.length)[0];
    const prefix = list.filter(item => wanted.length >= 3 && normalizeName(item.name).startsWith(wanted));
    return prefix.length === 1 ? prefix[0] : null;
}

/** Aceita lista [{name, score}] ou mapa {"Força": 14} / {"Vida": {"max": 20}}. */
function toChangeList(input) {
    if (input === undefined || input === null) return [];
    let value = input;
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { throw new Error('Expected a list like [{"name": "...", ...}].'); }
    }
    if (Array.isArray(value)) return value.filter(item => item && typeof item === 'object');
    if (typeof value === 'object') {
        if ('name' in value) return [value];
        return Object.entries(value).map(([name, item]) => (item && typeof item === 'object' ? { name, ...item } : { name, value: item }));
    }
    throw new Error('Expected a list like [{"name": "...", ...}].');
}

/**
 * Rola uma expressão como "2d6+3", "1d8 + FOR" ou "d10 + Destreza - 1". Atributos (nome ou
 * abreviação de 3 letras), perícias e estatísticas viram seus modificadores/totais.
 * Devolve null se a expressão não for rolável (texto livre como "atordoa o alvo").
 * @param {string} expression
 * @param {{ attributes: any[], skills: any[], stats: any[] }} view
 * @param {(sides: number) => number} rollDie
 */
export function rollExpression(expression, view, rollDie) {
    const text = String(expression ?? '').normalize('NFC').trim();
    if (!text || text.length > 120) return null;
    const terms = text.replace(/\s+/g, '').split(/(?=[+-])/);
    let total = 0;
    const parts = [];
    let hasDice = false;
    for (const rawTerm of terms) {
        const sign = rawTerm.startsWith('-') ? -1 : 1;
        const term = rawTerm.replace(/^[+-]/, '');
        if (!term) return null;
        const dice = /^(\d*)d(\d+)$/i.exec(term);
        if (dice) {
            const count = dice[1] ? Number(dice[1]) : 1;
            const sides = Number(dice[2]);
            if (count < 1 || count > 100 || sides < 2 || sides > 1000) return null;
            const rolls = Array.from({ length: count }, () => rollDie(sides));
            const sum = rolls.reduce((a, b) => a + b, 0);
            total += sign * sum;
            parts.push(`${sign < 0 ? '-' : parts.length ? '+' : ''}${count}d${sides} (${rolls.join('+')})`);
            hasDice = true;
            continue;
        }
        if (/^\d+$/.test(term)) {
            total += sign * Number(term);
            parts.push(`${sign < 0 ? '-' : parts.length ? '+' : ''}${term}`);
            continue;
        }
        const wanted = normalizeName(term);
        const attribute = view.attributes.find(a => normalizeName(a.name) === wanted || abbreviation(a.name) === term.toUpperCase());
        const skill = attribute ? null : view.skills.find(s => normalizeName(s.name) === wanted);
        const stat = attribute || skill ? null : view.stats.find(s => normalizeName(s.name) === wanted);
        // No D&D o atributo entra como modificador; nos outros métodos, como o próprio valor.
        const value = attribute ? (attribute.termValue ?? attribute.modifier) : (skill?.total ?? stat?.total);
        if (value === undefined) return null;
        total += sign * value;
        parts.push(`${sign < 0 ? '-' : parts.length ? '+' : ''}${term} (${formatModifier(value)})`);
    }
    if (!hasDice && terms.length === 1 && !/^\d+$/.test(terms[0].replace(/^[+-]/, ''))) return null;
    return { total: Math.max(0, total), detail: `${parts.join(' ')} = ${Math.max(0, total)}` };
}

/** Item no formato compacto que a IA recebe. */
function itemToolView(item) {
    const result = { name: item.name };
    if (item.quantity !== 1) result.quantity = item.quantity;
    if (item.description) result.description = item.description;
    if (item.bonus) result.bonus = `${formatModifier(item.bonus.value)} ${item.bonus.targetName}`;
    return result;
}

/** Habilidade no formato compacto que a IA recebe. */
function abilityToolView(ability) {
    const result = { name: ability.name };
    if (ability.description) result.description = ability.description;
    if (ability.cost) result.cost = `${ability.cost.amount} ${ability.cost.resource}`;
    if (ability.checkName) result.check = ability.checkName;
    if (ability.effect) result.effect = ability.effect;
    for (const field of ability.fields) {
        if (field.value) result[field.name] = field.value;
    }
    return result;
}

function defaultRandom() {
    const buffer = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buffer);
    return buffer[0] / 2 ** 32;
}

export class SystemService {
    /**
     * @param {import('./storage.js').Storage} storage
     * @param {import('./lorebook.js').LorebookService} lore
     * @param {{ random?: () => number }} [options] random em [0, 1), substituível nos testes
     */
    constructor(storage, lore, { random = defaultRandom } = {}) {
        this.storage = storage;
        this.lore = lore;
        this.random = random;
        this.enqueue = createSerialQueue();
        this.definition = null;
        /** id -> { name, kind, scope: { type: 'player', key } | { type: 'lore', book, uid } } */
        this.index = null;
        this.sheetCache = new Map();
        this.listeners = new Set();
        /** @type {import('./journal.js').RunJournal|null} */
        this.journal = null;
        lore.sheetLinksForBook = book => this.sheetLinksForBook(book);
    }

    // ---------- infraestrutura ----------

    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(change) {
        for (const listener of this.listeners) {
            try { listener(change); } catch (error) { console.error(LOG_PREFIX, error); }
        }
    }

    context() {
        return SillyTavern.getContext();
    }

    async load() {
        if (!this.definition) this.definition = normalizeDefinition(await this.storage.get(META_TABLE, SYSTEM_KEY));
        if (!this.index) {
            const stored = await this.storage.get(META_TABLE, SHEET_INDEX_KEY);
            this.index = stored?.items && typeof stored.items === 'object' ? stored.items : {};
        }
    }

    run(task) {
        return this.enqueue(async () => {
            await this.load();
            return task();
        });
    }

    async saveDefinition() {
        await this.storage.set(META_TABLE, SYSTEM_KEY, this.definition);
    }

    async saveIndex() {
        await this.storage.set(META_TABLE, SHEET_INDEX_KEY, { items: this.index });
    }

    sheetLinksForBook(book) {
        const result = new Map();
        for (const entry of Object.values(this.index ?? {})) {
            if (entry.scope?.type === 'lore' && entry.scope.book === book) result.set(entry.scope.uid, entry.name);
        }
        return result;
    }

    // ---------- regras (definição do sistema) ----------

    getDefinition() {
        return this.run(() => structuredClone(this.definition));
    }

    findItem(kind, reference) {
        return findByName(this.definition[kind], reference);
    }

    requireItem(kind, reference) {
        const item = this.findItem(kind, reference);
        if (item) return item;
        const label = { attributes: 'attribute', skills: 'skill', resources: 'resource', stats: 'stat', abilityFields: 'ability field', trainingLevels: 'training level', slots: 'body slot' }[kind];
        throw new Error(`Unknown ${label} "${reference}". Valid: ${this.definition[kind].map(i => i.name).join(', ')}.`);
    }

    /** Cria ou atualiza um atributo, perícia ou recurso. */
    saveItem(kind, input) {
        return this.run(async () => {
            if (!KINDS[kind]) throw new Error(`Invalid kind: ${kind}`);
            const list = this.definition[kind];
            const name = String(input?.name ?? '').trim();
            if (!name) throw new Error('O nome é obrigatório.');
            if (name.length > MAX_NAME) throw new Error(`O nome pode ter no máximo ${MAX_NAME} caracteres.`);
            const description = String(input?.description ?? '').trim().slice(0, MAX_DESCRIPTION);
            const existing = input?.id ? list.find(item => item.id === input.id) : null;
            if (input?.id && !existing) throw new Error('Item não encontrado.');
            const clash = list.find(item => item !== existing && normalizeName(item.name) === normalizeName(name));
            if (clash) throw new Error(`Já existe "${clash.name}".`);

            const item = existing ?? { id: this.uniqueId(list, name) };
            item.name = name;
            item.description = description;
            if (kind === KINDS.skills) {
                const attribute = input?.attribute ? this.definition.attributes.find(a => a.id === input.attribute) : null;
                if (input?.attribute && !attribute) throw new Error('Atributo não encontrado.');
                item.attribute = attribute?.id ?? null;
            }
            if (kind === KINDS.resources) {
                item.defaultMax = toInt(input?.defaultMax ?? 10, 'máximo padrão', RESOURCE_RANGE);
            }
            if (kind === KINDS.trainingLevels) {
                item.bonus = toInt(input?.bonus ?? 0, 'bônus', { min: -100, max: 1000 });
            }
            if (kind === KINDS.stats) {
                const attribute = input?.attribute ? this.definition.attributes.find(a => a.id === input.attribute) : null;
                if (input?.attribute && !attribute) throw new Error('Atributo não encontrado.');
                item.attribute = attribute?.id ?? null;
                item.base = toInt(input?.base ?? 0, 'valor base', { min: -100, max: 1000 });
                item.defense = input?.defense === true || input?.defense === 'true';
                // Só uma estatística pode ser a Defesa (CD dos ataques).
                if (item.defense) {
                    for (const other of list) if (other !== item) other.defense = false;
                }
            }
            if (!existing) list.push(item);
            await this.saveDefinition();
            this.emit({ type: 'definition' });
            return structuredClone(item);
        });
    }

    deleteItem(kind, id) {
        return this.run(async () => {
            const list = this.definition[kind];
            const index = list.findIndex(item => item.id === id);
            if (index === -1) return;
            list.splice(index, 1);
            if (kind === KINDS.attributes) {
                for (const skill of this.definition.skills) {
                    if (skill.attribute === id) skill.attribute = null;
                }
                for (const stat of this.definition.stats) {
                    if (stat.attribute === id) stat.attribute = null;
                }
            }
            await this.saveDefinition();
            this.emit({ type: 'definition' });
        });
    }

    /** Muda campos do método de rolagem (vira "personalizado" se não bater com um modelo). */
    setDice(changes) {
        return this.run(async () => {
            const merged = normalizeDice({ ...this.definition.dice, ...changes, preset: 'custom' });
            const preset = Object.entries(DICE_PRESETS).find(([, value]) => Object.entries(value.dice).every(([key, val]) => merged[key] === val));
            merged.preset = preset ? preset[0] : 'custom';
            this.definition.dice = merged;
            if (changes.defaultScore !== undefined) {
                this.definition.defaultScore = toInt(changes.defaultScore, 'valor inicial dos atributos', SCORE_RANGE);
            }
            await this.saveDefinition();
            this.emit({ type: 'definition' });
            return { dice: { ...merged }, defaultScore: this.definition.defaultScore };
        });
    }

    /** Aplica um modelo (D&D, Ordem, Direto): método, valor inicial dos atributos e bônus de treinamento. */
    applyDicePreset(presetId) {
        return this.run(async () => {
            const preset = DICE_PRESETS[presetId];
            if (!preset) throw new Error('Modelo desconhecido.');
            this.definition.dice = { preset: presetId, ...preset.dice };
            this.definition.defaultScore = preset.defaultScore;
            const names = ['Treinado', 'Veterano', 'Especialista'];
            preset.training.forEach((bonus, index) => {
                const level = this.definition.trainingLevels[index];
                if (level) level.bonus = bonus;
                else this.definition.trainingLevels.push({ id: this.uniqueId(this.definition.trainingLevels, names[index]), name: names[index], description: '', bonus });
            });
            await this.saveDefinition();
            this.emit({ type: 'definition' });
            return structuredClone(this.definition);
        });
    }

    resetDefinition() {
        return this.run(async () => {
            this.definition = structuredClone(DEFAULT_SYSTEM);
            await this.saveDefinition();
            this.emit({ type: 'definition' });
        });
    }

    uniqueId(list, name) {
        const base = slugify(name) || 'item';
        let id = base;
        let n = 2;
        while (list.some(item => item.id === id)) id = `${base}-${n++}`;
        return id;
    }

    // ---------- escopo atual ----------

    scope() {
        const context = this.context();
        const chatId = typeof context.getCurrentChatId === 'function' ? context.getCurrentChatId() : null;
        const character = context.characterId !== undefined && context.characterId !== null
            ? context.characters?.[context.characterId]
            : null;
        let playerKey = null;
        if (context.groupId) playerKey = `group:${context.groupId}`;
        else if (character?.avatar) playerKey = `char:${character.avatar}`;
        return {
            context,
            chatId: chatId || null,
            hasChat: Boolean(chatId && context.chatMetadata),
            playerKey,
            characterName: character?.name ?? (context.groupId ? 'grupo' : null),
            userName: context.name1 || 'Jogador',
        };
    }

    newSheet({ name, kind }) {
        const sheet = {
            id: generateId(kind === 'player' ? 'p' : 'n'),
            name,
            kind,
            notes: '',
            attributes: {},
            skills: {},
            resources: {},
            stats: {},
            training: {},
            abilities: [],
            items: [],
            link: null,
            updatedAt: new Date().toISOString(),
        };
        for (const attribute of this.definition.attributes) sheet.attributes[attribute.id] = this.definition.defaultScore;
        for (const resource of this.definition.resources) sheet.resources[resource.id] = { current: resource.defaultMax, max: resource.defaultMax };
        return sheet;
    }

    async loadStoredSheet(id) {
        if (this.sheetCache.has(id)) return this.sheetCache.get(id);
        const stored = await this.storage.get(SHEETS_TABLE, id);
        const sheet = stored ? normalizeSheet(stored) : null;
        if (sheet) this.sheetCache.set(id, sheet);
        return sheet;
    }

    chatSheets(scope) {
        if (!scope.hasChat) return {};
        const bag = scope.context.chatMetadata[CHAT_META_KEY];
        return bag?.sheets && typeof bag.sheets === 'object' ? bag.sheets : {};
    }

    async writeChatSheets(scope, sheets) {
        const meta = scope.context.chatMetadata;
        meta[CHAT_META_KEY] = { ...(meta[CHAT_META_KEY] ?? {}), sheets };
        await scope.context.saveMetadata();
    }

    async ensurePlayer(scope) {
        if (!scope.playerKey) return null;
        const found = Object.entries(this.index)
            .find(([, entry]) => entry.scope?.type === 'player' && entry.scope.key === scope.playerKey);
        if (found) return this.loadStoredSheet(found[0]);
        const sheet = this.newSheet({ name: scope.userName, kind: 'player' });
        await this.storage.set(SHEETS_TABLE, sheet.id, sheet);
        this.sheetCache.set(sheet.id, sheet);
        this.index[sheet.id] = { name: sheet.name, kind: 'player', scope: { type: 'player', key: scope.playerKey } };
        await this.saveIndex();
        return sheet;
    }

    /** Fichas visíveis agora: jogador, NPCs do chat e NPCs vinculados a lorebooks ativos. */
    async visibleSheets(scope = this.scope()) {
        const list = [];
        const player = await this.ensurePlayer(scope);
        if (player) list.push({ sheet: player, location: 'player' });
        for (const sheet of Object.values(this.chatSheets(scope))) {
            list.push({ sheet: normalizeSheet(sheet), location: 'chat' });
        }
        const linked = Object.entries(this.index).filter(([, entry]) => entry.scope?.type === 'lore');
        if (linked.length) {
            let active = new Set();
            try {
                active = await this.lore.activeBookNames();
            } catch (error) {
                console.warn(LOG_PREFIX, 'Não consegui ver os lorebooks ativos', error);
            }
            for (const [id, entry] of linked) {
                if (!active.has(entry.scope.book)) continue;
                const sheet = await this.loadStoredSheet(id);
                if (sheet) list.push({ sheet, location: 'lorebook' });
            }
        }
        return list;
    }

    async resolve(reference, scope = this.scope()) {
        const list = await this.visibleSheets(scope);
        const raw = typeof reference === 'string' ? reference.trim() : '';
        if (PLAYER_ALIASES.has(normalizeName(raw))) {
            const player = list.find(item => item.location === 'player');
            if (!player) throw new Error('There is no player sheet here: open a chat with a character first.');
            return player;
        }
        const wanted = normalizeName(raw);
        let found = list.find(item => item.sheet.id === raw)
            ?? list.find(item => normalizeName(item.sheet.name) === wanted);
        if (!found) {
            const partial = list.filter(item => normalizeName(item.sheet.name).includes(wanted));
            if (partial.length === 1) found = partial[0];
        }
        if (!found) {
            const names = list.map(item => `"${item.sheet.name}"`).join(', ') || 'none';
            throw new Error(`Sheet not found: "${raw}". Available sheets: ${names}.`);
        }
        return found;
    }

    async persist(item, scope) {
        item.sheet.updatedAt = new Date().toISOString();
        if (item.location === 'chat') {
            const sheets = { ...this.chatSheets(scope), [item.sheet.id]: item.sheet };
            await this.writeChatSheets(scope, sheets);
        } else {
            await this.storage.set(SHEETS_TABLE, item.sheet.id, item.sheet);
            this.sheetCache.set(item.sheet.id, item.sheet);
            const entry = this.index[item.sheet.id];
            if (entry && entry.name !== item.sheet.name) {
                entry.name = item.sheet.name;
                await this.saveIndex();
            }
        }
        this.emit({ type: 'sheet', id: item.sheet.id });
    }

    // ---------- leitura (formato compacto para a IA e para a interface) ----------

    view(item) {
        const definition = this.definition;
        const dice = definition.dice;
        const sheet = item.sheet;

        // Itens equipados (numa parte do corpo que ainda existe nas regras) dão bônus.
        const slotIds = new Set(definition.slots.map(slot => slot.id));
        const equipped = (sheet.items ?? []).filter(entry => entry.slot && slotIds.has(entry.slot));
        const itemBonus = targetId => equipped
            .filter(entry => entry.bonus?.target === targetId)
            .reduce((total, entry) => total + entry.bonus.value, 0);
        const conditions = sheet.conditions ?? [];
        const conditionBonus = targetId => conditions
            .filter(entry => entry.target === targetId)
            .reduce((total, entry) => total + entry.value, 0);

        const attributes = definition.attributes.map(attribute => {
            const score = Number.isFinite(sheet.attributes[attribute.id]) ? sheet.attributes[attribute.id] : definition.defaultScore;
            const count = diceCount(dice, score);
            const fromConditions = conditionBonus(attribute.id);
            const rollBonus = attributeRollBonus(dice, score) + fromConditions;
            return {
                id: attribute.id,
                name: attribute.name,
                score,
                modifier: modifier(score),
                rollBonus,
                conditionBonus: fromConditions,
                termValue: attributeStatBonus(dice, score),
                diceCount: count,
                roll: formatRoll(dice, count, rollBonus),
            };
        });
        const byId = new Map(attributes.map(attribute => [attribute.id, attribute]));
        const levels = new Map(definition.trainingLevels.map(level => [level.id, level]));
        const skills = definition.skills.map(skill => {
            const bonus = Number.isFinite(sheet.skills[skill.id]) ? sheet.skills[skill.id] : 0;
            const level = levels.get(sheet.training?.[skill.id]) ?? null;
            const attribute = byId.get(skill.attribute) ?? null;
            const items = itemBonus(skill.id);
            const fromConditions = conditionBonus(skill.id);
            const total = (attribute?.rollBonus ?? 0) + (level?.bonus ?? 0) + bonus + items + fromConditions;
            const count = attribute ? attribute.diceCount : dice.fixedCount;
            return {
                id: skill.id,
                name: skill.name,
                attribute: attribute?.name ?? null,
                attributeId: attribute?.id ?? null,
                training: level?.id ?? null,
                trainingName: level?.name ?? null,
                trainingBonus: level?.bonus ?? 0,
                bonus,
                itemBonus: items,
                conditionBonus: fromConditions,
                total,
                diceCount: count,
                roll: formatRoll(dice, count, total),
            };
        });
        const resources = definition.resources.map(resource => {
            const value = sheet.resources[resource.id] ?? { current: resource.defaultMax, max: resource.defaultMax };
            return { id: resource.id, name: resource.name, current: value.current, max: value.max };
        });
        const stats = definition.stats.map(stat => {
            const bonus = Number.isFinite(sheet.stats?.[stat.id]) ? sheet.stats[stat.id] : 0;
            const attribute = byId.get(stat.attribute) ?? null;
            const items = itemBonus(stat.id);
            const fromConditions = conditionBonus(stat.id);
            return {
                id: stat.id,
                name: stat.name,
                base: stat.base,
                attribute: attribute?.name ?? null,
                attributeId: attribute?.id ?? null,
                bonus,
                itemBonus: items,
                conditionBonus: fromConditions,
                total: stat.base + (attribute?.termValue ?? 0) + bonus + items + fromConditions,
                // Ao rolar uma estatística (ex.: Iniciativa), o atributo define os dados no método "Ordem".
                rollBonus: stat.base + (attribute?.rollBonus ?? 0) + bonus + items + fromConditions,
                diceCount: attribute ? attribute.diceCount : dice.fixedCount,
                defense: stat.defense === true,
            };
        });
        const checkName = id => skills.find(s => s.id === id)?.name ?? attributes.find(a => a.id === id)?.name
            ?? stats.find(s => s.id === id)?.name ?? null;
        const abilities = (sheet.abilities ?? []).map(ability => ({
            id: ability.id,
            name: ability.name,
            description: ability.description,
            cost: ability.cost
                ? { amount: ability.cost.amount, resource: definition.resources.find(r => r.id === ability.cost.resource)?.name ?? ability.cost.resource, resourceId: ability.cost.resource }
                : null,
            check: ability.check,
            checkName: ability.check ? checkName(ability.check) : null,
            effect: ability.effect,
            fields: definition.abilityFields
                .map(field => ({ id: field.id, name: field.name, value: ability.fields?.[field.id] ?? '' })),
        }));
        const targetName = id => checkName(id) ?? id;
        const items = (sheet.items ?? []).map(entry => {
            const slot = entry.slot && slotIds.has(entry.slot) ? definition.slots.find(s => s.id === entry.slot) : null;
            return {
                id: entry.id,
                name: entry.name,
                description: entry.description,
                quantity: entry.quantity,
                slot: slot?.id ?? null,
                slotName: slot?.name ?? null,
                bonus: entry.bonus ? { target: entry.bonus.target, targetName: targetName(entry.bonus.target), value: entry.bonus.value } : null,
            };
        });
        const conditionList = conditions.map(entry => ({
            id: entry.id,
            name: entry.name,
            description: entry.description,
            target: entry.target,
            targetName: entry.target ? (ALL_CHECKS.has(entry.target) ? 'todos os testes' : targetName(entry.target)) : null,
            value: entry.value,
            rounds: entry.rounds,
        }));
        return {
            id: sheet.id,
            name: sheet.name,
            kind: sheet.kind,
            location: item.location,
            link: sheet.link,
            notes: sheet.notes,
            conditions: conditionList,
            checkModifier: conditionBonus('checks'),
            attributes,
            skills,
            resources,
            stats,
            abilities,
            items,
            updatedAt: sheet.updatedAt,
        };
    }

    toolView(item) {
        const view = this.view(item);
        const dnd = this.definition.dice.attributeBonus === 'modifier';
        const result = {
            id: view.id,
            name: view.name,
            kind: view.kind,
            location: view.location,
            resources: view.resources.map(r => ({ name: r.name, current: r.current, max: r.max })),
            stats: view.stats.map(s => {
                const stat = { name: s.name, total: s.total, bonus: s.bonus };
                if (s.itemBonus) stat.from_items = s.itemBonus;
                if (s.defense) stat.is_defense = true;
                return stat;
            }),
            attributes: view.attributes.map(a => (dnd
                ? { name: a.name, score: a.score, mod: formatModifier(a.modifier) }
                : { name: a.name, score: a.score, roll: a.roll })),
            skills: view.skills.map(s => {
                const skill = { name: s.name, attribute: s.attribute, roll: s.roll };
                if (s.trainingName) skill.training = `${s.trainingName} (${formatModifier(s.trainingBonus)})`;
                if (s.bonus) skill.extra_modifier = s.bonus;
                if (s.itemBonus) skill.from_items = s.itemBonus;
                return skill;
            }),
            abilities: view.abilities.map(abilityToolView),
            equipment: {},
            backpack: [],
        };
        for (const slot of this.definition.slots) {
            const worn = view.items.filter(entry => entry.slot === slot.id).map(itemToolView);
            if (worn.length) result.equipment[slot.name] = worn;
        }
        result.backpack = view.items.filter(entry => !entry.slot).map(itemToolView);
        if (view.conditions.length) result.conditions = view.conditions.map(conditionToolView);
        if (view.link) result.linked_lorebook_entry = view.link;
        if (view.notes) result.notes = view.notes;
        return result;
    }

    systemInfo({ section = 'all' } = {}) {
        return this.run(() => {
            const wants = part => !section || section === 'all' || section === part;
            const definition = this.definition;
            const result = {};
            if (wants('rules')) {
                result.rules = rulesText(definition);
                result.dice_method = { ...definition.dice };
                result.default_score = definition.defaultScore;
            }
            if (wants('attributes')) {
                result.attributes = definition.attributes.map(a => ({ name: a.name, description: a.description }));
            }
            if (wants('skills')) {
                result.skills = definition.skills.map(s => ({
                    name: s.name,
                    attribute: definition.attributes.find(a => a.id === s.attribute)?.name ?? null,
                    description: s.description,
                }));
                result.training_levels = definition.trainingLevels.map(level => ({ name: level.name, bonus: level.bonus }));
            }
            if (wants('resources')) {
                result.resources = definition.resources.map(r => ({ name: r.name, description: r.description, default_max: r.defaultMax }));
            }
            if (wants('stats')) {
                const statAttribute = definition.dice.attributeBonus === 'modifier' ? 'modifier' : 'value';
                result.stats = definition.stats.map(s => {
                    const stat = {
                        name: s.name,
                        formula: `${s.base}${s.attribute ? ` + ${definition.attributes.find(a => a.id === s.attribute)?.name ?? '?'} ${statAttribute}` : ''} + sheet bonus + equipped items`,
                        description: s.description,
                    };
                    if (s.defense) stat.is_defense = true;
                    return stat;
                });
            }
            if (wants('abilities')) {
                result.ability_fields = definition.abilityFields.map(f => ({ name: f.name, description: f.description }));
            }
            if (wants('items')) {
                result.body_slots = definition.slots.map(slot => ({ name: slot.name, description: slot.description }));
            }
            return result;
        });
    }

    listSheets({ location = 'all' } = {}) {
        return this.run(async () => {
            const scope = this.scope();
            const list = (await this.visibleSheets(scope))
                .filter(item => !location || location === 'all' || item.location === location);
            return {
                chat_available: scope.hasChat,
                sheets: list.map(item => {
                    const view = this.view(item);
                    const entry = {
                        id: view.id,
                        name: view.name,
                        kind: view.kind,
                        location: view.location,
                        resources: view.resources.map(r => `${r.name} ${r.current}/${r.max}`).join(', '),
                    };
                    const defense = view.stats.find(s => s.defense);
                    if (defense) entry.defense = `${defense.name} ${defense.total}`;
                    if (view.conditions.length) entry.conditions = view.conditions.map(conditionLabel).join('; ');
                    if (view.abilities.length) entry.abilities = view.abilities.map(a => a.name).join(', ');
                    if (view.link) entry.linked_lorebook_entry = view.link;
                    return entry;
                }),
            };
        });
    }

    readSheet(reference) {
        return this.run(async () => this.toolView(await this.resolve(reference)));
    }

    /** Para a interface: escopo atual + fichas visíveis já calculadas. */
    snapshot() {
        return this.run(async () => {
            const scope = this.scope();
            const list = await this.visibleSheets(scope);
            return {
                definition: structuredClone(this.definition),
                scope: { chatId: scope.chatId, hasChat: scope.hasChat, playerKey: scope.playerKey, characterName: scope.characterName },
                sheets: list.map(item => this.view(item)),
            };
        });
    }

    // ---------- escrita ----------

    /**
     * Aplica mudanças numa ficha. Listas podem vir como [{name, score}] ou mapas {"Força": 14}.
     * `value` também é aceito no lugar de score/bonus; para recursos, `value` sozinho define o atual
     * (ou atual e máximo ao criar).
     */
    applyChanges(sheet, { name, notes, attributes, skills, resources, stats } = {}, { creating = false } = {}) {
        for (const change of toChangeList(stats)) {
            const stat = this.requireItem(KINDS.stats, change.name ?? change.id);
            sheet.stats = sheet.stats ?? {};
            sheet.stats[stat.id] = toInt(change.bonus ?? change.value, `${stat.name} bonus`, BONUS_RANGE);
        }
        if (name !== undefined && name !== null) {
            const clean = String(name).normalize('NFC').trim();
            if (!clean) throw new Error('Sheet name cannot be empty.');
            sheet.name = clean.slice(0, MAX_NAME);
        }
        if (notes !== undefined && notes !== null) sheet.notes = String(notes).normalize('NFC').slice(0, MAX_NOTES);
        for (const change of toChangeList(attributes)) {
            const attribute = this.requireItem(KINDS.attributes, change.name ?? change.id);
            sheet.attributes[attribute.id] = toInt(change.score ?? change.value, `${attribute.name} score`, SCORE_RANGE);
        }
        for (const change of toChangeList(skills)) {
            const skill = this.requireItem(KINDS.skills, change.name ?? change.id);
            const extra = change.bonus ?? change.value;
            if (extra !== undefined && extra !== null && extra !== '') {
                sheet.skills[skill.id] = toInt(extra, `${skill.name} bonus`, BONUS_RANGE);
            }
            if (change.training !== undefined) {
                sheet.training = sheet.training ?? {};
                const wanted = change.training === null ? '' : normalizeName(change.training);
                if (!wanted || ['none', 'nenhum', 'destreinado', 'untrained', '0'].includes(wanted)) {
                    delete sheet.training[skill.id];
                } else {
                    sheet.training[skill.id] = this.requireItem(KINDS.trainingLevels, change.training).id;
                }
            }
        }
        for (const change of toChangeList(resources)) {
            const resource = this.requireItem(KINDS.resources, change.name ?? change.id);
            const value = sheet.resources[resource.id] ?? { current: resource.defaultMax, max: resource.defaultMax };
            let max = change.max;
            let current = change.current;
            if (change.value !== undefined && change.value !== null && max === undefined && current === undefined) {
                current = change.value;
                if (creating) max = change.value;
            }
            if (max !== undefined && max !== null) value.max = toInt(max, `${resource.name} max`, RESOURCE_RANGE);
            if (current !== undefined && current !== null) value.current = toInt(current, `${resource.name} current`, RESOURCE_RANGE);
            else if (creating && max !== undefined && max !== null) value.current = value.max;
            value.current = Math.min(value.current, value.max);
            sheet.resources[resource.id] = value;
        }
    }

    // ---------- diário de alterações (desfazer ao regenerar) ----------

    /** Guarda o estado da ficha antes da primeira mudança feita por uma run. */
    async captureSheet(runId, item, scope) {
        if (!runId || !this.journal) return;
        await this.journal.capture(runId, `sheet:${item.sheet.id}`, async () => ({
            kind: 'sheet',
            id: item.sheet.id,
            chatId: scope.chatId,
            before: {
                location: item.location,
                sheet: structuredClone(item.sheet),
                indexEntry: this.index[item.sheet.id] ? structuredClone(this.index[item.sheet.id]) : null,
            },
        }));
    }

    async captureNewSheet(runId, id, scope) {
        if (!runId || !this.journal) return;
        await this.journal.capture(runId, `sheet:${id}`, async () => ({ kind: 'sheet', id, chatId: scope.chatId, before: null }));
    }

    /**
     * Volta as fichas tocadas por uma run ao estado anterior. Fichas de NPC guardadas num chat só
     * podem ser desfeitas com esse chat aberto.
     */
    undoEntries(entries, chatId) {
        return this.run(async () => {
            const scope = this.scope();
            const sameChat = !chatId || chatId === scope.chatId;
            let restored = 0;
            let skipped = 0;
            let chatSheets = scope.hasChat && sameChat ? { ...this.chatSheets(scope) } : null;
            let chatChanged = false;
            let indexChanged = false;

            for (const entry of [...entries].reverse()) {
                const touchesChat = entry.before === null ? Boolean(chatSheets?.[entry.id]) || !this.index[entry.id] : entry.before.location === 'chat';
                if (touchesChat && !chatSheets) {
                    skipped++;
                    continue;
                }
                // Remove a versão atual de onde quer que esteja.
                if (chatSheets?.[entry.id]) {
                    delete chatSheets[entry.id];
                    chatChanged = true;
                }
                if (this.index[entry.id]) {
                    delete this.index[entry.id];
                    indexChanged = true;
                    await this.storage.remove(SHEETS_TABLE, entry.id);
                    this.sheetCache.delete(entry.id);
                }
                // Recoloca a versão de antes (se existia).
                if (entry.before) {
                    const sheet = normalizeSheet(entry.before.sheet);
                    if (entry.before.location === 'chat') {
                        chatSheets[entry.id] = sheet;
                        chatChanged = true;
                    } else {
                        await this.storage.set(SHEETS_TABLE, entry.id, sheet);
                        this.sheetCache.set(entry.id, sheet);
                        if (entry.before.indexEntry) {
                            this.index[entry.id] = structuredClone(entry.before.indexEntry);
                            indexChanged = true;
                        }
                    }
                }
                restored++;
            }
            if (chatChanged) await this.writeChatSheets(scope, chatSheets);
            if (indexChanged) await this.saveIndex();
            if (restored) this.emit({ type: 'undo' });
            return { restored, skipped };
        });
    }

    /** Estado atual das fichas das entradas (para refazer ao voltar numa swipe). */
    snapshotEntries(entries) {
        return this.run(async () => {
            const scope = this.scope();
            const chatSheets = this.chatSheets(scope);
            const result = [];
            for (const entry of entries) {
                if (entry.kind !== 'sheet') continue;
                let before = null;
                if (chatSheets[entry.id]) {
                    before = { location: 'chat', sheet: structuredClone(chatSheets[entry.id]), indexEntry: null };
                } else if (this.index[entry.id]) {
                    const sheet = await this.loadStoredSheet(entry.id);
                    if (sheet) {
                        before = {
                            location: this.index[entry.id].scope?.type ?? 'stored',
                            sheet: structuredClone(sheet),
                            indexEntry: structuredClone(this.index[entry.id]),
                        };
                    }
                }
                result.push({ key: entry.key, kind: 'sheet', id: entry.id, chatId: scope.chatId, before });
            }
            return result;
        });
    }

    createSheet({ name, notes, attributes, skills, resources, stats, abilities, linkLorebook, runId } = {}) {
        return this.run(async () => {
            const scope = this.scope();
            const clean = String(name ?? '').normalize('NFC').trim();
            if (!clean) throw new Error('"name" is required.');
            const existing = await this.visibleSheets(scope);
            const clash = existing.find(item => normalizeName(item.sheet.name) === normalizeName(clean));
            if (clash) {
                throw new Error(`A sheet named "${clash.sheet.name}" already exists here. Use sheet_update to change it.`);
            }
            const sheet = this.newSheet({ name: clean.slice(0, MAX_NAME), kind: 'npc' });
            this.applyChanges(sheet, { notes, attributes, skills, resources, stats }, { creating: true });
            for (const input of Array.isArray(abilities) ? abilities.slice(0, MAX_ABILITIES) : []) {
                if (!input?.name || sheet.abilities.some(a => normalizeName(a.name) === normalizeName(input.name))) continue;
                sheet.abilities.push(this.buildAbility(null, input));
            }

            if (linkLorebook) {
                const link = await this.lore.describeEntry(linkLorebook.book, linkLorebook.uid);
                await this.captureNewSheet(runId, sheet.id, scope);
                sheet.link = { book: link.book, uid: link.uid, title: link.title };
                this.index[sheet.id] = { name: sheet.name, kind: 'npc', scope: { type: 'lore', book: link.book, uid: link.uid } };
                await this.saveIndex();
                await this.persist({ sheet, location: 'lorebook' }, scope);
                return this.toolView({ sheet, location: 'lorebook' });
            }
            if (!scope.hasChat) throw new Error('No chat is open. Open a chat, or link the sheet to a lorebook entry with link_lorebook.');
            await this.captureNewSheet(runId, sheet.id, scope);
            await this.persist({ sheet, location: 'chat' }, scope);
            return this.toolView({ sheet, location: 'chat' });
        });
    }

    updateSheet(reference, { linkLorebook, unlinkLorebook, runId, ...changes } = {}) {
        return this.run(async () => {
            const scope = this.scope();
            const item = await this.resolve(reference, scope);
            // Valida numa cópia antes de registrar e mexer de verdade.
            const draft = structuredClone(item.sheet);
            this.applyChanges(draft, changes);
            let link = null;
            if (linkLorebook) {
                if (item.sheet.kind === 'player') throw new Error('The player sheet cannot be linked to a lorebook.');
                link = await this.lore.describeEntry(linkLorebook.book, linkLorebook.uid);
            } else if (unlinkLorebook && item.location === 'lorebook' && !scope.hasChat) {
                throw new Error('Open a chat to move the sheet back into it.');
            }

            await this.captureSheet(runId, item, scope);
            Object.assign(item.sheet, draft);

            if (link) {
                item.sheet.link = { book: link.book, uid: link.uid, title: link.title };
                if (item.location === 'chat') {
                    const sheets = { ...this.chatSheets(scope) };
                    delete sheets[item.sheet.id];
                    await this.writeChatSheets(scope, sheets);
                }
                this.index[item.sheet.id] = { name: item.sheet.name, kind: 'npc', scope: { type: 'lore', book: link.book, uid: link.uid } };
                await this.saveIndex();
                item.location = 'lorebook';
            } else if (unlinkLorebook && item.location === 'lorebook') {
                delete this.index[item.sheet.id];
                await this.saveIndex();
                await this.storage.remove(SHEETS_TABLE, item.sheet.id);
                this.sheetCache.delete(item.sheet.id);
                item.sheet.link = null;
                item.location = 'chat';
            }

            await this.persist(item, scope);
            return this.toolView(item);
        });
    }

    adjustResource(reference, { resource, delta, set, runId } = {}) {
        return this.run(async () => {
            const scope = this.scope();
            const item = await this.resolve(reference, scope);
            const definition = this.requireItem(KINDS.resources, resource);
            const current = item.sheet.resources[definition.id] ?? { current: definition.defaultMax, max: definition.defaultMax };
            const before = current.current;
            let target;
            if (set !== undefined && set !== null) target = toInt(set, 'set', { min: -RESOURCE_RANGE.max, max: RESOURCE_RANGE.max });
            else if (delta !== undefined && delta !== null) target = before + toInt(delta, 'delta', { min: -RESOURCE_RANGE.max, max: RESOURCE_RANGE.max });
            else throw new Error('Pass "delta" (e.g. -5 for damage, 3 for healing) or "set".');

            await this.captureSheet(runId, item, scope);
            const value = { ...current, current: Math.max(0, Math.min(current.max, target)) };
            item.sheet.resources[definition.id] = value;
            await this.persist(item, scope);
            const result = { sheet: item.sheet.name, resource: definition.name, before, after: value.current, max: value.max };
            if (value.current === 0) result.note = `${definition.name} reached 0.`;
            if (target > value.max) result.note = `Capped at the max (${value.max}).`;
            return result;
        });
    }

    deleteSheet(reference, { runId } = {}) {
        return this.run(async () => {
            const scope = this.scope();
            const item = await this.resolve(reference, scope);
            if (item.location === 'player') throw new Error('The player sheet cannot be deleted.');
            await this.captureSheet(runId, item, scope);
            if (item.location === 'chat') {
                const sheets = { ...this.chatSheets(scope) };
                delete sheets[item.sheet.id];
                await this.writeChatSheets(scope, sheets);
            } else {
                delete this.index[item.sheet.id];
                await this.saveIndex();
                await this.storage.remove(SHEETS_TABLE, item.sheet.id);
                this.sheetCache.delete(item.sheet.id);
            }
            this.emit({ type: 'sheet', id: item.sheet.id });
            return { deleted: item.sheet.name };
        });
    }

    // ---------- testes ----------

    d20() {
        return this.die(20);
    }

    die(sides) {
        return Math.min(sides, Math.floor(this.random() * sides) + 1);
    }

    /** Estatística de defesa de uma ficha (a marcada como Defesa, ou a que se chama "Defesa"). */
    defenseOf(view, statName) {
        const stat = statName
            ? findByName(view.stats, statName)
            : view.stats.find(s => s.defense) ?? findByName(view.stats, 'Defesa');
        if (!stat) {
            throw new Error(statName
                ? `Unknown stat "${statName}" on ${view.name}. Stats: ${view.stats.map(s => s.name).join(', ') || 'none'}.`
                : `No defense stat in the rules; pass "dc" instead of a target.`);
        }
        return stat;
    }

    /**
     * Rola um teste de perícia, atributo ou estatística conforme o método de rolagem das regras,
     * contra uma CD ou contra a Defesa de outra ficha. Não grava nada.
     */
    async performCheck(view, { check, dc, against, againstStat, mode = 'normal', bonus = 0, extraDice = 0, scope }) {
        const wanted = String(check ?? '').normalize('NFC').trim();
        if (!wanted) throw new Error('"check" is required (a skill, attribute or stat name).');
        const skill = findByName(view.skills, wanted);
        const attribute = skill ? null : findByName(view.attributes, wanted);
        const stat = skill || attribute ? null : findByName(view.stats, wanted);
        if (!skill && !attribute && !stat) {
            const names = [...view.skills, ...view.attributes, ...view.stats].map(item => item.name).join(', ');
            throw new Error(`Unknown check "${wanted}". Use a skill, attribute or stat: ${names}.`);
        }
        const dice = this.definition.dice;
        const rollMode = ['advantage', 'disadvantage'].includes(mode) ? mode : 'normal';
        const situational = toInt(bonus ?? 0, 'bonus', BONUS_RANGE);
        const subject = skill ?? attribute ?? stat;
        const flat = skill ? skill.total : attribute ? attribute.rollBonus : stat.rollBonus;
        const allChecks = view.checkModifier ?? 0;
        const pool = rollPool(dice, subject.diceCount, {
            mode: rollMode,
            extraDice: toInt(extraDice ?? 0, 'extra_dice', { min: -10, max: 10 }),
            rollDie: sides => this.die(sides),
        });
        const total = pool.result + flat + allChecks + situational;

        let target = dc === undefined || dc === null || dc === '' ? null : toInt(dc, 'dc', { min: 0, max: 1000 });
        let defense = null;
        if (target === null && against) {
            const opponent = await this.resolve(against, scope);
            const opponentView = this.view(opponent);
            const defenseStat = this.defenseOf(opponentView, againstStat);
            target = defenseStat.total;
            defense = { sheet: opponentView.name, stat: defenseStat.name, value: defenseStat.total };
        }

        // De onde vem cada número somado (para a IA não precisar adivinhar).
        const parts = [];
        if (skill) {
            const attr = view.attributes.find(a => a.id === skill.attributeId);
            if (attr?.rollBonus) parts.push([attr.name, attr.rollBonus]);
            if (skill.trainingBonus) parts.push([`treino ${skill.trainingName}`, skill.trainingBonus]);
            if (skill.bonus) parts.push(['modificador extra', skill.bonus]);
            if (skill.itemBonus) parts.push(['itens', skill.itemBonus]);
            if (skill.conditionBonus) parts.push(['condições', skill.conditionBonus]);
        } else if (attribute) {
            const base = attribute.rollBonus - attribute.conditionBonus;
            if (base) parts.push([dice.attributeBonus === 'modifier' ? `modificador de ${attribute.name}` : attribute.name, base]);
            if (attribute.conditionBonus) parts.push(['condições', attribute.conditionBonus]);
        } else {
            const attr = view.attributes.find(a => a.id === stat.attributeId);
            if (stat.base) parts.push(['base', stat.base]);
            if (attr?.rollBonus) parts.push([attr.name, attr.rollBonus]);
            if (stat.bonus) parts.push(['bônus', stat.bonus]);
            if (stat.itemBonus) parts.push(['itens', stat.itemBonus]);
            if (stat.conditionBonus) parts.push(['condições', stat.conditionBonus]);
        }
        const counted = parts.reduce((sum, [, value]) => sum + value, 0);
        if (counted !== flat) parts.push(['outros', flat - counted]);
        if (allChecks) parts.push(['condições (todos os testes)', allChecks]);
        if (situational) parts.push(['situacional', situational]);

        const diceText = pool.keep === 'sum'
            ? `${pool.label} [${pool.rolls.join(' + ')}] = ${pool.result}`
            : pool.rolls.length === 1
                ? `${pool.label}: ${pool.result}`
                : `${pool.label} [${pool.rolls.join(', ')}] → fica ${pool.result}`;
        const math = diceText + parts.map(([label, value]) => ` ${value < 0 ? '-' : '+'} ${Math.abs(value)} (${label})`).join('') + ` = ${total}`;

        let natural = null;
        if (pool.keep !== 'sum' && dice.sides === 20) {
            if (pool.result === 20) natural = 20;
            if (pool.result === 1) natural = 1;
        }
        let outcome = null;
        let margin = null;
        if (target !== null) {
            margin = total - target;
            outcome = total >= target
                ? (natural === 20 ? 'CRITICAL SUCCESS' : 'SUCCESS')
                : (natural === 1 ? 'CRITICAL FAILURE' : 'FAILURE');
        }
        const versusEn = defense ? `${defense.stat} ${target} of ${defense.sheet}` : `DC ${target}`;
        const degree = margin === null ? '' : margin >= 10 ? ', a great success' : margin <= -10 ? ', a bad failure' : Math.abs(margin) <= 1 ? ', by a hair' : '';
        const readThis = outcome
            ? `${view.name} — ${subject.name}: ${outcome}${degree} (total ${total} vs ${versusEn}, margin ${formatModifier(margin)}). `
                + 'This result is final: narrate exactly this outcome. Do not reroll, change or recompute the numbers.'
            : `${view.name} — ${subject.name}: total ${total} (no DC given). Compare it with the difficulty you had in mind `
                + '(10 easy, 15 medium, 20 hard) and narrate; do not reroll.';

        const result = {
            read_this: readThis,
            outcome: outcome ?? 'NO DC',
            total,
        };
        if (target !== null) {
            result.dc = target;
            result.margin = margin;
            result.success = total >= target;
        }
        if (defense) result.against = defense;
        Object.assign(result, {
            sheet: view.name,
            check: subject.name,
            type: skill ? 'skill' : attribute ? 'attribute' : 'stat',
            mode: rollMode,
            math,
            dice: pool.label,
            rolls: pool.rolls,
            kept_die: pool.result,
            modifier: formatModifier(flat + allChecks),
        });
        if (dice.sides === 20 && pool.keep !== 'sum') result.d20 = pool.result;
        if (situational) result.situational_bonus = formatModifier(situational);
        if (natural) result.natural = natural;

        const versusPt = defense ? ` vs ${defense.stat} ${target} de ${defense.sheet}` : target !== null ? ` vs CD ${target}` : '';
        result.summary = `${subject.name} de ${view.name}: ${math}${versusPt}`
            + (outcome ? ` → ${OUTCOME_PT[outcome]} (margem ${formatModifier(margin)})` : '')
            + (natural === 20 ? ' (20 natural!)' : natural === 1 ? ' (1 natural!)' : '');
        return result;
    }

    roll(reference, { check, dc, against, againstStat, mode = 'normal', bonus = 0, extraDice = 0, reason } = {}) {
        return this.run(async () => {
            const scope = this.scope();
            const item = await this.resolve(reference, scope);
            const result = await this.performCheck(this.view(item), { check, dc, against, againstStat, mode, bonus, extraDice, scope });
            if (reason) result.reason = String(reason).slice(0, 200);
            this.emit({ type: 'roll', result });
            return result;
        });
    }

    // ---------- condições ----------

    /** Acha o alvo de uma condição: "todos os testes", ou uma perícia, atributo ou estatística. */
    conditionTarget(reference) {
        const raw = String(reference ?? '').normalize('NFC').trim();
        if (!raw) return null;
        if (ALL_CHECKS.has(normalizeName(raw))) return 'checks';
        const definition = this.definition;
        const found = findByName(definition.skills, raw) ?? findByName(definition.attributes, raw) ?? findByName(definition.stats, raw);
        if (!found) {
            const names = [...definition.skills, ...definition.attributes, ...definition.stats].map(item => item.name).join(', ');
            throw new Error(`Unknown condition target "${raw}". Use "checks" (all checks) or a skill, attribute or stat: ${names}.`);
        }
        return found.id;
    }

    /** Adiciona/atualiza, remove ou limpa condições (Envenenado, Atordoado, Abençoado...). */
    condition(reference, { action = 'add', name, description, target, value, rounds, runId } = {}) {
        return this.run(async () => {
            const scope = this.scope();
            const item = await this.resolve(reference, scope);
            const list = item.sheet.conditions ?? [];
            const act = ['add', 'remove', 'clear'].includes(action) ? action : 'add';
            if (act === 'clear') {
                await this.captureSheet(runId, item, scope);
                item.sheet.conditions = [];
                await this.persist(item, scope);
                return { sheet: item.sheet.name, removed: list.map(c => c.name), conditions: [] };
            }
            const clean = String(name ?? '').normalize('NFC').trim();
            if (!clean) throw new Error('"name" is required (e.g. "Envenenado").');
            const existing = findByName(list, clean);
            if (act === 'remove') {
                if (!existing) {
                    throw new Error(`${item.sheet.name} has no condition "${clean}". Conditions: ${list.map(c => c.name).join(', ') || 'none'}.`);
                }
                await this.captureSheet(runId, item, scope);
                item.sheet.conditions = list.filter(c => c !== existing);
            } else {
                if (!existing && list.length >= MAX_CONDITIONS) throw new Error(`Too many conditions (max ${MAX_CONDITIONS}).`);
                const targetId = target === undefined || target === null || target === '' ? existing?.target ?? null : this.conditionTarget(target);
                const amount = value === undefined || value === null || value === '' ? existing?.value ?? 0 : toInt(value, 'value', BONUS_RANGE);
                if (amount && !targetId) throw new Error('A condition with a "value" needs a "target" ("checks" or a skill/attribute/stat).');
                const entry = normalizeCondition({
                    id: existing?.id,
                    name: clean,
                    description: description ?? existing?.description ?? '',
                    target: targetId,
                    value: amount,
                    rounds: rounds === undefined ? existing?.rounds ?? null : rounds === null || rounds === '' ? null : toInt(rounds, 'rounds', { min: 0, max: 1000 }),
                });
                await this.captureSheet(runId, item, scope);
                item.sheet.conditions = existing ? list.map(c => (c === existing ? entry : c)) : [...list, entry];
            }
            await this.persist(item, scope);
            const view = this.view(item);
            return {
                sheet: view.name,
                [act === 'remove' ? 'removed' : existing ? 'updated' : 'added']: act === 'remove' ? existing.name : clean,
                conditions: view.conditions.map(conditionToolView),
            };
        });
    }

    /**
     * Passa uma rodada para estas fichas: condições com duração perdem 1 rodada e as que chegam a 0 acabam.
     * Devolve as condições que acabaram.
     */
    tickConditions(sheetIds, { runId } = {}) {
        return this.run(async () => {
            const scope = this.scope();
            const expired = [];
            for (const id of new Set(sheetIds)) {
                let item;
                try { item = await this.resolve(id, scope); } catch { continue; }
                const list = item.sheet.conditions ?? [];
                if (!list.some(c => c.rounds)) continue;
                await this.captureSheet(runId, item, scope);
                const next = [];
                for (const condition of list) {
                    if (!condition.rounds) next.push(condition);
                    else if (condition.rounds > 1) next.push({ ...condition, rounds: condition.rounds - 1 });
                    else expired.push({ sheet: item.sheet.name, condition: condition.name });
                }
                item.sheet.conditions = next;
                await this.persist(item, scope);
            }
            this.emit({ type: 'sheet' });
            return expired;
        });
    }

    // ---------- itens ----------

    /** Monta/valida um item a partir do que veio da IA ou da interface. */
    buildItem(base, input) {
        const entry = normalizeItem(base ?? {});
        if (input.name !== undefined && input.name !== null) {
            const name = String(input.name).normalize('NFC').trim();
            if (!name) throw new Error('Item name cannot be empty.');
            entry.name = name.slice(0, MAX_NAME);
        }
        if (input.description !== undefined && input.description !== null) {
            entry.description = String(input.description).normalize('NFC').slice(0, MAX_DESCRIPTION);
        }
        if (input.quantity !== undefined && input.quantity !== null && input.quantity !== '') {
            entry.quantity = toInt(input.quantity, 'quantity', { min: 0, max: 1_000_000 });
        }
        if (input.slot !== undefined) {
            const wanted = input.slot === null ? '' : normalizeName(input.slot);
            if (!wanted || ['mochila', 'backpack', 'bag', 'inventario', 'inventory', 'none', 'nenhum', 'bolsa'].includes(wanted)) {
                entry.slot = null;
            } else {
                entry.slot = this.requireItem(KINDS.slots, input.slot).id;
            }
        }
        if (input.bonusTarget !== undefined || input.bonusValue !== undefined) {
            const value = input.bonusValue === undefined || input.bonusValue === null || input.bonusValue === ''
                ? (entry.bonus?.value ?? 0)
                : toInt(input.bonusValue, 'bonus_value', BONUS_RANGE);
            const targetRef = input.bonusTarget === undefined ? entry.bonus?.target : input.bonusTarget;
            if (!value || !targetRef) {
                entry.bonus = null;
            } else {
                const target = findByName(this.definition.stats, targetRef) ?? findByName(this.definition.skills, targetRef);
                if (!target) {
                    const names = [...this.definition.stats, ...this.definition.skills].map(item => item.name).join(', ');
                    throw new Error(`Item bonuses can target a stat or skill: ${names}. Unknown: "${targetRef}".`);
                }
                entry.bonus = { target: target.id, value };
            }
        }
        return entry;
    }

    /**
     * Cria, edita ou remove um item de uma ficha. `slot` equipa numa parte do corpo (ou "mochila");
     * `quantityDelta` soma/subtrai (chegando a 0, o item some).
     * @param {'add'|'update'|'remove'} action
     */
    editItem(reference, { action = 'add', item: itemRef, quantityDelta, runId, ...input } = {}) {
        return this.run(async () => {
            const scope = this.scope();
            const sheetItem = await this.resolve(reference, scope);
            const items = sheetItem.sheet.items ?? [];
            const op = ['add', 'update', 'remove'].includes(action) ? action : 'add';
            const finish = async nextItems => {
                await this.captureSheet(runId, sheetItem, scope);
                sheetItem.sheet.items = nextItems;
                await this.persist(sheetItem, scope);
            };
            const describeEntry = id => {
                const viewItem = this.view(sheetItem).items.find(entry => entry.id === id);
                return viewItem ? { ...itemToolView(viewItem), location: viewItem.slotName ?? 'backpack' } : null;
            };

            if (op === 'add') {
                if (!input.name) throw new Error('"name" is required to add an item.');
                // Mesmo nome, mesmo lugar e sem bônus diferente: soma a quantidade (ex.: poções).
                const entry = this.buildItem(null, { quantity: 1, ...input });
                const stack = items.find(existing => normalizeName(existing.name) === normalizeName(entry.name)
                    && existing.slot === entry.slot && JSON.stringify(existing.bonus) === JSON.stringify(entry.bonus));
                if (stack) {
                    const merged = { ...stack, quantity: stack.quantity + entry.quantity };
                    await finish(items.map(existing => (existing.id === stack.id ? merged : existing)));
                    return { sheet: sheetItem.sheet.name, action: 'stacked', item: describeEntry(stack.id) };
                }
                if (items.length >= MAX_ITEMS) throw new Error(`A sheet can have at most ${MAX_ITEMS} items.`);
                await finish([...items, entry]);
                return { sheet: sheetItem.sheet.name, action: 'added', item: describeEntry(entry.id) };
            }

            const current = findByName(items, itemRef ?? input.name);
            if (!current) {
                throw new Error(`Item "${itemRef ?? input.name}" not found on ${sheetItem.sheet.name}. Items: ${items.map(entry => entry.name).join(', ') || 'none'}.`);
            }
            if (op === 'remove') {
                await finish(items.filter(entry => entry.id !== current.id));
                return { sheet: sheetItem.sheet.name, action: 'removed', item: current.name };
            }
            const updated = this.buildItem(current, input);
            if (quantityDelta !== undefined && quantityDelta !== null && quantityDelta !== '') {
                updated.quantity = Math.max(0, updated.quantity + toInt(quantityDelta, 'quantity_delta', { min: -1_000_000, max: 1_000_000 }));
            }
            if (updated.quantity === 0) {
                await finish(items.filter(entry => entry.id !== current.id));
                return { sheet: sheetItem.sheet.name, action: 'used_up', item: current.name };
            }
            await finish(items.map(entry => (entry.id === current.id ? updated : entry)));
            return { sheet: sheetItem.sheet.name, action: 'updated', item: describeEntry(updated.id) };
        });
    }

    // ---------- habilidades ----------

    /** Monta/valida os dados de uma habilidade a partir do que veio da IA ou da interface. */
    buildAbility(base, input) {
        const ability = normalizeAbility(base ?? {});
        if (input.name !== undefined && input.name !== null) {
            const name = String(input.name).normalize('NFC').trim();
            if (!name) throw new Error('Ability name cannot be empty.');
            ability.name = name.slice(0, MAX_NAME);
        }
        if (input.description !== undefined && input.description !== null) {
            ability.description = String(input.description).normalize('NFC').slice(0, MAX_DESCRIPTION);
        }
        if (input.effect !== undefined && input.effect !== null) {
            ability.effect = String(input.effect).normalize('NFC').slice(0, MAX_EFFECT);
        }
        if (input.check !== undefined) {
            if (input.check === null || input.check === '' || normalizeName(input.check) === 'none' || normalizeName(input.check) === 'nenhum') {
                ability.check = null;
            } else {
                const found = findByName(this.definition.skills, input.check)
                    ?? findByName(this.definition.attributes, input.check)
                    ?? findByName(this.definition.stats, input.check);
                if (!found) {
                    const names = [...this.definition.skills, ...this.definition.attributes].map(item => item.name).join(', ');
                    throw new Error(`Unknown check "${input.check}". Use a skill or attribute: ${names}.`);
                }
                ability.check = found.id;
            }
        }
        if (input.cost !== undefined || input.costResource !== undefined) {
            const amount = input.cost === undefined || input.cost === null || input.cost === ''
                ? (ability.cost?.amount ?? 0)
                : toInt(input.cost, 'cost', { min: 0, max: RESOURCE_RANGE.max });
            if (!amount) {
                ability.cost = null;
            } else {
                const resourceRef = input.costResource ?? ability.cost?.resource ?? this.definition.resources.find(r => r.id === 'mana')?.id ?? this.definition.resources[0]?.id;
                const resource = this.requireItem(KINDS.resources, resourceRef);
                ability.cost = { amount, resource: resource.id };
            }
        }
        for (const change of toChangeList(input.fields)) {
            const field = this.requireItem(KINDS.abilityFields, change.name ?? change.id);
            const value = change.value ?? '';
            ability.fields[field.id] = String(value).normalize('NFC').slice(0, MAX_FIELD_VALUE);
        }
        return ability;
    }

    /**
     * Cria, edita ou remove uma habilidade de uma ficha.
     * @param {'add'|'update'|'remove'} action
     */
    editAbility(reference, { action = 'add', ability: abilityRef, runId, ...input } = {}) {
        return this.run(async () => {
            const scope = this.scope();
            const item = await this.resolve(reference, scope);
            const abilities = item.sheet.abilities ?? [];
            const op = ['add', 'update', 'remove'].includes(action) ? action : 'add';

            if (op === 'add') {
                if (!input.name) throw new Error('"name" is required to add an ability.');
                if (abilities.length >= MAX_ABILITIES) throw new Error(`A sheet can have at most ${MAX_ABILITIES} abilities.`);
                const clash = abilities.find(a => normalizeName(a.name) === normalizeName(input.name));
                if (clash) throw new Error(`${item.sheet.name} already has "${clash.name}". Use action "update" to change it.`);
                const ability = this.buildAbility(null, input);
                await this.captureSheet(runId, item, scope);
                item.sheet.abilities = [...abilities, ability];
                await this.persist(item, scope);
                return { sheet: item.sheet.name, action: 'added', ability: abilityToolView(this.view(item).abilities.find(a => a.id === ability.id)) };
            }

            const current = findByName(abilities, abilityRef ?? input.name);
            if (!current) {
                throw new Error(`Ability "${abilityRef ?? input.name}" not found on ${item.sheet.name}. Abilities: ${abilities.map(a => a.name).join(', ') || 'none'}.`);
            }
            await this.captureSheet(runId, item, scope);
            if (op === 'remove') {
                item.sheet.abilities = abilities.filter(a => a.id !== current.id);
                await this.persist(item, scope);
                return { sheet: item.sheet.name, action: 'removed', ability: current.name };
            }
            const updated = this.buildAbility(current, input);
            item.sheet.abilities = abilities.map(a => (a.id === current.id ? updated : a));
            await this.persist(item, scope);
            return { sheet: item.sheet.name, action: 'updated', ability: abilityToolView(this.view(item).abilities.find(a => a.id === updated.id)) };
        });
    }

    /**
     * Usa uma habilidade: gasta o custo, rola o teste (contra uma CD ou a Defesa do alvo) e o efeito.
     * Com apply 'damage', o efeito rolado sai de um recurso do alvo (Vida, por padrão) se acertar;
     * com 'heal', soma no alvo (ou no próprio personagem, sem alvo).
     */
    useAbility(reference, { ability: abilityRef, target, dc, mode = 'normal', bonus = 0, apply = 'none', resource: applyResource, runId } = {}) {
        return this.run(async () => {
            const scope = this.scope();
            const item = await this.resolve(reference, scope);
            const view = this.view(item);
            const ability = findByName(view.abilities, abilityRef);
            if (!ability) {
                throw new Error(`Ability "${abilityRef}" not found on ${view.name}. Abilities: ${view.abilities.map(a => a.name).join(', ') || 'none'}.`);
            }
            const result = { sheet: view.name, ability: ability.name };
            const summary = [`${ability.name} (${view.name}${target ? ` → ${target}` : ''})`];

            // 1) Custo.
            if (ability.cost) {
                const resource = item.sheet.resources[ability.cost.resourceId] ?? view.resources.find(r => r.id === ability.cost.resourceId);
                const available = resource?.current ?? 0;
                if (available < ability.cost.amount) {
                    throw new Error(`Not enough ${ability.cost.resource}: ${view.name} has ${available}, "${ability.name}" costs ${ability.cost.amount}.`);
                }
            }
            // 2) Teste (antes de gastar, para não gastar se o alvo não existir).
            let check = null;
            if (ability.check) {
                check = await this.performCheck(view, { check: ability.check, dc, against: target, mode, bonus, scope });
                result.check = check;
            }
            // 3) Efeito.
            const hit = !check || check.success !== false;
            const effectRoll = ability.effect ? rollExpression(ability.effect, view, sides => this.die(sides)) : null;
            if (effectRoll) result.effect = { expression: ability.effect, total: effectRoll.total, detail: effectRoll.detail };
            else if (ability.effect) result.effect = { text: ability.effect };

            await this.captureSheet(runId, item, scope);
            if (ability.cost) {
                const definition = this.definition.resources.find(r => r.id === ability.cost.resourceId);
                const value = item.sheet.resources[ability.cost.resourceId] ?? { current: definition?.defaultMax ?? 0, max: definition?.defaultMax ?? 0 };
                const before = value.current;
                item.sheet.resources[ability.cost.resourceId] = { ...value, current: Math.max(0, before - ability.cost.amount) };
                result.cost = { resource: ability.cost.resource, before, after: before - ability.cost.amount };
                summary.push(`-${ability.cost.amount} ${ability.cost.resource}`);
            }
            await this.persist(item, scope);
            if (check) summary.push(check.summary.replace(`${check.check} de ${view.name}: `, `${check.check}: `));
            if (result.effect?.detail) summary.push(`efeito ${result.effect.detail}`);

            // 4) Efeito aplicado: dano no alvo, ou cura no alvo (sem alvo, cura o próprio personagem).
            const applyMode = apply === 'damage' || apply === 'heal' ? apply : 'none';
            const recipientRef = target ?? (applyMode === 'heal' ? item.sheet.id : null);
            if (applyMode !== 'none' && recipientRef && effectRoll && hit) {
                const recipient = await this.resolve(recipientRef, scope);
                const resourceDefinition = applyResource
                    ? this.requireItem(KINDS.resources, applyResource)
                    : this.definition.resources[0];
                if (resourceDefinition) {
                    await this.captureSheet(runId, recipient, scope);
                    const value = recipient.sheet.resources[resourceDefinition.id] ?? { current: resourceDefinition.defaultMax, max: resourceDefinition.defaultMax };
                    const before = value.current;
                    const after = applyMode === 'damage'
                        ? Math.max(0, before - effectRoll.total)
                        : Math.min(value.max, before + effectRoll.total);
                    recipient.sheet.resources[resourceDefinition.id] = { ...value, current: after };
                    await this.persist(recipient, scope);
                    result.applied = { type: applyMode, sheet: recipient.sheet.name, resource: resourceDefinition.name, before, after, max: value.max };
                    summary.push(`${resourceDefinition.name} de ${recipient.sheet.name} ${before} → ${after}`);
                    if (after === 0) result.applied.note = `${resourceDefinition.name} reached 0.`;
                }
            } else if (applyMode !== 'none' && check && !hit) {
                result.applied = { note: 'Missed: nothing applied.' };
            }
            result.hit = hit;
            result.summary = summary.join('; ');
            const story = [`${ability.name} used by ${view.name}${target ? ` on ${target}` : ''}`];
            if (result.cost) story.push(`paid ${ability.cost.amount} ${ability.cost.resource} (${result.cost.before} → ${Math.max(0, result.cost.after)})`);
            if (check) story.push(`${hit ? 'HIT' : 'MISS'}: ${check.outcome} (total ${check.total} vs ${check.against ? `${check.against.stat} ${check.dc}` : `DC ${check.dc ?? '-'}`})`);
            if (result.effect?.total !== undefined) story.push(`effect ${result.effect.expression} rolled ${result.effect.total}`);
            else if (result.effect?.text) story.push(`effect: ${result.effect.text}`);
            if (result.applied?.type) {
                story.push(`${result.applied.type === 'damage' ? 'damage' : 'healing'} applied: ${result.applied.resource} of ${result.applied.sheet} ${result.applied.before} → ${result.applied.after}/${result.applied.max}${result.applied.after === 0 ? ' (reached 0!)' : ''}`);
            } else if (check && !hit) {
                story.push('nothing applied');
            }
            result.read_this = `${story.join('; ')}. The sheets are already updated: narrate exactly this and do not apply it again.`;
            this.emit({ type: 'roll', result });
            return result;
        });
    }
}
