// Mapas: Mundo → Região → Local, com conexões entre lugares, posição do jogador e dos NPCs por chat.
//
// Onde cada coisa fica:
// - Lista de mundos e o mundo padrão de cada personagem: armazenamento do plugin (meta/maps).
// - Lugares e conexões de cada mundo: armazenamento do plugin (maps/<worldId>), compartilhados
//   por todos os chats que usam aquele mundo.
// - Mundo do chat, posição do jogador, posição dos NPCs com ficha e lugares já conhecidos:
//   chat_metadata.agent_studio.map (acompanha branches e exportações do chat).
//
// Economia de tokens: só o local atual (com saídas e quem está lá) vai para o prompt, num bloco curto,
// e só as entradas de lorebook vinculadas a ele são ativadas.

import { createSerialQueue, foldText, generateId, LOG_PREFIX } from './util.js';

const META_TABLE = 'meta';
const INDEX_KEY = 'maps';
const WORLDS_TABLE = 'maps';
const BACKUPS_TABLE = 'map_backups';
const CHAT_META_KEY = 'agent_studio';
const MAX_FILL_BACKUPS = 5;

export const PROMPT_KEY = 'agent_studio_location';
export const LEVELS = ['world', 'region', 'local'];
export const LEVEL_LABELS = { world: 'Mundo', region: 'Região', local: 'Local' };
const LEVEL_ALIASES = {
    world: 'world', mundo: 'world', continente: 'world', continent: 'world', reino: 'world', kingdom: 'world', plane: 'world', plano: 'world',
    region: 'region', regiao: 'region', cidade: 'region', city: 'region', area: 'region', zona: 'region', zone: 'region',
    local: 'local', location: 'local', place: 'local', lugar: 'local', room: 'local', sala: 'local', building: 'local', predio: 'local',
};
const LIMITS = { name: 80, type: 40, summary: 600, details: 6000, secret: 3000, resident: 300, connection: 300 };

const clip = (value, max) => String(value ?? '').normalize('NFC').trim().slice(0, max);

function normalizeLevel(value, fallback = 'local') {
    return LEVEL_ALIASES[foldText(value)] ?? fallback;
}

function normalizePlace(place) {
    return {
        id: String(place.id),
        name: clip(place.name, LIMITS.name) || 'Sem nome',
        level: LEVELS.includes(place.level) ? place.level : 'local',
        parent: place.parent ? String(place.parent) : null,
        type: clip(place.type, LIMITS.type),
        summary: clip(place.summary, LIMITS.summary),
        details: clip(place.details, LIMITS.details),
        secret: clip(place.secret, LIMITS.secret),
        residents: Array.isArray(place.residents)
            ? place.residents.filter(r => r?.name).map(r => ({ name: clip(r.name, LIMITS.name), description: clip(r.description, LIMITS.resident) }))
            : [],
        lore: Array.isArray(place.lore)
            ? place.lore.filter(l => l?.book && Number.isFinite(Number(l.uid))).map(l => ({ book: String(l.book), uid: Number(l.uid), title: String(l.title ?? '') }))
            : [],
        createdAt: place.createdAt ?? null,
    };
}

function normalizeWorld(stored) {
    const world = { places: {}, connections: [] };
    if (!stored || typeof stored !== 'object') return world;
    for (const [id, place] of Object.entries(stored.places ?? {})) {
        if (place && typeof place.name === 'string') world.places[id] = normalizePlace({ ...place, id });
    }
    for (const connection of Array.isArray(stored.connections) ? stored.connections : []) {
        if (!connection?.from || !connection?.to || !world.places[connection.from] || !world.places[connection.to]) continue;
        world.connections.push({
            id: String(connection.id ?? generateId('c')),
            from: String(connection.from),
            to: String(connection.to),
            description: clip(connection.description, LIMITS.connection),
            twoWay: connection.twoWay !== false,
            hidden: connection.hidden === true,
            locked: connection.locked === true,
        });
    }
    return world;
}

function normalizeChatState(state) {
    return {
        worldId: typeof state?.worldId === 'string' ? state.worldId : null,
        position: typeof state?.position === 'string' ? state.position : null,
        npcs: state?.npcs && typeof state.npcs === 'object' ? { ...state.npcs } : {},
        known: Array.isArray(state?.known) ? [...new Set(state.known.map(String))] : [],
    };
}

/** Lista de residentes aceita "Nome — descrição" por linha, lista de objetos ou de nomes. */
export function parseResidents(input) {
    if (input === undefined || input === null || input === '') return [];
    if (typeof input === 'string') {
        return input.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
            const [name, ...rest] = line.split(/\s+[—–-]\s+|:\s+/);
            return { name: clip(name, LIMITS.name), description: clip(rest.join(' — '), LIMITS.resident) };
        });
    }
    const list = Array.isArray(input) ? input : [input];
    return list.map(item => (typeof item === 'string' ? { name: clip(item, LIMITS.name), description: '' } : {
        name: clip(item?.name, LIMITS.name),
        description: clip(item?.description, LIMITS.resident),
    })).filter(item => item.name);
}

export class MapService {
    /**
     * @param {import('./storage.js').Storage} storage
     * @param {import('./lorebook.js').LorebookService} lore
     * @param {import('./system.js').SystemService} system
     */
    constructor(storage, lore, system) {
        this.storage = storage;
        this.lore = lore;
        this.system = system;
        this.enqueue = createSerialQueue();
        this.index = null;
        this.worlds = new Map();
        this.listeners = new Set();
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
        return SillyTavern.getContext();
    }

    async load() {
        if (this.index) return;
        const stored = await this.storage.get(META_TABLE, INDEX_KEY);
        this.index = {
            worlds: stored?.worlds && typeof stored.worlds === 'object' ? stored.worlds : {},
            characterDefaults: stored?.characterDefaults && typeof stored.characterDefaults === 'object' ? stored.characterDefaults : {},
        };
    }

    run(task) {
        return this.enqueue(async () => {
            await this.load();
            return task();
        });
    }

    async saveIndex() {
        await this.storage.set(META_TABLE, INDEX_KEY, this.index);
    }

