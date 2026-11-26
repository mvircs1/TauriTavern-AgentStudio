// Sistema de RPG simples (sem nível/XP): atributos, perícias ligadas a atributos e recursos
// (Vida, Mana...). Modificador no estilo D&D: floor((valor - 10) / 2).
//
// Onde cada coisa fica:
// - Regras (o "sistema"): globais, no armazenamento do plugin (meta/system).
// - Ficha do jogador: uma por personagem (card) ou por grupo, no armazenamento do plugin.
// - Fichas de NPC: no chat (chat_metadata.agent_studio.sheets), então acompanham branches e exportações.
// - Fichas de NPC vinculadas a uma entrada de lorebook: no armazenamento do plugin, visíveis
//   em todo chat onde aquele lorebook estiver ativo.

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
});

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
});

export const RULES_TEXT = 'Modifier = floor((score - 10) / 2): 8-9 = -1, 10-11 = +0, 12-13 = +1, 14-15 = +2, 16-17 = +3, 18-19 = +4, 20 = +5. '
    + 'Skill total = modifier of its attribute + the skill bonus. '
    + 'Stats (like Defesa/Defense, Iniciativa) = base + modifier of their attribute + the sheet bonus (armor, items). '
    + 'A check is d20 + total (+ situational bonus) against a difficulty class (DC): 5 very easy, 10 easy, 15 medium, 20 hard, 25 very hard, 30 nearly impossible. '
    + 'An attack is a check against the target\'s defense stat (system_roll or ability_use with "against"/"target"). '
    + 'Abilities (spells, powers, techniques) live on each sheet: cost (e.g. 3 Mana), check used to hit, effect (dice like "2d6+FOR" or text) and extra fields. '
    + 'There are no levels or XP.';

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
    };
}

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
        abilities: Array.isArray(sheet.abilities) ? sheet.abilities.map(normalizeAbility) : [],
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
        const value = attribute?.modifier ?? skill?.total ?? stat?.total;
        if (value === undefined) return null;
        total += sign * value;
        parts.push(`${sign < 0 ? '-' : parts.length ? '+' : ''}${term} (${formatModifier(value)})`);
    }
    if (!hasDice && terms.length === 1 && !/^\d+$/.test(terms[0].replace(/^[+-]/, ''))) return null;
    return { total: Math.max(0, total), detail: `${parts.join(' ')} = ${Math.max(0, total)}` };
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
        const label = { attributes: 'attribute', skills: 'skill', resources: 'resource', stats: 'stat', abilityFields: 'ability field' }[kind];
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
            abilities: [],
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
        const sheet = item.sheet;
        const attributes = definition.attributes.map(attribute => {
            const score = Number.isFinite(sheet.attributes[attribute.id]) ? sheet.attributes[attribute.id] : definition.defaultScore;
            return { id: attribute.id, name: attribute.name, score, modifier: modifier(score) };
        });
        const byId = new Map(attributes.map(attribute => [attribute.id, attribute]));
        const skills = definition.skills.map(skill => {
            const bonus = Number.isFinite(sheet.skills[skill.id]) ? sheet.skills[skill.id] : 0;
            const attribute = byId.get(skill.attribute) ?? null;
            return { id: skill.id, name: skill.name, attribute: attribute?.name ?? null, attributeId: attribute?.id ?? null, bonus, total: (attribute?.modifier ?? 0) + bonus };
        });
        const resources = definition.resources.map(resource => {
            const value = sheet.resources[resource.id] ?? { current: resource.defaultMax, max: resource.defaultMax };
            return { id: resource.id, name: resource.name, current: value.current, max: value.max };
        });
        const stats = definition.stats.map(stat => {
            const bonus = Number.isFinite(sheet.stats?.[stat.id]) ? sheet.stats[stat.id] : 0;
            const attribute = byId.get(stat.attribute) ?? null;
            return {
                id: stat.id,
                name: stat.name,
                base: stat.base,
                attribute: attribute?.name ?? null,
                attributeId: attribute?.id ?? null,
                bonus,
                total: stat.base + (attribute?.modifier ?? 0) + bonus,
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
        return {
            id: sheet.id,
            name: sheet.name,
            kind: sheet.kind,
            location: item.location,
            link: sheet.link,
            notes: sheet.notes,
            attributes,
            skills,
            resources,
            stats,
            abilities,
            updatedAt: sheet.updatedAt,
        };
    }

    toolView(item) {
        const view = this.view(item);
        const result = {
            id: view.id,
            name: view.name,
            kind: view.kind,
            location: view.location,
            resources: view.resources.map(r => ({ name: r.name, current: r.current, max: r.max })),
            stats: view.stats.map(s => {
                const stat = { name: s.name, total: s.total, bonus: s.bonus };
                if (s.defense) stat.is_defense = true;
                return stat;
            }),
            attributes: view.attributes.map(a => ({ name: a.name, score: a.score, mod: formatModifier(a.modifier) })),
            skills: view.skills.map(s => ({ name: s.name, attribute: s.attribute, bonus: s.bonus, total: formatModifier(s.total) })),
            abilities: view.abilities.map(abilityToolView),
        };
        if (view.link) result.linked_lorebook_entry = view.link;
        if (view.notes) result.notes = view.notes;
        return result;
    }

    systemInfo({ section = 'all' } = {}) {
        return this.run(() => {
            const wants = part => !section || section === 'all' || section === part;
            const result = {};
            if (wants('rules')) {
                result.rules = RULES_TEXT;
                result.default_score = this.definition.defaultScore;
            }
            if (wants('attributes')) {
                result.attributes = this.definition.attributes.map(a => ({ name: a.name, description: a.description }));
            }
            if (wants('skills')) {
                result.skills = this.definition.skills.map(s => ({
                    name: s.name,
                    attribute: this.definition.attributes.find(a => a.id === s.attribute)?.name ?? null,
                    description: s.description,
                }));
            }
            if (wants('resources')) {
                result.resources = this.definition.resources.map(r => ({ name: r.name, description: r.description, default_max: r.defaultMax }));
            }
            if (wants('stats')) {
                result.stats = this.definition.stats.map(s => {
                    const stat = {
                        name: s.name,
                        formula: `${s.base}${s.attribute ? ` + ${this.definition.attributes.find(a => a.id === s.attribute)?.name ?? '?'} modifier` : ''} + sheet bonus`,
                        description: s.description,
                    };
                    if (s.defense) stat.is_defense = true;
                    return stat;
                });
            }
            if (wants('abilities')) {
                result.ability_fields = this.definition.abilityFields.map(f => ({ name: f.name, description: f.description }));
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
            sheet.skills[skill.id] = toInt(change.bonus ?? change.value, `${skill.name} bonus`, BONUS_RANGE);
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
     * Rola d20 + modificador de uma perícia, atributo ou estatística, contra uma CD ou contra a Defesa
     * de outra ficha. Não grava nada.
     */
    async performCheck(view, { check, dc, against, againstStat, mode = 'normal', bonus = 0, scope }) {
        const wanted = String(check ?? '').normalize('NFC').trim();
        if (!wanted) throw new Error('"check" is required (a skill, attribute or stat name).');
        const skill = findByName(view.skills, wanted);
        const attribute = skill ? null : findByName(view.attributes, wanted);
        const stat = skill || attribute ? null : findByName(view.stats, wanted);
        if (!skill && !attribute && !stat) {
            const names = [...view.skills, ...view.attributes, ...view.stats].map(item => item.name).join(', ');
            throw new Error(`Unknown check "${wanted}". Use a skill, attribute or stat: ${names}.`);
        }
        const rollMode = ['advantage', 'disadvantage'].includes(mode) ? mode : 'normal';
        const situational = toInt(bonus ?? 0, 'bonus', BONUS_RANGE);
        const mod = skill ? skill.total : attribute ? attribute.modifier : stat.total;
        const rolls = rollMode === 'normal' ? [this.d20()] : [this.d20(), this.d20()];
        const kept = rollMode === 'advantage' ? Math.max(...rolls) : rollMode === 'disadvantage' ? Math.min(...rolls) : rolls[0];
        const total = kept + mod + situational;

        let target = dc === undefined || dc === null || dc === '' ? null : toInt(dc, 'dc', { min: 0, max: 100 });
        let defense = null;
        if (target === null && against) {
            const opponent = await this.resolve(against, scope);
            const opponentView = this.view(opponent);
            const defenseStat = this.defenseOf(opponentView, againstStat);
            target = defenseStat.total;
            defense = { sheet: opponentView.name, stat: defenseStat.name, value: defenseStat.total };
        }

        const result = {
            sheet: view.name,
            check: (skill ?? attribute ?? stat).name,
            type: skill ? 'skill' : attribute ? 'attribute' : 'stat',
            mode: rollMode,
            rolls,
            d20: kept,
            modifier: formatModifier(mod),
            total,
        };
        if (situational) result.situational_bonus = formatModifier(situational);
        if (target !== null) {
            result.dc = target;
            result.success = total >= target;
        }
        if (defense) result.against = defense;
        if (kept === 20) result.natural = 20;
        if (kept === 1) result.natural = 1;

        const parts = [`d20 ${kept}${rolls.length > 1 ? ` (${rolls.join(' / ')})` : ''}`, formatModifier(mod)];
        if (situational) parts.push(formatModifier(situational));
        const versus = defense ? ` vs ${defense.stat} ${target} de ${defense.sheet}` : target !== null ? ` vs CD ${target}` : '';
        result.summary = `${result.check} de ${view.name}: ${parts.join(' ')} = ${total}`
            + (target !== null ? `${versus}: ${result.success ? 'sucesso' : 'falha'}` : '')
            + (result.natural === 20 ? ' (20 natural!)' : result.natural === 1 ? ' (1 natural!)' : '');
        return result;
    }

    roll(reference, { check, dc, against, againstStat, mode = 'normal', bonus = 0, reason } = {}) {
        return this.run(async () => {
            const scope = this.scope();
            const item = await this.resolve(reference, scope);
            const result = await this.performCheck(this.view(item), { check, dc, against, againstStat, mode, bonus, scope });
            if (reason) result.reason = String(reason).slice(0, 200);
            this.emit({ type: 'roll', result });
            return result;
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
            this.emit({ type: 'roll', result });
            return result;
        });
    }
}
