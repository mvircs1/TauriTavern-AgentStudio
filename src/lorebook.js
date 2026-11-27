// Acesso aos lorebooks (World Info) do SillyTavern/TauriTavern, com backup automático.
// O CRUD usa as funções públicas de SillyTavern.getContext() (loadWorldInfo, saveWorldInfo,
// getWorldInfoNames, updateWorldInfoList, reloadWorldInfoEditor). Extras opcionais vêm de
// world-info.js por import dinâmico; se o import falhar, há alternativas locais.

import { clampInt, createSerialQueue, foldedIndexOf, foldText, generateId, locateFlexible, LOG_PREFIX, truncate } from './util.js';

const BACKUP_INDEX_TABLE = 'meta';
const BACKUP_INDEX_KEY = 'backups';
const BACKUP_TABLE = 'backups';

const SUMMARY_PREVIEW_CHARS = 140;
const FULL_ENTRY_MAX_CHARS = 20_000;
const FULL_READ_BUDGET_CHARS = 60_000;
const MAX_UIDS_PER_READ = 25;

export const POSITION_NAMES = {
    0: 'before_char_defs',
    1: 'after_char_defs',
    2: 'authors_note_top',
    3: 'authors_note_bottom',
    4: 'at_depth',
    5: 'examples_top',
    6: 'examples_bottom',
    7: 'outlet',
};
export const LOGIC_NAMES = { 0: 'AND_ANY', 1: 'NOT_ALL', 2: 'NOT_ANY', 3: 'AND_ALL' };
export const ROLE_NAMES = { 0: 'system', 1: 'user', 2: 'assistant' };

// Cópia dos valores padrão de newWorldInfoEntryTemplate (SillyTavern 1.19), usada se o import falhar.
const FALLBACK_TEMPLATE = Object.freeze({
    key: [], keysecondary: [], comment: '', content: '', constant: false, vectorized: false,
    selective: true, selectiveLogic: 0, addMemo: false, order: 100, position: 0, disable: false,
    ignoreBudget: false, excludeRecursion: false, preventRecursion: false,
    matchPersonaDescription: false, matchCharacterDescription: false, matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false, matchScenario: false, matchCreatorNotes: false,
    delayUntilRecursion: 0, probability: 100, useProbability: true, depth: 4, outletName: '',
    group: '', groupOverride: false, groupWeight: 100, scanDepth: null, caseSensitive: null,
    matchWholeWords: null, useGroupScoring: null, automationId: '', role: 0, sticky: null,
    cooldown: null, delay: null, triggers: [],
});

// Campos que o Agent pode definir e como validar cada um.
const FIELD_SPECS = {
    comment: { type: 'string' },
    content: { type: 'string' },
    key: { type: 'keys' },
    keysecondary: { type: 'keys' },
    constant: { type: 'boolean' },
    selective: { type: 'boolean' },
    selectiveLogic: { type: 'int', min: 0, max: 3 },
    disable: { type: 'boolean' },
    order: { type: 'int', min: -100000, max: 100000 },
    position: { type: 'int', min: 0, max: 7 },
    depth: { type: 'int', min: 0, max: 10000 },
    role: { type: 'int', min: 0, max: 2 },
    probability: { type: 'int', min: 0, max: 100 },
    useProbability: { type: 'boolean' },
    excludeRecursion: { type: 'boolean' },
    preventRecursion: { type: 'boolean' },
    delayUntilRecursion: { type: 'int', min: 0, max: 1000 },
    ignoreBudget: { type: 'boolean' },
    vectorized: { type: 'boolean' },
    group: { type: 'string' },
    groupOverride: { type: 'boolean' },
    groupWeight: { type: 'int', min: 0, max: 100000 },
    useGroupScoring: { type: 'boolean', nullable: true },
    scanDepth: { type: 'int', min: 0, max: 1000, nullable: true },
    caseSensitive: { type: 'boolean', nullable: true },
    matchWholeWords: { type: 'boolean', nullable: true },
    sticky: { type: 'int', min: 0, max: 100000, nullable: true },
    cooldown: { type: 'int', min: 0, max: 100000, nullable: true },
    delay: { type: 'int', min: 0, max: 100000, nullable: true },
    outletName: { type: 'string' },
    automationId: { type: 'string' },
    addMemo: { type: 'boolean' },
};