    async loadWorld(worldId) {
        if (this.worlds.has(worldId)) return this.worlds.get(worldId);
        const world = normalizeWorld(await this.storage.get(WORLDS_TABLE, worldId));
        this.worlds.set(worldId, world);
        return world;
    }

    async saveWorld(worldId, world) {
        this.worlds.set(worldId, world);
        await this.storage.set(WORLDS_TABLE, worldId, world);
        if (this.index.worlds[worldId]) this.index.worlds[worldId].updatedAt = new Date().toISOString();
    }

    scope() {
        const context = this.context();
        const chatId = typeof context.getCurrentChatId === 'function' ? context.getCurrentChatId() : null;
        const character = context.characterId !== undefined && context.characterId !== null ? context.characters?.[context.characterId] : null;
        let charKey = null;
        if (context.groupId) charKey = `group:${context.groupId}`;
        else if (character?.avatar) charKey = `char:${character.avatar}`;
        return {
            context,
            chatId: chatId || null,
            hasChat: Boolean(chatId && context.chatMetadata),
            charKey,
            characterName: character?.name ?? null,
        };
    }

    chatState(scope) {
        if (!scope.hasChat) return normalizeChatState(null);
        return normalizeChatState(scope.context.chatMetadata[CHAT_META_KEY]?.map);
    }

    async writeChatState(scope, state) {
        if (!scope.hasChat) return;
        const meta = scope.context.chatMetadata;
        meta[CHAT_META_KEY] = { ...(meta[CHAT_META_KEY] ?? {}), map: normalizeChatState(state) };
        await scope.context.saveMetadata();
    }

    /** Mundo do chat: o escolhido no chat, senão o último usado com este personagem. */
    worldIdFor(scope, state = this.chatState(scope)) {
        if (state.worldId && this.index.worlds[state.worldId]) return state.worldId;
        const fallback = scope.charKey ? this.index.characterDefaults[scope.charKey] : null;
        return fallback && this.index.worlds[fallback] ? fallback : null;
    }

    async createWorldInternal(name) {
        const id = generateId('w');
        const now = new Date().toISOString();
        this.index.worlds[id] = { name: clip(name, LIMITS.name) || 'Mundo', createdAt: now, updatedAt: now };
        await this.storage.set(WORLDS_TABLE, id, { places: {}, connections: [] });
        this.worlds.set(id, { places: {}, connections: [] });
        await this.saveIndex();
        return id;
    }

    /** Garante um mundo para o chat (cria um se não houver) e o marca como padrão do personagem. */
    async ensureWorld(scope, runId) {
        const state = this.chatState(scope);
        let worldId = this.worldIdFor(scope, state);
        if (!worldId) {
            await this.captureIndex(runId);
            worldId = await this.createWorldInternal(scope.characterName ? `Mundo de ${scope.characterName}` : 'Mundo');
        }
        if (state.worldId !== worldId) {
            await this.captureChat(runId, scope);
            await this.writeChatState(scope, { ...state, worldId });
        }
        if (scope.charKey && this.index.characterDefaults[scope.charKey] !== worldId) {
            this.index.characterDefaults[scope.charKey] = worldId;
            await this.saveIndex();
        }
        return { worldId, world: await this.loadWorld(worldId), state: this.chatState(scope) };
    }

    // ---------- diário (desfazer ao regenerar) ----------

    async captureWorld(runId, worldId) {
        if (!runId || !this.journal) return;
        await this.journal.capture(runId, `map_world:${worldId}`, async () => ({
            kind: 'map_world',
            worldId,
            before: structuredClone(await this.loadWorld(worldId)),
            indexEntry: this.index.worlds[worldId] ? { ...this.index.worlds[worldId] } : null,
        }));
    }

    async captureIndex(runId) {
        if (!runId || !this.journal) return;
        await this.journal.capture(runId, 'map_index', async () => ({ kind: 'map_index', before: structuredClone(this.index) }));
    }

    async captureChat(runId, scope) {
        if (!runId || !this.journal || !scope.hasChat) return;
        await this.journal.capture(runId, `map_chat:${scope.chatId}`, async () => ({
            kind: 'map_chat',
            chatId: scope.chatId,
            before: scope.context.chatMetadata[CHAT_META_KEY]?.map ? structuredClone(scope.context.chatMetadata[CHAT_META_KEY].map) : null,
        }));
    }

    /** Volta mundos, índice e estado do chat ao que eram antes de uma run. */
    undoEntries(entries, chatId) {
        return this.run(async () => {
            let changed = 0;
            for (const entry of [...entries].reverse()) {
                if (entry.kind === 'map_world') {
                    await this.saveWorld(entry.worldId, normalizeWorld(entry.before));
                    changed++;
                } else if (entry.kind === 'map_index') {
                    const before = entry.before;
                    for (const id of Object.keys(this.index.worlds)) {
                        if (!before.worlds?.[id]) {
                            delete this.index.worlds[id];
                            this.worlds.delete(id);
                            await this.storage.remove(WORLDS_TABLE, id);
                        }
                    }
                    this.index.characterDefaults = { ...(before.characterDefaults ?? {}) };
                    changed++;
                } else if (entry.kind === 'map_chat') {
                    const scope = this.scope();
                    if (scope.chatId !== (entry.chatId ?? chatId) || !scope.hasChat) continue;
                    const meta = scope.context.chatMetadata;
                    const bag = { ...(meta[CHAT_META_KEY] ?? {}) };
                    if (entry.before) bag.map = entry.before;
                    else delete bag.map;
                    meta[CHAT_META_KEY] = bag;
                    await scope.context.saveMetadata();
                    changed++;
                }
            }
            await this.saveIndex();
            if (changed) this.emit({ type: 'undo' });
            return changed;
        });
    }

    // ---------- ajudantes de lugares ----------

    pathOf(world, placeId) {
        const names = [];
        const seen = new Set();
        let current = world.places[placeId];
        while (current && !seen.has(current.id)) {
            seen.add(current.id);
            names.unshift(current.name);
            current = current.parent ? world.places[current.parent] : null;
        }
        return names;
    }

