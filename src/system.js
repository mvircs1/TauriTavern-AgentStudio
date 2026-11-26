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

export const KINDS = Object.freeze({ attributes: 'attributes', skills: 'skills', resources: 'resources' });

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
});

export const RULES_TEXT = 'Modifier = floor((score - 10) / 2): 8-9 = -1, 10-11 = +0, 12-13 = +1, 14-15 = +2, 16-17 = +3, 18-19 = +4, 20 = +5. '
    + 'Skill total = modifier of its attribute + the skill bonus. '
    + 'A check is d20 + total (+ situational bonus) against a difficulty class (DC): 5 very easy, 10 easy, 15 medium, 20 hard, 25 very hard, 30 nearly impossible. '
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
        link: sheet.link && typeof sheet.link.book === 'string' ? { ...sheet.link } : null,
        updatedAt: sheet.updatedAt ?? null,
    };
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
        const list = this.definition[kind];
        const raw = String(reference ?? '').trim();
        return list.find(item => item.id === raw) ?? list.find(item => normalizeName(item.name) === normalizeName(raw)) ?? null;
    }

    requireItem(kind, reference) {
        const item = this.findItem(kind, reference);
        if (item) return item;
        const label = { attributes: 'attribute', skills: 'skill', resources: 'resource' }[kind];
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
            attributes: view.attributes.map(a => ({ name: a.name, score: a.score, mod: formatModifier(a.modifier) })),
            skills: view.skills.map(s => ({ name: s.name, attribute: s.attribute, bonus: s.bonus, total: formatModifier(s.total) })),
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

    applyChanges(sheet, { name, notes, attributes, skills, resources } = {}) {
        if (name !== undefined) {
            const clean = String(name).trim();
            if (!clean) throw new Error('Sheet name cannot be empty.');
            sheet.name = clean.slice(0, MAX_NAME);
        }
        if (notes !== undefined) sheet.notes = String(notes).slice(0, MAX_NOTES);
        for (const change of attributes ?? []) {
            const attribute = this.requireItem(KINDS.attributes, change?.name ?? change?.id);
            sheet.attributes[attribute.id] = toInt(change.score, `${attribute.name} score`, SCORE_RANGE);
        }
        for (const change of skills ?? []) {
            const skill = this.requireItem(KINDS.skills, change?.name ?? change?.id);
            sheet.skills[skill.id] = toInt(change.bonus, `${skill.name} bonus`, BONUS_RANGE);
        }
        for (const change of resources ?? []) {
            const resource = this.requireItem(KINDS.resources, change?.name ?? change?.id);
            const value = sheet.resources[resource.id] ?? { current: resource.defaultMax, max: resource.defaultMax };
            if (change.max !== undefined && change.max !== null) value.max = toInt(change.max, `${resource.name} max`, RESOURCE_RANGE);
            if (change.current !== undefined && change.current !== null) value.current = toInt(change.current, `${resource.name} current`, RESOURCE_RANGE);
            value.current = Math.min(value.current, value.max);
            sheet.resources[resource.id] = value;
        }
    }

    createSheet({ name, notes, attributes, skills, resources, linkLorebook } = {}) {
        return this.run(async () => {
            const scope = this.scope();
            const clean = String(name ?? '').trim();
            if (!clean) throw new Error('"name" is required.');
            const existing = await this.visibleSheets(scope);
            if (existing.some(item => normalizeName(item.sheet.name) === normalizeName(clean))) {
                throw new Error(`A sheet named "${clean}" already exists here. Use sheet_update to change it.`);
            }
            const sheet = this.newSheet({ name: clean.slice(0, MAX_NAME), kind: 'npc' });
            this.applyChanges(sheet, { notes, attributes, skills, resources });

            if (linkLorebook) {
                const link = await this.lore.describeEntry(linkLorebook.book, linkLorebook.uid);
                sheet.link = { book: link.book, uid: link.uid, title: link.title };
                this.index[sheet.id] = { name: sheet.name, kind: 'npc', scope: { type: 'lore', book: link.book, uid: link.uid } };
                await this.saveIndex();
                await this.persist({ sheet, location: 'lorebook' }, scope);
                return this.toolView({ sheet, location: 'lorebook' });
            }
            if (!scope.hasChat) throw new Error('No chat is open. Open a chat, or link the sheet to a lorebook entry with link_lorebook.');
            await this.persist({ sheet, location: 'chat' }, scope);
            return this.toolView({ sheet, location: 'chat' });
        });
    }

    updateSheet(reference, { linkLorebook, unlinkLorebook, ...changes } = {}) {
        return this.run(async () => {
            const scope = this.scope();
            const item = await this.resolve(reference, scope);
            this.applyChanges(item.sheet, changes);

            if (linkLorebook) {
                if (item.sheet.kind === 'player') throw new Error('The player sheet cannot be linked to a lorebook.');
                const link = await this.lore.describeEntry(linkLorebook.book, linkLorebook.uid);
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
                if (!scope.hasChat) throw new Error('Open a chat to move the sheet back into it.');
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

    adjustResource(reference, { resource, delta, set } = {}) {
        return this.run(async () => {
            const scope = this.scope();
            const item = await this.resolve(reference, scope);
            const definition = this.requireItem(KINDS.resources, resource);
            const value = item.sheet.resources[definition.id] ?? { current: definition.defaultMax, max: definition.defaultMax };
            const before = value.current;
            let target;
            if (set !== undefined && set !== null) target = toInt(set, 'set', { min: -RESOURCE_RANGE.max, max: RESOURCE_RANGE.max });
            else if (delta !== undefined && delta !== null) target = before + toInt(delta, 'delta', { min: -RESOURCE_RANGE.max, max: RESOURCE_RANGE.max });
            else throw new Error('Pass "delta" (e.g. -5 for damage, 3 for healing) or "set".');
            value.current = Math.max(0, Math.min(value.max, target));
            item.sheet.resources[definition.id] = value;
            await this.persist(item, scope);
            const result = { sheet: item.sheet.name, resource: definition.name, before, after: value.current, max: value.max };
            if (value.current === 0) result.note = `${definition.name} reached 0.`;
            if (target > value.max) result.note = `Capped at the max (${value.max}).`;
            return result;
        });
    }

    deleteSheet(reference) {
        return this.run(async () => {
            const scope = this.scope();
            const item = await this.resolve(reference, scope);
            if (item.location === 'player') throw new Error('The player sheet cannot be deleted.');
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
        return Math.min(20, Math.floor(this.random() * 20) + 1);
    }

    roll(reference, { check, dc, mode = 'normal', bonus = 0, reason } = {}) {
        return this.run(async () => {
            const item = await this.resolve(reference);
            const view = this.view(item);
            const wanted = String(check ?? '').trim();
            if (!wanted) throw new Error('"check" is required (a skill or attribute name).');
            const skill = view.skills.find(s => s.id === wanted || normalizeName(s.name) === normalizeName(wanted));
            const attribute = skill ? null : view.attributes.find(a => a.id === wanted || normalizeName(a.name) === normalizeName(wanted));
            if (!skill && !attribute) {
                const names = [...view.skills.map(s => s.name), ...view.attributes.map(a => a.name)].join(', ');
                throw new Error(`Unknown check "${wanted}". Use a skill or attribute: ${names}.`);
            }
            const situational = toInt(bonus ?? 0, 'bonus', BONUS_RANGE);
            const mod = skill ? skill.total : attribute.modifier;
            const rolls = mode === 'advantage' || mode === 'disadvantage' ? [this.d20(), this.d20()] : [this.d20()];
            const kept = mode === 'advantage' ? Math.max(...rolls) : mode === 'disadvantage' ? Math.min(...rolls) : rolls[0];
            const total = kept + mod + situational;
            const target = dc === undefined || dc === null ? null : toInt(dc, 'dc', { min: 0, max: 100 });

            const result = {
                sheet: item.sheet.name,
                check: skill ? skill.name : attribute.name,
                type: skill ? 'skill' : 'attribute',
                mode,
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
            if (kept === 20) result.natural = 20;
            if (kept === 1) result.natural = 1;
            if (reason) result.reason = String(reason).slice(0, 200);

            const parts = [`d20 ${kept}${rolls.length > 1 ? ` (${rolls.join(' / ')})` : ''}`, formatModifier(mod)];
            if (situational) parts.push(formatModifier(situational));
            result.summary = `${result.check} de ${result.sheet}: ${parts.join(' ')} = ${total}`
                + (target !== null ? ` vs CD ${target}: ${result.success ? 'sucesso' : 'falha'}` : '')
                + (result.natural === 20 ? ' (20 natural!)' : result.natural === 1 ? ' (1 natural!)' : '');
            this.emit({ type: 'roll', result });
            return result;
        });
    }
}