// Nomes alternativos que modelos costumam usar.
const FIELD_ALIASES = {
    keys: 'key',
    keywords: 'key',
    primary_keys: 'key',
    secondary_keys: 'keysecondary',
    secondaryKeys: 'keysecondary',
    title: 'comment',
    name: 'comment',
    memo: 'comment',
    enabled: '!disable',
    disabled: 'disable',
    selective_logic: 'selectiveLogic',
    scan_depth: 'scanDepth',
    case_sensitive: 'caseSensitive',
    match_whole_words: 'matchWholeWords',
    use_probability: 'useProbability',
    exclude_recursion: 'excludeRecursion',
    prevent_recursion: 'preventRecursion',
};

const INVALID_BOOK_NAME = /[\u0000-\u001f<>:"/\\|?*]/;

function parseKeys(value, field) {
    if (Array.isArray(value)) {
        return value.map(item => String(item).trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
        return value.split(',').map(item => item.trim()).filter(Boolean);
    }
    throw new Error(`"${field}" must be an array of strings.`);
}

function parseBoolean(value, field) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const text = foldText(value);
    if (['true', 'yes', 'sim', 'on', '1'].includes(text)) return true;
    if (['false', 'no', 'nao', 'off', '0'].includes(text)) return false;
    throw new Error(`"${field}" must be true or false.`);
}

// Campos numéricos que também aceitam nomes (ex.: "position": "at_depth", "role": "assistant").
const ENUM_NAMES = {
    position: {
        before_char_defs: 0, before_char: 0, before: 0, after_char_defs: 1, after_char: 1, after: 1,
        authors_note_top: 2, an_top: 2, authors_note_bottom: 3, an_bottom: 3, at_depth: 4, depth: 4, in_chat: 4,
        examples_top: 5, em_top: 5, examples_bottom: 6, em_bottom: 6, outlet: 7,
    },
    role: { system: 0, user: 1, assistant: 2 },
    selectiveLogic: { and_any: 0, not_all: 1, not_any: 2, and_all: 3 },
};

// Campos que aparecem na saída do lorebook_read e o modelo às vezes devolve; são ignorados sem aviso.
const READ_ONLY_FIELDS = new Set(['uid', 'position_name', 'content_truncated', 'displayIndex', 'preview', 'content_chars', 'sheet', 'world', 'book', 'id']);

function parseEntryValue(spec, field, rawField, value) {
    if (spec.type === 'int' && typeof value === 'string' && ENUM_NAMES[field]) {
        const named = ENUM_NAMES[field][foldText(value).replace(/[\s-]+/g, '_')];
        if (named !== undefined) return named;
    }
    switch (spec.type) {
        case 'string':
            return String(value).normalize('NFC');
        case 'keys':
            return parseKeys(value, rawField).map(key => key.normalize('NFC'));
        case 'boolean':
            return parseBoolean(value, rawField);
        case 'int': {
            const number = Number(typeof value === 'string' ? value.trim().replace(/^\+/, '') : value);
            if (!Number.isFinite(number)) throw new Error(`"${rawField}" must be a number.`);
            const int = Math.trunc(number);
            if (int < spec.min || int > spec.max) {
                throw new Error(`"${rawField}" must be between ${spec.min} and ${spec.max}.`);
            }
            return int;
        }
        default:
            return value;
    }
}

/**
 * Valida e normaliza os campos de uma entrada vindos do modelo. Campos desconhecidos não dão erro:
 * são devolvidos em `ignored` para a ferramenta avisar o modelo.
 * @param {unknown} input
 * @returns {{ fields: Record<string, any>, ignored: string[] }}
 */
export function parseEntryFields(input) {
    if (input === undefined || input === null) return { fields: {}, ignored: [] };
    if (typeof input === 'string') {
        try {
            input = JSON.parse(input);
        } catch {
            throw new Error('Entry fields must be an object, e.g. {"comment": "...", "key": ["..."], "content": "..."}.');
        }
    }
    if (typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('Entry fields must be an object, e.g. {"comment": "...", "key": ["..."], "content": "..."}.');
    }
    const result = {};
    const ignored = [];
    for (const [rawField, rawValue] of Object.entries(input)) {
        let field = rawField;
        let value = rawValue;
        const alias = FIELD_ALIASES[field];
        if (alias === '!disable') {
            field = 'disable';
            value = !parseBoolean(value, rawField);
        } else if (alias) {
            field = alias;
        }
        const spec = FIELD_SPECS[field];
        if (!spec) {
            if (!READ_ONLY_FIELDS.has(field)) ignored.push(rawField);
            continue;
        }
        if (value === null || value === undefined) {
            if (spec.nullable) {
                result[field] = null;
                continue;
            }
            throw new Error(`"${rawField}" cannot be null.`);
        }
        result[field] = parseEntryValue(spec, field, rawField, value);
    }
    return { fields: result, ignored };
}

/** Atalho que devolve só os campos válidos. */
export function sanitizeEntryFields(input) {
    return parseEntryFields(input).fields;
}

function sortEntries(entries) {
    return entries.sort((a, b) => {
        const ai = a.displayIndex ?? a.uid;
        const bi = b.displayIndex ?? b.uid;
        return Number(ai) - Number(bi);
    });
}

function entryTitle(entry) {
    return entry.comment || (Array.isArray(entry.key) && entry.key.length ? entry.key.join(', ') : `Entry ${entry.uid}`);
}

function summarizeEntry(entry) {
    const content = String(entry.content ?? '');
    const summary = {
        uid: Number(entry.uid),
        title: entry.comment ?? '',
        keys: Array.isArray(entry.key) ? entry.key : [],
        constant: Boolean(entry.constant),
        disabled: Boolean(entry.disable),
        position: POSITION_NAMES[entry.position] ?? entry.position,
        order: entry.order,
        content_chars: content.length,
        preview: content.length > SUMMARY_PREVIEW_CHARS ? `${content.slice(0, SUMMARY_PREVIEW_CHARS)}…` : content,
    };
    if (Number(entry.position) === 4) summary.depth = entry.depth;
    if (Array.isArray(entry.keysecondary) && entry.keysecondary.length) summary.secondary_keys = entry.keysecondary;
    return summary;
}

function fullEntry(entry, maxContentChars) {
    const result = { uid: Number(entry.uid) };
    for (const field of Object.keys(FIELD_SPECS)) {
        if (field in entry) result[field] = entry[field];
    }
    result.position_name = POSITION_NAMES[entry.position] ?? null;
    if (typeof result.content === 'string') {
        const { text, truncated } = truncate(result.content, maxContentChars);
        result.content = text;
        if (truncated) result.content_truncated = true;
    }
    return result;
}

export class LorebookService {
    /**
     * @param {import('./storage.js').Storage} storage
     * @param {() => { backupsPerBook: number }} getSettings
     */
    constructor(storage, getSettings) {
        this.storage = storage;
        this.getSettings = getSettings;
        this.enqueue = createSerialQueue();
        this.backupIndex = null;
        /** Livros que já ganharam backup numa run (chave `${runId}::${book}`). */
        this.backedUpInRun = new Set();
        this.worldInfoModule = undefined;
        this.listeners = new Set();
        /** Preenchido pelo sistema de fichas: (book) => Map<uid, nome da ficha vinculada>. */
        this.sheetLinksForBook = null;
        /** @type {import('./journal.js').RunJournal|null} */
        this.journal = null;
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
        const context = globalThis.SillyTavern?.getContext?.();
        if (!context) throw new Error('SillyTavern context is not available.');
        return context;
    }

    async wi() {
        if (this.worldInfoModule !== undefined) return this.worldInfoModule;
        try {
            this.worldInfoModule = await import('../../../../world-info.js');
        } catch (error) {
            console.warn(LOG_PREFIX, 'world-info.js não pôde ser importado; usando alternativas locais.', error);
            this.worldInfoModule = null;
        }
        return this.worldInfoModule;
    }

    async bookNames({ refresh = false } = {}) {
        const context = this.context();
        if (refresh && typeof context.updateWorldInfoList === 'function') {
            await context.updateWorldInfoList();
        }
        const names = typeof context.getWorldInfoNames === 'function' ? context.getWorldInfoNames() : [];
        return [...names].sort((a, b) => a.localeCompare(b));
    }

    async requireBook(name) {
        const book = typeof name === 'string' ? name.normalize('NFC').trim() : String(name ?? '').trim();
        if (!book) throw new Error('"book" (lorebook name) is required.');
        let names = await this.bookNames();
        if (!names.includes(book)) names = await this.bookNames({ refresh: true });
        if (names.includes(book)) return book;

        // Sem diferenciar acentos, maiúsculas, forma Unicode ou extensão ".json".
        const wanted = foldText(book.replace(/\.json$/i, ''));
        const sameName = names.filter(candidate => foldText(candidate) === wanted);
        if (sameName.length === 1) return sameName[0];
        const containing = names.filter(candidate => foldText(candidate).includes(wanted) || wanted.includes(foldText(candidate)));
        if (containing.length === 1) return containing[0];
        const similar = containing.slice(0, 5);
        throw new Error(similar.length
            ? `Lorebook not found: "${book}". Did you mean: ${similar.map(s => `"${s}"`).join(', ')}?`
            : `Lorebook not found: "${book}". Use lorebook_list to see the available lorebooks.`);
    }

    /** Carrega uma cópia editável do livro (o cache do ST não pode ser alterado diretamente). */
    async loadBook(name) {
        const data = await this.context().loadWorldInfo(name);
        if (!data || typeof data !== 'object') throw new Error(`Could not load lorebook "${name}".`);
        const copy = structuredClone(data);
        if (!copy.entries || typeof copy.entries !== 'object') copy.entries = {};
        return copy;
    }

    async saveBook(name, data) {
        const context = this.context();
        await context.saveWorldInfo(name, data, true);
        try {
            context.reloadWorldInfoEditor?.(name);
        } catch (error) {
            console.warn(LOG_PREFIX, 'Não consegui atualizar o editor de World Info', error);
        }
        this.emit({ type: 'book', book: name });
    }

    async freeUid(data) {
        const wi = await this.wi();
        if (typeof wi?.getFreeWorldEntryUid === 'function') {
            const uid = wi.getFreeWorldEntryUid(data);
            if (Number.isInteger(uid)) return uid;
        }
        const used = new Set(Object.keys(data.entries).map(Number));
        let uid = 0;
        while (used.has(uid)) uid++;
        return uid;
    }

    async entryTemplate() {
        const wi = await this.wi();
        const template = wi?.newWorldInfoEntryTemplate;
        return structuredClone(template && typeof template === 'object' ? template : FALLBACK_TEMPLATE);
    }

    /** Mantém data.originalData (formato nativo de cards importados) em sincronia, como o editor faz. */
    async syncOriginalData(data, uid, changes) {
        if (!data.originalData) return;
        const wi = await this.wi();
        if (typeof wi?.setWIOriginalDataValue !== 'function' || !wi.originalWIDataKeyMap) return;
        for (const [field, value] of Object.entries(changes)) {
            const nativeKey = wi.originalWIDataKeyMap[field];
            if (nativeKey) wi.setWIOriginalDataValue(data, uid, nativeKey, value);
        }
    }

    async linkInfo() {
        const context = this.context();
        const wi = await this.wi();
        const character = context.characterId !== undefined && context.characterId !== null
            ? context.characters?.[context.characterId]
            : null;
        const characterFile = typeof character?.avatar === 'string' ? character.avatar.replace(/\.[^/.]+$/, '') : null;
        const charLore = Array.isArray(wi?.world_info?.charLore) ? wi.world_info.charLore : [];
        const extraBooks = characterFile ? (charLore.find(item => item.name === characterFile)?.extraBooks ?? []) : [];
        return {
            global: new Set(Array.isArray(wi?.selected_world_info) ? wi.selected_world_info : []),
            characterPrimary: character?.data?.extensions?.world || null,
            characterExtra: new Set(extraBooks),
            chat: context.chatMetadata?.world_info || null,
            persona: context.powerUserSettings?.persona_description_lorebook || null,
            characterName: character?.name ?? null,
        };
    }

    /** Nomes dos lorebooks ativos no chat atual (global, personagem, chat, persona). */
    async activeBookNames() {
        const links = await this.linkInfo();
        const names = new Set([...links.global, ...links.characterExtra]);
        for (const name of [links.characterPrimary, links.chat, links.persona]) {
            if (name) names.add(name);
        }
        return names;
    }

    /** Confirma que a entrada existe e devolve { book, uid, title }. */
    describeEntry(book, uid) {
        return this.enqueue(async () => {
            const name = await this.requireBook(book);
            const data = await this.context().loadWorldInfo(name);
            const key = String(Math.trunc(Number(uid)));
            const entry = data?.entries?.[key];
            if (!entry) throw new Error(`Entry uid ${uid} not found in "${name}". Use lorebook_read to see the uids.`);
            return { book: name, uid: Number(key), title: entryTitle(entry) };
        });
    }

    // ---------- leitura ----------

    list({ includeCounts = false } = {}) {
        return this.enqueue(async () => {
            const names = await this.bookNames({ refresh: true });
            const links = await this.linkInfo();
            const context = this.context();
            const books = [];
            for (const name of names) {
                const activeFor = [];
                if (links.global.has(name)) activeFor.push('global');
                if (links.characterPrimary === name) activeFor.push('character');
                if (links.characterExtra.has(name)) activeFor.push('character_extra');
                if (links.chat === name) activeFor.push('chat');
                if (links.persona === name) activeFor.push('persona');
                const item = { name, active_for: activeFor };
                if (includeCounts) {
                    try {
                        const data = await context.loadWorldInfo(name);
                        item.entries = Object.keys(data?.entries ?? {}).length;
                    } catch {
                        item.entries = null;
                    }
                }
                books.push(item);
            }
            return { books, current_character: links.characterName, total: books.length };
        });
    }

    read({ book, uids, offset = 0, limit = 100 } = {}) {
        return this.enqueue(async () => {
            const name = await this.requireBook(book);
            const data = await this.loadBook(name);
            const entries = sortEntries(Object.values(data.entries));

            if (Array.isArray(uids) && uids.length) {
                if (uids.length > MAX_UIDS_PER_READ) throw new Error(`Read at most ${MAX_UIDS_PER_READ} entries per call.`);
                let budget = FULL_READ_BUDGET_CHARS;
                const result = [];
                const missing = [];
                for (const rawUid of uids) {
                    const entry = data.entries[String(Math.trunc(Number(rawUid)))];
                    if (!entry) {
                        missing.push(rawUid);
                        continue;
                    }
                    const item = fullEntry(entry, Math.max(500, Math.min(FULL_ENTRY_MAX_CHARS, budget)));
                    budget -= String(item.content ?? '').length;
                    result.push(item);
                }
                const response = { book: name, total_entries: entries.length, entries: result };
                if (missing.length) response.missing_uids = missing;
                return response;
            }

            const start = clampInt(offset, { min: 0, max: Math.max(entries.length, 0), fallback: 0 });
            const count = clampInt(limit, { min: 1, max: 300, fallback: 100 });
            const page = entries.slice(start, start + count).map(summarizeEntry);
            const sheets = this.sheetLinksForBook?.(name);
            if (sheets?.size) {
                for (const summary of page) {
                    if (sheets.has(summary.uid)) summary.sheet = sheets.get(summary.uid);
                }
            }
            const response = { book: name, total_entries: entries.length, offset: start, entries: page };
            if (start + count < entries.length) response.next_offset = start + count;
            return response;
        });
    }

    search({ query, books, limit = 20 } = {}) {
        return this.enqueue(async () => {
            const raw = typeof query === 'string' ? query.normalize('NFC').trim() : String(query ?? '').trim();
            if (!raw) throw new Error('query is required.');
            // Busca sem diferenciar maiúsculas nem acentos ("acao" acha "ação").
            const has = value => foldedIndexOf(value, raw) !== -1;
            const max = clampInt(limit, { min: 1, max: 100, fallback: 20 });

            let names;
            if (Array.isArray(books) && books.length) {
                names = [];
                for (const book of books) names.push(await this.requireBook(book));
            } else {
                names = await this.bookNames({ refresh: true });
            }

            const context = this.context();
            const results = [];
            let truncated = false;
            outer:
            for (const name of names) {
                const data = await context.loadWorldInfo(name);
                for (const entry of sortEntries(Object.values(data?.entries ?? {}))) {
                    const matchedIn = [];
                    const content = String(entry.content ?? '').normalize('NFC');
                    if (has(String(entry.comment ?? ''))) matchedIn.push('title');
                    if ((entry.key ?? []).some(key => has(String(key)))) matchedIn.push('keys');
                    if ((entry.keysecondary ?? []).some(key => has(String(key)))) matchedIn.push('secondary_keys');
                    const contentIndex = foldedIndexOf(content, raw);
                    if (contentIndex !== -1) matchedIn.push('content');
                    if (!matchedIn.length) continue;

                    const start = Math.max(0, contentIndex - 60);
                    const snippet = contentIndex === -1
                        ? content.slice(0, 120)
                        : `${start > 0 ? '…' : ''}${content.slice(start, contentIndex + raw.length + 60)}…`;
                    results.push({ book: name, uid: Number(entry.uid), title: entryTitle(entry), matched_in: matchedIn, snippet });
                    if (results.length >= max) {
                        truncated = true;
                        break outer;
                    }
                }
            }
            return { query: raw, results, truncated };
        });
    }

    // ---------- escrita (sempre com backup antes) ----------

    createEntry({ book, fields, runId } = {}) {
        return this.enqueue(async () => {
            const name = await this.requireBook(book);
            const { fields: sanitized, ignored } = parseEntryFields(fields);
            if (!sanitized.content && !sanitized.comment) {
                throw new Error('Provide at least "content" (and usually "comment" and "key"), e.g. {"book": "...", "entry": {"comment": "Title", "key": ["word"], "content": "Text"}}.');
            }
            const data = await this.loadBook(name);
            await this.backupBeforeChange(name, data, 'create_entry', runId);

            const uid = await this.freeUid(data);
            const entry = { uid, ...(await this.entryTemplate()), ...sanitized };
            if (sanitized.comment && !('addMemo' in sanitized)) entry.addMemo = true;
            data.entries[uid] = entry;
            await this.saveBook(name, data);

            const warnings = [];
            if (!entry.constant && (!entry.key || entry.key.length === 0)) {
                warnings.push('This entry has no keys and is not constant, so it will never activate. Add "key" or set "constant": true.');
            }
            if (ignored.length) warnings.push(`Ignored unknown field(s): ${ignored.join(', ')}.`);
            return { book: name, uid, title: entryTitle(entry), created: true, warnings };
        });
    }

    updateEntry({ book, uid, changes, contentEdit, runId } = {}) {
        return this.enqueue(async () => {
            const name = await this.requireBook(book);
            const data = await this.loadBook(name);
            const key = String(Math.trunc(Number(uid)));
            const entry = data.entries[key];
            if (!entry) throw new Error(`Entry uid ${uid} not found in "${name}". Use lorebook_read to see the uids.`);

            const { fields: sanitized, ignored } = parseEntryFields(changes);
            if (contentEdit && typeof contentEdit === 'object') {
                const oldString = contentEdit.old_string ?? contentEdit.oldString ?? contentEdit.old ?? contentEdit.find;
                const newString = contentEdit.new_string ?? contentEdit.newString ?? contentEdit.new ?? contentEdit.replace ?? '';
                if (typeof oldString !== 'string' || !oldString) throw new Error('content_edit.old_string must be a non-empty string.');
                const base = sanitized.content ?? String(entry.content ?? '');
                const { text, needle, count } = locateFlexible(base, oldString);
                if (count === 0) throw new Error('content_edit.old_string was not found in the entry content. Read the entry again (lorebook_read with uids) and copy the exact text.');
                if (count > 1) throw new Error(`content_edit.old_string matches ${count} places; include more surrounding text to make it unique.`);
                sanitized.content = text.replace(needle, () => String(newString).normalize('NFC'));
            }
            if (Object.keys(sanitized).length === 0) {
                throw new Error(ignored.length
                    ? `Nothing to change: unknown field(s) ${ignored.join(', ')}. Valid fields include comment, content, key, keysecondary, constant, disable, position, depth, order.`
                    : 'Nothing to change: pass "changes" (e.g. {"content": "..."}) and/or "content_edit".');
            }

            await this.backupBeforeChange(name, data, 'update_entry', runId);
            Object.assign(entry, sanitized);
            await this.syncOriginalData(data, Number(key), sanitized);
            await this.saveBook(name, data);
            const result = { book: name, uid: Number(key), title: entryTitle(entry), updated_fields: Object.keys(sanitized) };
            if (ignored.length) result.warnings = [`Ignored unknown field(s): ${ignored.join(', ')}.`];
            return result;
        });
    }

    deleteEntry({ book, uid, runId } = {}) {
        return this.enqueue(async () => {
            const name = await this.requireBook(book);
            const data = await this.loadBook(name);
            const key = String(Math.trunc(Number(uid)));
            const entry = data.entries[key];
            if (!entry) throw new Error(`Entry uid ${uid} not found in "${name}".`);

            await this.backupBeforeChange(name, data, 'delete_entry', runId);
            delete data.entries[key];
            const wi = await this.wi();
            if (typeof wi?.deleteWIOriginalDataValue === 'function') wi.deleteWIOriginalDataValue(data, Number(key));
            await this.saveBook(name, data);
            return { book: name, deleted_uid: Number(key), title: entryTitle(entry), note: 'A backup was saved; the user can restore it from Agent Studio.' };
        });
    }

    createBook({ name, runId } = {}) {
        return this.enqueue(async () => {
            let bookName = typeof name === 'string' ? name.normalize('NFC').trim() : '';
            if (!bookName) throw new Error('"name" is required.');
            if (INVALID_BOOK_NAME.test(bookName)) throw new Error('Lorebook names cannot contain / \\ : * ? " < > | or control characters.');
            if (bookName.length > 100) throw new Error('Lorebook name is too long (max 100 characters).');
            bookName = await this.sanitizeBookName(bookName);

            const existing = await this.bookNames({ refresh: true });
            const clash = existing.find(item => foldText(item) === foldText(bookName));
            if (clash) {
                throw new Error(`A lorebook named "${clash}" already exists. Use it instead of creating a new one.`);
            }
            const context = this.context();
            if (runId && this.journal) {
                await this.journal.capture(runId, `lore-created:${bookName}`, async () => ({ kind: 'lorebook_created', book: bookName }));
            }
            await context.saveWorldInfo(bookName, { entries: {} }, true);
            const after = await this.bookNames({ refresh: true });
            this.emit({ type: 'book', book: bookName });
            return {
                book: bookName,
                created: after.includes(bookName),
                note: 'The new lorebook is not linked to any chat or character yet. Tell the user to link it (World Info panel) if it should be active.',
            };
        });
    }

    async sanitizeBookName(name) {
        const context = this.context();
        try {
            const response = await fetch('/api/worldinfo/sanitize-name', {
                method: 'POST',
                headers: typeof context.getRequestHeaders === 'function'
                    ? context.getRequestHeaders()
                    : { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            if (response.ok) {
                const result = await response.json();
                if (typeof result?.name === 'string' && result.name.trim()) return result.name.trim();
            }
        } catch (error) {
            console.warn(LOG_PREFIX, 'sanitize-name indisponível; usando o nome como está.', error);
        }
        return name;
    }

    // ---------- backups ----------

    async loadBackupIndex() {
        if (!this.backupIndex) {
            const stored = await this.storage.get(BACKUP_INDEX_TABLE, BACKUP_INDEX_KEY);
            this.backupIndex = Array.isArray(stored?.items) ? stored.items : [];
        }
        return this.backupIndex;
    }

    async saveBackupIndex() {
        await this.storage.set(BACKUP_INDEX_TABLE, BACKUP_INDEX_KEY, { items: this.backupIndex });
    }

    /** Faz no máximo um backup por livro por run do Agent (sem runId, sempre faz). */
    async backupBeforeChange(book, data, reason, runId) {
        const runKey = runId ? `${runId}::${book}` : null;
        if (runKey && this.backedUpInRun.has(runKey)) return null;
        const item = await this.createBackupInternal(book, data, reason, runId);
        if (runKey) this.backedUpInRun.add(runKey);
        if (runId && this.journal) {
            await this.journal.capture(runId, `lore:${book}`, async () => ({ kind: 'lorebook', book, backupId: item.id }));
        }
        return item;
    }

    /** Desfaz o que uma run fez nos lorebooks: volta cada livro ao backup de antes da run. */
    undoEntries(entries) {
        return this.enqueue(async () => {
            let changed = 0;
            const names = await this.bookNames({ refresh: true });
            for (const entry of entries.filter(item => item.kind === 'lorebook')) {
                const stored = entry.data ? { data: entry.data } : await this.storage.get(BACKUP_TABLE, entry.backupId);
                if (!stored?.data) {
                    console.warn(LOG_PREFIX, `Backup ${entry.backupId} de "${entry.book}" não existe mais; não dá para desfazer.`);
                    continue;
                }
                if (names.includes(entry.book)) {
                    await this.createBackupInternal(entry.book, await this.loadBook(entry.book), 'before_undo');
                }
                await this.saveBook(entry.book, structuredClone(stored.data));
                changed++;
            }
            for (const entry of entries.filter(item => item.kind === 'lorebook_created')) {
                if (!names.includes(entry.book)) continue;
                await this.createBackupInternal(entry.book, await this.loadBook(entry.book), 'before_undo');
                await this.deleteBookInternal(entry.book);
                changed++;
            }
            if (changed) await this.bookNames({ refresh: true });
            return changed;
        });
    }

    /** Estado atual dos livros das entradas: com o conteúdo, ou "não existe" (para refazer ao voltar numa swipe). */
    snapshotEntries(entries) {
        return this.enqueue(async () => {
            const names = await this.bookNames({ refresh: true });
            const result = [];
            for (const entry of entries) {
                if (entry.kind !== 'lorebook' && entry.kind !== 'lorebook_created') continue;
                result.push(names.includes(entry.book)
                    ? { key: entry.key, kind: 'lorebook', book: entry.book, data: await this.loadBook(entry.book) }
                    : { key: entry.key, kind: 'lorebook_created', book: entry.book });
            }
            return result;
        });
    }

    async deleteBookInternal(name) {
        const wi = await this.wi();
        if (typeof wi?.deleteWorldInfo === 'function') {
            await wi.deleteWorldInfo(name);
        } else {
            const context = this.context();
            await fetch('/api/worldinfo/delete', {
                method: 'POST',
                headers: typeof context.getRequestHeaders === 'function' ? context.getRequestHeaders() : { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            if (typeof context.deleteWorldInfo === 'function') await context.deleteWorldInfo(name);
        }
        this.emit({ type: 'book', book: name });
    }

    async createBackupInternal(book, data, reason, runId = null) {
        const index = await this.loadBackupIndex();
        const id = generateId('b');
        const createdAt = new Date().toISOString();
        await this.storage.set(BACKUP_TABLE, id, { book, createdAt, reason, runId, data });
        index.unshift({ id, book, createdAt, reason, runId, entries: Object.keys(data?.entries ?? {}).length });

        const keep = clampInt(this.getSettings().backupsPerBook, { min: 1, max: 500, fallback: 20 });
        let seen = 0;
        const removed = [];
        this.backupIndex = index.filter(item => {
            if (item.book !== book) return true;
            seen++;
            if (seen <= keep) return true;
            removed.push(item.id);
            return false;
        });
        for (const removedId of removed) await this.storage.remove(BACKUP_TABLE, removedId);
        await this.saveBackupIndex();
        this.emit({ type: 'backup', book });
        return { id, book, createdAt };
    }

    listBackups() {
        return this.enqueue(async () => [...(await this.loadBackupIndex())]);
    }

    backupNow(book) {
        return this.enqueue(async () => {
            const name = await this.requireBook(book);
            const data = await this.loadBook(name);
            return this.createBackupInternal(name, data, 'manual');
        });
    }

    getBackup(id) {
        return this.enqueue(async () => {
            const stored = await this.storage.get(BACKUP_TABLE, id);
            if (!stored) throw new Error('Backup não encontrado.');
            return stored;
        });
    }

    restoreBackup(id) {
        return this.enqueue(async () => {
            const stored = await this.storage.get(BACKUP_TABLE, id);
            if (!stored?.data) throw new Error('Backup não encontrado.');
            const names = await this.bookNames({ refresh: true });
            if (names.includes(stored.book)) {
                const current = await this.loadBook(stored.book);
                await this.createBackupInternal(stored.book, current, 'before_restore');
            }
            await this.saveBook(stored.book, structuredClone(stored.data));
            if (!names.includes(stored.book)) await this.bookNames({ refresh: true });
            return { book: stored.book };
        });
    }

    deleteBackup(id) {
        return this.enqueue(async () => {
            const index = await this.loadBackupIndex();
            this.backupIndex = index.filter(item => item.id !== id);
            await this.storage.remove(BACKUP_TABLE, id);
            await this.saveBackupIndex();
            this.emit({ type: 'backup' });
        });
    }
}