    ancestors(world, placeId) {
        const chain = [];
        const seen = new Set();
        let current = world.places[placeId];
        while (current && !seen.has(current.id)) {
            seen.add(current.id);
            chain.push(current);
            current = current.parent ? world.places[current.parent] : null;
        }
        return chain;
    }

    /** Ancestral (ou o próprio lugar) de um nível, a partir da posição. */
    ancestorAt(world, placeId, level) {
        return this.ancestors(world, placeId).find(place => place.level === level) ?? null;
    }

    /**
     * Acha um lugar por id, caminho ("Solenne/Taverna") ou nome (sem diferenciar acentos/maiúsculas).
     * Com nomes repetidos, prefere o mais perto da posição atual.
     */
    resolvePlace(world, reference, { position = null, required = true } = {}) {
        const raw = String(reference ?? '').normalize('NFC').trim();
        if (!raw) {
            if (required) throw new Error('A place is required.');
            return null;
        }
        if (world.places[raw]) return world.places[raw];
        const places = Object.values(world.places);
        const segments = raw.split(/\s*(?:\/|›|>)\s*/).filter(Boolean);
        let candidates;
        if (segments.length > 1) {
            const last = foldText(segments[segments.length - 1]);
            candidates = places.filter(place => {
                if (foldText(place.name) !== last) return false;
                const path = this.pathOf(world, place.id).map(foldText);
                return segments.slice(0, -1).every(segment => path.includes(foldText(segment)));
            });
        } else {
            const wanted = foldText(raw);
            candidates = places.filter(place => foldText(place.name) === wanted);
            if (!candidates.length) candidates = places.filter(place => foldText(place.name).includes(wanted));
        }
        if (candidates.length === 1) return candidates[0];
        if (candidates.length > 1 && position) {
            const nearby = new Set(this.ancestors(world, position).map(place => place.id));
            const close = candidates.filter(place => nearby.has(place.parent) || nearby.has(place.id));
            if (close.length === 1) return close[0];
        }
        if (candidates.length > 1) {
            throw new Error(`"${raw}" is ambiguous: ${candidates.map(p => `"${this.pathOf(world, p.id).join('/')}"`).join(', ')}. Use the full path.`);
        }
        if (!required) return null;
        throw new Error(`Place not found: "${raw}". Use map_search or map_look to see the places.`);
    }

    exitsOf(world, placeId, known = null) {
        const exits = [];
        for (const connection of world.connections) {
            let other = null;
            if (connection.from === placeId) other = connection.to;
            else if (connection.to === placeId && connection.twoWay) other = connection.from;
            if (!other || !world.places[other]) continue;
            exits.push({ connection, place: world.places[other], known: known ? known.has(other) : true });
        }
        return exits;
    }

    // ---------- leitura ----------

    async presentSheets(state, placeId) {
        const ids = Object.entries(state.npcs).filter(([, where]) => where === placeId).map(([id]) => id);
        if (!ids.length || !this.system) return [];
        try {
            const list = await this.system.listSheets();
            return list.sheets.filter(sheet => ids.includes(sheet.id));
        } catch {
            return [];
        }
    }

    async describePlace(world, place, state, { full = true } = {}) {
        const known = new Set(state.known);
        const result = {
            name: place.name,
            level: place.level,
            path: this.pathOf(world, place.id).join(' › '),
        };
        if (place.type) result.type = place.type;
        if (place.summary) result.summary = place.summary;
        if (full && place.details) result.details = place.details;
        if (full && place.secret) result.secret_gm_only = place.secret;
        result.known_to_player = known.has(place.id);
        if (state.position === place.id) result.player_is_here = true;
        const inside = Object.values(world.places).filter(child => child.parent === place.id);
        if (inside.length) result.inside = inside.map(child => `${child.name}${child.type ? ` (${child.type})` : ''}${known.has(child.id) ? '' : ' [unexplored]'}`);
        const exits = this.exitsOf(world, place.id, known);
        if (exits.length) {
            result.exits = exits.map(({ connection, place: other, known: isKnown }) => {
                const flags = [connection.locked ? 'locked' : null, connection.hidden ? 'hidden' : null, isKnown ? null : 'unexplored'].filter(Boolean);
                return `${other.name}${connection.description ? ` — ${connection.description}` : ''}${flags.length ? ` [${flags.join(', ')}]` : ''}`;
            });
        }
        if (place.residents.length) result.residents = place.residents.map(r => (r.description ? `${r.name} — ${r.description}` : r.name));
        const sheets = await this.presentSheets(state, place.id);
        if (sheets.length) result.npcs_with_sheets_here = sheets.map(sheet => sheet.name);
        if (full && place.lore.length) result.lorebook_entries = place.lore.map(l => `${l.book} #${l.uid}${l.title ? ` ${l.title}` : ''}`);
        return result;
    }

    look({ place } = {}) {
        return this.run(async () => {
            const scope = this.scope();
            const state = this.chatState(scope);
            const worldId = this.worldIdFor(scope, state);
            if (!worldId) {
                return { world: null, note: 'There is no map yet. Create places with map_create (world → region → local) and put the player somewhere with map_move.' };
            }
            const world = await this.loadWorld(worldId);
            const target = place ? this.resolvePlace(world, place, { position: state.position }) : (state.position ? world.places[state.position] : null);
            if (!target) {
                const top = Object.values(world.places).filter(p => !p.parent);
                return {
                    world: this.index.worlds[worldId].name,
                    note: 'The player\'s position is not set. Use map_move to place them.',
                    top_level_places: top.map(p => `${p.name} (${LEVEL_LABELS[p.level]})`),
                    total_places: Object.keys(world.places).length,
                };
            }
            return { world: this.index.worlds[worldId].name, ...(await this.describePlace(world, target, state)) };
        });
    }

    search({ query, limit = 20 } = {}) {
        return this.run(async () => {
            const raw = String(query ?? '').trim();
            if (!raw) throw new Error('query is required.');
            const scope = this.scope();
            const state = this.chatState(scope);
            const worldId = this.worldIdFor(scope, state);
            if (!worldId) return { results: [], note: 'There is no map yet.' };
            const world = await this.loadWorld(worldId);
            const wanted = foldText(raw);
            const known = new Set(state.known);
            const results = Object.values(world.places)
                .filter(place => [place.name, place.type, place.summary, place.details, ...place.residents.map(r => `${r.name} ${r.description}`)]
                    .some(text => foldText(text).includes(wanted)))
                .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
                .map(place => ({
                    name: place.name,
                    path: this.pathOf(world, place.id).join(' › '),
                    level: place.level,
                    type: place.type || undefined,
                    summary: place.summary || undefined,
                    known_to_player: known.has(place.id),
                }));
            return { query: raw, results };
        });
    }

    // ---------- escrita (ferramentas) ----------

    /** Nível padrão do filho de um lugar. */
    childLevel(parent) {
        if (!parent) return 'world';
        return parent.level === 'world' ? 'region' : 'local';
    }

    validateParent(level, parent) {
        if (!parent) return;
        if (level === 'world') throw new Error('A world-level place cannot have a parent.');
        if (level === 'region' && parent.level !== 'world') throw new Error(`A region must be inside a world-level place ("${parent.name}" is ${parent.level}).`);
        if (level === 'local' && parent.level === 'world') throw new Error(`A local must be inside a region or another local ("${parent.name}" is a world-level place). Create the region first.`);
    }

    async linkEntries(input) {
        const links = [];
        for (const item of Array.isArray(input) ? input : input ? [input] : []) {
            if (!item?.book) continue;
            const entry = await this.lore.describeEntry(item.book, item.uid);
            links.push({ book: entry.book, uid: entry.uid, title: entry.title });
        }
        return links;
    }

    create({ name, level, parent, type, summary, details, secret, residents, connectTo, lorebookEntries, known = true, movePlayerHere = false, runId } = {}) {
        return this.run(async () => {
            const scope = this.scope();
            const placeName = clip(name, LIMITS.name);
            if (!placeName) throw new Error('"name" is required.');
            const { worldId, world, state } = await this.ensureWorld(scope, runId);

            let parentPlace = parent ? this.resolvePlace(world, parent, { position: state.position }) : null;
            let placeLevel = level ? normalizeLevel(level) : null;
            if (!placeLevel) placeLevel = parentPlace ? this.childLevel(parentPlace) : (Object.keys(world.places).length ? 'local' : 'world');
            if (!parentPlace && !parent && state.position) {
                // Sem pai informado: regiões ficam no mundo atual; locais, na região atual.
                if (placeLevel === 'region') parentPlace = this.ancestorAt(world, state.position, 'world');
                if (placeLevel === 'local') parentPlace = this.ancestorAt(world, state.position, 'region');
            }
            this.validateParent(placeLevel, parentPlace);
            const siblings = Object.values(world.places).filter(p => (p.parent ?? null) === (parentPlace?.id ?? null));
            const clash = siblings.find(p => foldText(p.name) === foldText(placeName));
            if (clash) throw new Error(`"${clash.name}" already exists here. Use map_update to change it.`);

            const lore = await this.linkEntries(lorebookEntries);
            await this.captureWorld(runId, worldId);
            const place = normalizePlace({
                id: generateId('l'),
                name: placeName,
                level: placeLevel,
                parent: parentPlace?.id ?? null,
                type,
                summary,
                details,
                secret,
                residents: parseResidents(residents),
                lore,
                createdAt: new Date().toISOString(),
            });
            world.places[place.id] = place;
            const connected = [];
            for (const link of Array.isArray(connectTo) ? connectTo : connectTo ? [connectTo] : []) {
                const other = this.resolvePlace(world, typeof link === 'string' ? link : link.place ?? link.to, { position: state.position });
                world.connections.push({
                    id: generateId('c'),
                    from: place.id,
                    to: other.id,
                    description: clip(typeof link === 'string' ? '' : link.description, LIMITS.connection),
                    twoWay: link?.two_way !== false && link?.twoWay !== false,
                    hidden: link?.hidden === true,
                    locked: link?.locked === true,
                });
                connected.push(other.name);
            }
            await this.saveWorld(worldId, world);
            await this.saveIndex();

            const nextState = this.chatState(scope);
            const becameKnown = known !== false || movePlayerHere;
            if (becameKnown || movePlayerHere) {
                await this.captureChat(runId, scope);
                if (becameKnown) nextState.known = [...new Set([...nextState.known, place.id])];
                if (movePlayerHere) nextState.position = place.id;
                await this.writeChatState(scope, nextState);
            }
            this.emit({ type: 'place', worldId });
            const result = { created: place.name, level: place.level, path: this.pathOf(world, place.id).join(' › ') };
            if (connected.length) result.connected_to = connected;
            if (movePlayerHere) result.player_moved_here = true;
            return result;
        });
    }

    update({ place, name, type, summary, details, secret, parent, addResidents, removeResidents, residents, linkLorebook, unlinkLorebook, known, runId } = {}) {
        return this.run(async () => {
            const scope = this.scope();
            const state = this.chatState(scope);
            const worldId = this.worldIdFor(scope, state);
            if (!worldId) throw new Error('There is no map yet. Use map_create first.');
            const world = await this.loadWorld(worldId);
            const target = this.resolvePlace(world, place ?? state.position, { position: state.position });
            const draft = structuredClone(target);
            const changed = [];
            if (name !== undefined && name !== null && clip(name, LIMITS.name)) { draft.name = clip(name, LIMITS.name); changed.push('name'); }
            for (const [field, value] of Object.entries({ type, summary, details, secret })) {
                if (value !== undefined && value !== null) { draft[field] = clip(value, LIMITS[field]); changed.push(field); }
            }
            if (parent !== undefined && parent !== null) {
                const newParent = parent === '' || foldText(parent) === 'none' ? null : this.resolvePlace(world, parent, { position: state.position });
                if (newParent && this.ancestors(world, newParent.id).some(p => p.id === target.id)) throw new Error('A place cannot be inside itself.');
                this.validateParent(draft.level, newParent);
                draft.parent = newParent?.id ?? null;
                changed.push('parent');
            }
            if (residents !== undefined && residents !== null) { draft.residents = parseResidents(residents); changed.push('residents'); }
            for (const resident of parseResidents(addResidents)) {
                const existing = draft.residents.find(r => foldText(r.name) === foldText(resident.name));
                if (existing) existing.description = resident.description || existing.description;
                else draft.residents.push(resident);
                changed.push('residents');
            }
            for (const resident of parseResidents(removeResidents)) {
                draft.residents = draft.residents.filter(r => foldText(r.name) !== foldText(resident.name));
                changed.push('residents');
            }
            for (const link of await this.linkEntries(linkLorebook)) {
                if (!draft.lore.some(l => l.book === link.book && l.uid === link.uid)) draft.lore.push(link);
                changed.push('lorebook');
            }
            for (const item of Array.isArray(unlinkLorebook) ? unlinkLorebook : unlinkLorebook ? [unlinkLorebook] : []) {
                draft.lore = draft.lore.filter(l => !(foldText(l.book) === foldText(item.book) && l.uid === Number(item.uid)));
                changed.push('lorebook');
            }
            if (changed.length) {
                await this.captureWorld(runId, worldId);
                world.places[target.id] = normalizePlace(draft);
                await this.saveWorld(worldId, world);
                await this.saveIndex();
            }
            if (known !== undefined && known !== null) {
                await this.captureChat(runId, scope);
                const set = new Set(state.known);
                if (known === true || known === 'true') set.add(target.id);
                else set.delete(target.id);
                await this.writeChatState(scope, { ...state, known: [...set] });
                changed.push('known');
            }
            if (!changed.length) throw new Error('Nothing to change.');
            this.emit({ type: 'place', worldId });
            return { updated: world.places[target.id].name, fields: [...new Set(changed)] };
        });
    }

    connect({ from, to, description, twoWay = true, hidden = false, locked = false, remove = false, runId } = {}) {
        return this.run(async () => {
            const scope = this.scope();
            const state = this.chatState(scope);
            const worldId = this.worldIdFor(scope, state);
            if (!worldId) throw new Error('There is no map yet. Use map_create first.');
            const world = await this.loadWorld(worldId);
            const a = this.resolvePlace(world, from ?? state.position, { position: state.position });
            const b = this.resolvePlace(world, to, { position: state.position });
            if (a.id === b.id) throw new Error('A place cannot connect to itself.');
            const existing = world.connections.find(c => (c.from === a.id && c.to === b.id) || (c.from === b.id && c.to === a.id));
            await this.captureWorld(runId, worldId);
            if (remove) {
                if (!existing) throw new Error(`"${a.name}" and "${b.name}" are not connected.`);
                world.connections = world.connections.filter(c => c !== existing);
                await this.saveWorld(worldId, world);
                this.emit({ type: 'place', worldId });
                return { removed: `${a.name} ↔ ${b.name}` };
            }
            if (existing) {
                existing.description = description !== undefined ? clip(description, LIMITS.connection) : existing.description;
                existing.twoWay = twoWay !== false;
                existing.hidden = hidden === true;
                existing.locked = locked === true;
            } else {
                world.connections.push({ id: generateId('c'), from: a.id, to: b.id, description: clip(description, LIMITS.connection), twoWay: twoWay !== false, hidden: hidden === true, locked: locked === true });
            }
            await this.saveWorld(worldId, world);
            this.emit({ type: 'place', worldId });
            return { connected: `${a.name} ${twoWay !== false ? '↔' : '→'} ${b.name}`, description: description || undefined, updated: Boolean(existing) };
        });
    }

    /** Move o jogador (padrão), um NPC com ficha (posição por chat) ou um residente (sem ficha). */
    move({ to, who, runId } = {}) {
        return this.run(async () => {
            const scope = this.scope();
            const { worldId, world, state } = await this.ensureWorld(scope, runId);
            const leaving = ['', 'none', 'nenhum', 'fora', 'off-map', 'away'].includes(foldText(to ?? ''));
            const destination = leaving ? null : this.resolvePlace(world, to, { position: state.position });
            const mover = String(who ?? '').trim();
            let isPlayer = !mover || ['player', 'jogador', 'eu', 'me', 'user', 'usuario'].includes(foldText(mover))
                || foldText(mover) === foldText(this.context().name1 ?? '');
            // Ficha com esse nome? A ficha do jogador conta como o jogador.
            const sheets = !isPlayer && this.system ? (await this.system.listSheets()).sheets : [];
            const sheet = sheets.find(s => foldText(s.name) === foldText(mover) || s.id === mover);
            if (sheet?.kind === 'player') isPlayer = true;

            if (isPlayer) {
                if (!destination) throw new Error('"to" is required to move the player.');
                await this.captureChat(runId, scope);
                const known = new Set(state.known);
                known.add(destination.id);
                for (const ancestor of this.ancestors(world, destination.id)) known.add(ancestor.id);
                await this.writeChatState(scope, { ...state, position: destination.id, known: [...known] });
                this.emit({ type: 'position', worldId });
                return { moved: 'player', to: destination.name, here: await this.describePlace(world, destination, this.chatState(scope), { full: false }) };
            }

            // NPC com ficha?
            if (sheet) {
                await this.captureChat(runId, scope);
                const npcs = { ...state.npcs };
                if (destination) npcs[sheet.id] = destination.id;
                else delete npcs[sheet.id];
                await this.writeChatState(scope, { ...state, npcs });
                this.emit({ type: 'position', worldId });
                return { moved: sheet.name, to: destination?.name ?? 'off the map' };
            }

            // Residente sem ficha: muda de lugar no mundo.
            const home = Object.values(world.places).find(p => p.residents.some(r => foldText(r.name) === foldText(mover)));
            if (!home) throw new Error(`"${mover}" is not the player, an NPC sheet or a resident of any place. Add them with map_update (add_residents) or sheet_create.`);
            const resident = home.residents.find(r => foldText(r.name) === foldText(mover));
            await this.captureWorld(runId, worldId);
            home.residents = home.residents.filter(r => r !== resident);
            if (destination) world.places[destination.id].residents.push(resident);
            await this.saveWorld(worldId, world);
            this.emit({ type: 'place', worldId });
            return { moved: resident.name, from: home.name, to: destination?.name ?? 'off the map' };
        });
    }

    deletePlace({ place, recursive = false, runId } = {}) {
        return this.run(async () => {
            const scope = this.scope();
            const state = this.chatState(scope);
            const worldId = this.worldIdFor(scope, state);
            if (!worldId) throw new Error('There is no map yet.');
            const world = await this.loadWorld(worldId);
            const target = this.resolvePlace(world, place, { position: state.position });
            const descendants = Object.values(world.places).filter(p => p.id !== target.id && this.ancestors(world, p.id).some(a => a.id === target.id));
            if (descendants.length && !recursive) {
                throw new Error(`"${target.name}" has ${descendants.length} place(s) inside. Pass recursive: true to delete them too, or move them first.`);
            }
            const removed = new Set([target.id, ...descendants.map(p => p.id)]);
            await this.captureWorld(runId, worldId);
            for (const id of removed) delete world.places[id];
            world.connections = world.connections.filter(c => !removed.has(c.from) && !removed.has(c.to));
            await this.saveWorld(worldId, world);
            if (removed.has(state.position) || Object.values(state.npcs).some(id => removed.has(id))) {
                await this.captureChat(runId, scope);
                const npcs = Object.fromEntries(Object.entries(state.npcs).filter(([, id]) => !removed.has(id)));
                await this.writeChatState(scope, { ...state, position: removed.has(state.position) ? null : state.position, npcs });
            }
            this.emit({ type: 'place', worldId });
            return { deleted: target.name, places_removed: removed.size };
        });
    }

    // ---------- prompt (bloco do local atual + lorebook por local) ----------

    /** Texto curto com onde o jogador está, saídas e quem está lá. Vazio se não houver posição. */
    promptBlock() {
        return this.run(async () => {
            const scope = this.scope();
            const state = this.chatState(scope);
            const worldId = this.worldIdFor(scope, state);
            if (!worldId || !state.position) return '';
            const world = await this.loadWorld(worldId);
            const place = world.places[state.position];
            if (!place) return '';
            const known = new Set(state.known);
            const lines = [`[Localização atual: ${this.pathOf(world, place.id).join(' › ')}${place.type ? ` (${place.type})` : ''}]`];
            if (place.summary) lines.push(place.summary);
            const inside = Object.values(world.places).filter(child => child.parent === place.id && known.has(child.id));
            if (inside.length) lines.push(`Lugares aqui dentro: ${inside.map(child => child.name).join('; ')}.`);
            const exits = this.exitsOf(world, place.id, known).filter(exit => !exit.connection.hidden);
            if (exits.length) {
                lines.push(`Saídas: ${exits.map(({ connection, place: other, known: isKnown }) => {
                    const notes = [connection.description, connection.locked ? 'trancada' : null, isKnown ? null : 'inexplorado'].filter(Boolean);
                    return `${other.name}${notes.length ? ` (${notes.join(', ')})` : ''}`;
                }).join('; ')}.`);
            }
            const present = [
                ...place.residents.map(r => (r.description ? `${r.name} (${r.description})` : r.name)),
                ...(await this.presentSheets(state, place.id)).map(sheet => sheet.name),
            ];
            if (present.length) lines.push(`Presentes: ${present.join('; ')}.`);
            return lines.join('\n');
        });
    }

    /** Entradas de lorebook a ativar agora: as do local atual e dos lugares acima, e as dos NPCs presentes. */
    forcedEntryRefs() {
        return this.run(async () => {
            const scope = this.scope();
            const state = this.chatState(scope);
            const worldId = this.worldIdFor(scope, state);
            if (!worldId || !state.position) return [];
            const world = await this.loadWorld(worldId);
            const refs = [];
            for (const place of this.ancestors(world, state.position)) refs.push(...place.lore);
            for (const sheet of await this.presentSheets(state, state.position)) {
                if (sheet.linked_lorebook_entry) refs.push(sheet.linked_lorebook_entry);
            }
            const seen = new Set();
            return refs.filter(ref => {
                const key = `${ref.book}#${ref.uid}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        });
    }

    // ---------- painel ----------

    snapshot() {
        return this.run(async () => {
            const scope = this.scope();
            const state = this.chatState(scope);
            const worldId = this.worldIdFor(scope, state);
            const world = worldId ? await this.loadWorld(worldId) : null;
            let sheets = [];
            try { sheets = this.system ? (await this.system.listSheets()).sheets : []; } catch { sheets = []; }
            return {
                hasChat: scope.hasChat,
                characterName: scope.characterName,
                worlds: Object.entries(this.index.worlds).map(([id, info]) => ({ id, ...info })).sort((a, b) => a.name.localeCompare(b.name)),
                worldId,
                world: world ? structuredClone(world) : null,
                state,
                sheets: sheets.filter(sheet => sheet.kind !== 'player').map(sheet => ({ id: sheet.id, name: sheet.name })),
                backups: worldId ? ((await this.storage.get(BACKUPS_TABLE, worldId))?.items ?? []).map(item => ({ at: item.at, label: item.label })) : [],
            };
        });
    }

    selectWorld(worldId) {
        return this.run(async () => {
            const scope = this.scope();
            if (!this.index.worlds[worldId]) throw new Error('Mundo não encontrado.');
            const state = this.chatState(scope);
            await this.writeChatState(scope, { ...state, worldId, position: state.worldId === worldId ? state.position : null, npcs: state.worldId === worldId ? state.npcs : {} });
            if (scope.charKey) this.index.characterDefaults[scope.charKey] = worldId;
            await this.saveIndex();
            this.emit({ type: 'world' });
        });
    }

    createWorld(name) {
        return this.run(async () => {
            const scope = this.scope();
            const id = await this.createWorldInternal(name);
            if (scope.hasChat) {
                await this.writeChatState(scope, { ...this.chatState(scope), worldId: id, position: null, npcs: {} });
                if (scope.charKey) this.index.characterDefaults[scope.charKey] = id;
                await this.saveIndex();
            }
            this.emit({ type: 'world' });
            return id;
        });
    }

    renameWorld(worldId, name) {
        return this.run(async () => {
            if (!this.index.worlds[worldId]) throw new Error('Mundo não encontrado.');
            const clean = clip(name, LIMITS.name);
            if (!clean) throw new Error('O nome é obrigatório.');
            this.index.worlds[worldId].name = clean;
            await this.saveIndex();
            this.emit({ type: 'world' });
        });
    }

    deleteWorld(worldId) {
        return this.run(async () => {
            delete this.index.worlds[worldId];
            for (const [key, value] of Object.entries(this.index.characterDefaults)) {
                if (value === worldId) delete this.index.characterDefaults[key];
            }
            this.worlds.delete(worldId);
            await this.storage.remove(WORLDS_TABLE, worldId);
            await this.storage.remove(BACKUPS_TABLE, worldId);
            await this.saveIndex();
            this.emit({ type: 'world' });
        });
    }

    /** Posição do jogador ou de um NPC com ficha, pelo painel. */
    setPosition({ placeId, sheetId = null }) {
        return this.run(async () => {
            const scope = this.scope();
            const state = this.chatState(scope);
            if (sheetId) {
                const npcs = { ...state.npcs };
                if (placeId) npcs[sheetId] = placeId;
                else delete npcs[sheetId];
                await this.writeChatState(scope, { ...state, npcs });
            } else {
                const known = new Set(state.known);
                if (placeId) {
                    known.add(placeId);
                    const worldId = this.worldIdFor(scope, state);
                    const world = worldId ? await this.loadWorld(worldId) : null;
                    if (world?.places[placeId]) for (const ancestor of this.ancestors(world, placeId)) known.add(ancestor.id);
                }
                await this.writeChatState(scope, { ...state, position: placeId || null, known: [...known] });
            }
            this.emit({ type: 'position' });
        });
    }

    /** Salva um lugar editado no painel (cria se não tiver id). */
    savePlace(input) {
        return this.run(async () => {
            const scope = this.scope();
            const { worldId, world } = await this.ensureWorld(scope);
            const existing = input.id ? world.places[input.id] : null;
            const parent = input.parent ? world.places[input.parent] : null;
            const level = existing?.level ?? normalizeLevel(input.level, parent ? this.childLevel(parent) : 'world');
            this.validateParent(level, parent);
            if (existing && parent && this.ancestors(world, parent.id).some(p => p.id === existing.id)) throw new Error('Um lugar não pode ficar dentro dele mesmo.');
            const name = clip(input.name, LIMITS.name);
            if (!name) throw new Error('O nome é obrigatório.');
            const clash = Object.values(world.places).find(p => p !== existing && (p.parent ?? null) === (parent?.id ?? null) && foldText(p.name) === foldText(name));
            if (clash) throw new Error(`Já existe "${clash.name}" aqui.`);
            const place = normalizePlace({
                ...(existing ?? { id: generateId('l'), createdAt: new Date().toISOString(), lore: [] }),
                name,
                level,
                parent: parent?.id ?? null,
                type: input.type,
                summary: input.summary,
                details: input.details,
                secret: input.secret,
                residents: parseResidents(input.residents),
                lore: input.lore ?? existing?.lore ?? [],
            });
            world.places[place.id] = place;
            await this.saveWorld(worldId, world);
            await this.saveIndex();
            this.emit({ type: 'place', worldId });
            return place.id;
        });
    }

    /** Conexão pelo painel. */
    saveConnection({ from, to, description, twoWay = true, hidden = false, locked = false }) {
        return this.run(async () => {
            const scope = this.scope();
            const { worldId, world } = await this.ensureWorld(scope);
            if (!world.places[from] || !world.places[to] || from === to) throw new Error('Escolha dois lugares diferentes.');
            const existing = world.connections.find(c => (c.from === from && c.to === to) || (c.from === to && c.to === from));
            if (existing) Object.assign(existing, { description: clip(description, LIMITS.connection), twoWay, hidden, locked });
            else world.connections.push({ id: generateId('c'), from, to, description: clip(description, LIMITS.connection), twoWay, hidden, locked });
            await this.saveWorld(worldId, world);
            this.emit({ type: 'place', worldId });
        });
    }

    removeConnection(connectionId) {
        return this.run(async () => {
            const scope = this.scope();
            const worldId = this.worldIdFor(scope);
            if (!worldId) return;
            const world = await this.loadWorld(worldId);
            world.connections = world.connections.filter(c => c.id !== connectionId);
            await this.saveWorld(worldId, world);
            this.emit({ type: 'place', worldId });
        });
    }

    removePlaceUi(placeId) {
        return this.run(async () => {
            const scope = this.scope();
            const worldId = this.worldIdFor(scope);
            const world = await this.loadWorld(worldId);
            const doomed = new Set([placeId, ...Object.values(world.places).filter(p => this.ancestors(world, p.id).some(a => a.id === placeId)).map(p => p.id)]);
            for (const id of doomed) delete world.places[id];
            world.connections = world.connections.filter(c => !doomed.has(c.from) && !doomed.has(c.to));
            await this.saveWorld(worldId, world);
            const state = this.chatState(scope);
            if (doomed.has(state.position)) await this.writeChatState(scope, { ...state, position: null });
            this.emit({ type: 'place', worldId });
            return doomed.size;
        });
    }

    // ---------- auto-preencher / refinar ----------

    /** Resumo do mapa atual para mandar à IA. */
    outline() {
        return this.run(async () => {
            const scope = this.scope();
            const worldId = this.worldIdFor(scope);
            if (!worldId) return { worldName: null, text: '(empty map)', count: 0 };
            const world = await this.loadWorld(worldId);
            const lines = [];
            const walk = (parentId, depth) => {
                for (const place of Object.values(world.places).filter(p => (p.parent ?? null) === parentId).sort((a, b) => a.name.localeCompare(b.name))) {
                    lines.push(`${'  '.repeat(depth)}- [${place.level}] ${place.name}${place.type ? ` (${place.type})` : ''}${place.summary ? `: ${place.summary.slice(0, 160)}` : ''}`);
                    walk(place.id, depth + 1);
                }
            };
            walk(null, 0);
            for (const c of world.connections) {
                lines.push(`* ${world.places[c.from].name} ${c.twoWay ? '<->' : '->'} ${world.places[c.to].name}${c.description ? `: ${c.description}` : ''}`);
            }
            return { worldName: this.index.worlds[worldId].name, text: lines.join('\n') || '(empty map)', count: Object.keys(world.places).length };
        });
    }

    /**
     * Compara um plano vindo da IA com o mapa e devolve o que mudaria, sem gravar.
     * Plano: { places: [{ name, level, parent, type, summary, details, secret, residents }], connections: [{ from, to, description, two_way }] }
     */
    previewPlan(plan, mode = 'fill') {
        return this.run(async () => this.computePlan(plan, mode, await this.currentWorldCopy()));
    }

    async currentWorldCopy() {
        const scope = this.scope();
        const worldId = this.worldIdFor(scope);
        return worldId ? structuredClone(await this.loadWorld(worldId)) : { places: {}, connections: [] };
    }

    computePlan(plan, mode, world) {
        const created = [];
        const updated = [];
        const connections = [];
        const problems = [];
        const byName = name => {
            const wanted = foldText(name);
            return Object.values(world.places).filter(p => foldText(p.name) === wanted);
        };
        const items = Array.isArray(plan?.places) ? plan.places : [];
        const order = { world: 0, region: 1, local: 2 };
        const sorted = [...items].filter(item => item?.name).sort((a, b) => (order[normalizeLevel(a.level)] ?? 2) - (order[normalizeLevel(b.level)] ?? 2));
        for (const item of sorted) {
            const level = normalizeLevel(item.level);
            const parentMatches = item.parent ? byName(item.parent) : [];
            const parent = parentMatches.length === 1 ? parentMatches[0] : null;
            if (item.parent && !parent) {
                problems.push(`"${item.name}": pai "${item.parent}" não encontrado; ficou sem pai.`);
            }
            const existing = byName(item.name).find(p => !parent || p.parent === parent.id) ?? null;
            if (existing) {
                const fields = {};
                for (const field of ['type', 'summary', 'details', 'secret']) {
                    const value = clip(item[field], LIMITS[field]);
                    if (!value) continue;
                    // Preencher só completa campos vazios; refinar pode reescrever.
                    if (mode === 'refine' ? value !== existing[field] : !existing[field]) fields[field] = value;
                }
                const residents = parseResidents(item.residents).filter(r => !existing.residents.some(e => foldText(e.name) === foldText(r.name)));
                if (residents.length) fields.residents = [...existing.residents, ...residents];
                if (Object.keys(fields).length) {
                    Object.assign(existing, fields);
                    updated.push({ name: existing.name, fields: Object.keys(fields) });
                }
                continue;
            }
            let validParent = parent;
            try {
                this.validateParent(level, validParent);
            } catch (error) {
                problems.push(`"${item.name}": ${error.message} Ficou sem pai.`);
                validParent = null;
            }
            const place = normalizePlace({
                id: generateId('l'),
                name: item.name,
                level,
                parent: validParent?.id ?? null,
                type: item.type,
                summary: item.summary,
                details: item.details,
                secret: item.secret,
                residents: parseResidents(item.residents),
                createdAt: new Date().toISOString(),
            });
            world.places[place.id] = place;
            created.push({ name: place.name, level: place.level, parent: validParent?.name ?? null });
        }
        for (const link of Array.isArray(plan?.connections) ? plan.connections : []) {
            const [a] = byName(link?.from ?? '');
            const [b] = byName(link?.to ?? '');
            if (!a || !b || a.id === b.id) {
                problems.push(`Conexão ignorada: ${link?.from} → ${link?.to}.`);
                continue;
            }
            if (world.connections.some(c => (c.from === a.id && c.to === b.id) || (c.from === b.id && c.to === a.id))) continue;
            world.connections.push({ id: generateId('c'), from: a.id, to: b.id, description: clip(link.description, LIMITS.connection), twoWay: link.two_way !== false && link.twoWay !== false, hidden: false, locked: false });
            connections.push(`${a.name} ${link.two_way === false ? '→' : '↔'} ${b.name}`);
        }
        return { created, updated, connections, problems, world };
    }

    /** Aplica um plano (guardando antes uma cópia do mapa para "desfazer preenchimento"). */
    applyPlan(plan, mode = 'fill', label = 'Preenchimento') {
        return this.run(async () => {
            const scope = this.scope();
            const { worldId, world } = await this.ensureWorld(scope);
            const backups = (await this.storage.get(BACKUPS_TABLE, worldId))?.items ?? [];
            backups.unshift({ at: new Date().toISOString(), label, data: structuredClone(world) });
            await this.storage.set(BACKUPS_TABLE, worldId, { items: backups.slice(0, MAX_FILL_BACKUPS) });
            const result = this.computePlan(plan, mode, structuredClone(world));
            await this.saveWorld(worldId, normalizeWorld(result.world));
            await this.saveIndex();
            this.emit({ type: 'place', worldId });
            return { created: result.created.length, updated: result.updated.length, connections: result.connections.length, problems: result.problems };
        });
    }

    undoLastFill() {
        return this.run(async () => {
            const scope = this.scope();
            const worldId = this.worldIdFor(scope);
            if (!worldId) throw new Error('Nenhum mundo neste chat.');
            const backups = (await this.storage.get(BACKUPS_TABLE, worldId))?.items ?? [];
            const [last, ...rest] = backups;
            if (!last) throw new Error('Não há preenchimento para desfazer.');
            await this.saveWorld(worldId, normalizeWorld(last.data));
            await this.storage.set(BACKUPS_TABLE, worldId, { items: rest });
            await this.saveIndex();
            this.emit({ type: 'place', worldId });
            return last.label;
        });
    }
}
