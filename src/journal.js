// Diário de alterações por run do Agent: antes da primeira mudança em cada coisa (arquivo, lorebook,
// ficha, mapa, campanha), guarda o estado anterior. Assim dá para desfazer tudo o que uma run fez quando
// a resposta dela é descartada (regenerar, nova swipe, run com erro ou cancelada).
//
// Ao desfazer, também guarda o estado "depois" (como a run deixou as coisas). Se o usuário voltar para a
// swipe daquela run, o estado dela é refeito, e o da swipe que estava na tela é desfeito.

import { createSerialQueue, LOG_PREFIX } from './util.js';

const META_TABLE = 'meta';
const INDEX_KEY = 'journals';
const ENTRIES_TABLE = 'journal';
const MAX_RUNS = 100;

export class RunJournal {
    /**
     * @param {import('./storage.js').Storage} storage
     * @param {{ getChatId: () => string|null }} options
     */
    constructor(storage, { getChatId }) {
        this.storage = storage;
        this.getChatId = getChatId;
        this.enqueue = createSerialQueue();
        /** runKey -> { runId, chatId, startedAt, status: 'active'|'undone', runStatus, redoable } */
        this.index = null;
        /** runKey -> { runId, entries: [], redo: []|null } (cache) */
        this.entries = new Map();
        /** Chamado quando aparece uma run nova (para acompanhar o fim dela). */
        this.onNewRun = null;
    }

    runKey(runId) {
        return `r-${String(runId).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 150)}`;
    }

    async load() {
        if (this.index) return;
        const stored = await this.storage.get(META_TABLE, INDEX_KEY);
        this.index = stored?.items && typeof stored.items === 'object' ? stored.items : {};
    }

    async saveIndex() {
        await this.storage.set(META_TABLE, INDEX_KEY, { items: this.index });
    }

    async loadEntries(key) {
        if (this.entries.has(key)) return this.entries.get(key);
        const stored = await this.storage.get(ENTRIES_TABLE, key);
        const record = stored && Array.isArray(stored.entries) ? stored : { entries: [] };
        this.entries.set(key, record);
        return record;
    }

    /**
     * Registra o estado anterior de algo, só na primeira vez que a run mexe nele.
     * `factory` precisa ler o estado ANTES da mudança; quem chama espera esta promessa antes de alterar.
     */
    capture(runId, key, factory) {
        if (!runId) return Promise.resolve();
        return this.enqueue(async () => {
            await this.load();
            const runKey = this.runKey(runId);
            let run = this.index[runKey];
            const isNew = !run;
            if (!run) {
                run = { runId, chatId: this.getChatId(), startedAt: new Date().toISOString(), status: 'active', runStatus: null };
                this.index[runKey] = run;
            } else if (run.status === 'undone') {
                // A run continuou depois de desfeita (raro): volta a registrar do zero.
                run.status = 'active';
                run.redoable = false;
                this.entries.set(runKey, { runId, entries: [], redo: null });
            }
            const record = await this.loadEntries(runKey);
            record.runId = runId;
            if (record.entries.some(entry => entry.key === key)) return;
            const entry = await factory();
            if (!entry) return;
            record.entries.push({ key, at: new Date().toISOString(), ...entry });
            await this.storage.set(ENTRIES_TABLE, runKey, record);
            if (isNew) await this.prune();
            await this.saveIndex();
            if (isNew) {
                try { this.onNewRun?.(runId); } catch (error) { console.warn(LOG_PREFIX, error); }
            }
        });
    }

    async prune() {
        const keys = Object.keys(this.index);
        if (keys.length <= MAX_RUNS) return;
        const sorted = keys.sort((a, b) => String(this.index[a].startedAt).localeCompare(String(this.index[b].startedAt)));
        for (const key of sorted.slice(0, keys.length - MAX_RUNS)) {
            delete this.index[key];
            this.entries.delete(key);
            await this.storage.remove(ENTRIES_TABLE, key);
        }
    }

    getRun(runId) {
        return this.enqueue(async () => {
            await this.load();
            const run = this.index[this.runKey(runId)];
            return run ? { ...run } : null;
        });
    }

    setRunStatus(runId, runStatus) {
        return this.enqueue(async () => {
            await this.load();
            const run = this.index[this.runKey(runId)];
            if (!run) return;
            run.runStatus = runStatus;
            await this.saveIndex();
        });
    }

    /** As runs da lista que estão no estado pedido ('active' ou 'undone'), da mais nova para a mais antiga. */
    collect(runIds, status) {
        return this.enqueue(async () => {
            await this.load();
            const runs = [];
            for (const runId of new Set(runIds)) {
                const key = this.runKey(runId);
                const run = this.index[key];
                if (!run || run.status !== status) continue;
                const record = await this.loadEntries(key);
                runs.push({
                    runId: run.runId,
                    chatId: run.chatId,
                    startedAt: run.startedAt,
                    entries: [...record.entries],
                    redo: Array.isArray(record.redo) ? [...record.redo] : null,
                });
            }
            runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
            return runs;
        });
    }

    /** Grava o novo estado de uma run depois de desfazer (redo = como a run deixou) ou refazer (entries = o antes). */
    store(runId, status, { entries = [], redo = null } = {}) {
        return this.enqueue(async () => {
            await this.load();
            const key = this.runKey(runId);
            const run = this.index[key];
            if (!run) return;
            run.status = status;
            run.redoable = Array.isArray(redo) && redo.length > 0;
            if (status === 'undone') run.undoneAt = new Date().toISOString();
            else run.redoneAt = new Date().toISOString();
            const record = { runId, entries, redo };
            this.entries.set(key, record);
            if (entries.length || record.redo?.length) await this.storage.set(ENTRIES_TABLE, key, record);
            else await this.storage.remove(ENTRIES_TABLE, key);
            await this.saveIndex();
        });
    }
}

const TERMINAL_EVENTS = new Set(['run_completed', 'run_partial_success', 'run_cancelled', 'run_failed']);

function runIdOf(extra) {
    const runId = extra?.tauritavern?.agent?.runId;
    return typeof runId === 'string' && runId ? runId : null;
}

/** Ids das runs do Agent que geraram uma mensagem (inclusive as outras swipes dela). */
export function runIdsOfMessage(message) {
    const ids = new Set();
    const add = extra => {
        const runId = runIdOf(extra);
        if (runId) ids.add(runId);
    };
    add(message?.extra);
    if (Array.isArray(message?.swipe_info)) {
        for (const info of message.swipe_info) add(info?.extra);
    }
    return [...ids];
}

/**
 * A run da swipe que está na tela. Numa swipe nova (ainda gerando) não há nenhuma: o `extra` da mensagem
 * ainda é o da swipe anterior, então só vale o `swipe_info` da swipe atual.
 */
export function currentRunIdOfMessage(message) {
    if (!message) return null;
    if (Array.isArray(message.swipe_info) && Number.isInteger(message.swipe_id)) {
        const info = message.swipe_info[message.swipe_id];
        return info ? runIdOf(info.extra) ?? runIdOf(message.extra) : null;
    }
    return runIdOf(message.extra);
}

const PART_LABELS = { files: 'arquivo(s)', lorebooks: 'lorebook(s)', sheets: 'ficha(s)', map: 'mapa', campaign: 'campanha' };

/**
 * Desfaz e refaz as alterações das runs:
 * - ao regenerar ou gerar uma nova swipe (evento GENERATION_STARTED, antes de o prompt ser montado), desfaz;
 * - ao trocar de swipe (MESSAGE_SWIPED), desfaz a run das outras swipes e refaz a da swipe que ficou na tela;
 * - quando uma run falha ou é cancelada sem deixar mensagem no chat, desfaz.
 */
export class RollbackManager {
    constructor({ journal, fs, lore, system, map = null, campaign = null, activity, getSettings }) {
        this.journal = journal;
        this.activity = activity;
        this.getSettings = getSettings;
        this.watching = new Map();
        this.queue = createSerialQueue();
        /** chatId:índice -> runs já vistas naquela mensagem (para quando uma swipe é apagada). */
        this.seen = new Map();
        // Cada serviço sabe tirar um retrato do estado atual (snapshotEntries) e restaurar um retrato.
        this.services = [
            { part: 'files', service: fs, match: kind => kind.startsWith('studio_'), restore: (s, e) => s.undoEntries(e) },
            { part: 'lorebooks', service: lore, match: kind => kind.startsWith('lorebook'), restore: (s, e) => s.undoEntries(e) },
            {
                part: 'sheets', service: system, match: kind => kind === 'sheet',
                restore: async (s, e, chatId) => (await s.undoEntries(e, chatId)).restored,
            },
            { part: 'map', service: map, match: kind => kind.startsWith('map_'), restore: (s, e, chatId) => s.undoEntries(e, chatId) },
            { part: 'campaign', service: campaign, match: kind => kind === 'campaign', restore: (s, e, chatId) => s.undoEntries(e, chatId) },
        ].filter(item => item.service);
    }

    enabled() {
        return this.getSettings().undoOnRegenerate !== false;
    }

    install() {
        this.journal.onNewRun = runId => this.watchRun(runId);
        const context = SillyTavern.getContext();
        const types = context.eventTypes ?? context.event_types;
        if (!context.eventSource || !types?.GENERATION_STARTED) {
            console.warn(LOG_PREFIX, 'Evento GENERATION_STARTED indisponível; o desfazer ao regenerar fica desligado.');
            return;
        }
        context.eventSource.on(types.GENERATION_STARTED, (type, options, dryRun) => this.onGenerationStarted(type, dryRun));
        if (types.MESSAGE_SWIPED) context.eventSource.on(types.MESSAGE_SWIPED, messageId => this.onSwiped(messageId));
        for (const name of ['MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED']) {
            if (types[name]) context.eventSource.on(types[name], messageId => { this.remember(messageId); });
        }
    }

    messageKey(index) {
        return `${SillyTavern.getContext().getCurrentChatId?.() ?? ''}:${index}`;
    }

    /** Guarda as runs de uma mensagem (se uma swipe for apagada, a run dela continua conhecida). */
    remember(messageId) {
        try {
            const chat = SillyTavern.getContext().chat;
            const index = Number(messageId);
            const message = Array.isArray(chat) ? chat[index] : null;
            if (!message || message.is_user) return [];
            const key = this.messageKey(index);
            const known = this.seen.get(key) ?? new Set();
            for (const runId of runIdsOfMessage(message)) known.add(runId);
            this.seen.set(key, known);
            if (this.seen.size > 200) this.seen.delete(this.seen.keys().next().value);
            return [...known];
        } catch {
            return [];
        }
    }

    async onGenerationStarted(type, dryRun) {
        if (dryRun || !this.enabled() || (type !== 'regenerate' && type !== 'swipe')) return;
        try {
            const chat = SillyTavern.getContext().chat;
            const last = Array.isArray(chat) ? chat[chat.length - 1] : null;
            if (!last || last.is_user) return;
            const runIds = this.remember(chat.length - 1);
            if (runIds.length) await this.undo(runIds, type === 'swipe' ? 'nova swipe' : 'regeneração');
        } catch (error) {
            console.error(LOG_PREFIX, 'Falha ao desfazer as alterações da resposta descartada', error);
            globalThis.toastr?.error?.(String(error?.message ?? error), 'Agent Studio: falha ao desfazer');
        }
    }

    /** Troca de swipe na última mensagem: a swipe na tela manda no estado do estúdio, fichas, mapa e campanha. */
    async onSwiped(messageId) {
        if (!this.enabled()) return;
        try {
            const chat = SillyTavern.getContext().chat;
            const index = Number(messageId);
            if (!Array.isArray(chat) || index !== chat.length - 1) return;
            const message = chat[index];
            if (!message || message.is_user) return;
            const all = this.remember(index);
            const target = currentRunIdOfMessage(message);
            const others = all.filter(runId => runId !== target);
            const out = others.length ? await this.swapOut(others, { silent: true }) : null;
            const back = target ? await this.swapIn(target, { silent: true }) : null;
            const parts = [];
            if (out?.parts.length) parts.push(`desfeito ${out.parts.join(', ')}`);
            if (back?.parts.length) parts.push(`refeito ${back.parts.join(', ')}`);
            if (parts.length) {
                const summary = `Troca de swipe: ${parts.join('; ')}`;
                this.activity.add({ tool: 'undo', ok: true, summary });
                globalThis.toastr?.info?.(`${summary}.`, 'Agent Studio');
            } else if (back?.missing) {
                globalThis.toastr?.warning?.('O que esta resposta fez no estúdio não pode ser refeito (ela é de antes da v0.8, ou de outro chat).', 'Agent Studio');
            }
        } catch (error) {
            console.error(LOG_PREFIX, 'Falha ao trocar o estado da swipe', error);
            globalThis.toastr?.error?.(String(error?.message ?? error), 'Agent Studio: falha ao trocar de swipe');
        }
    }

    /** Acompanha a run até o fim, para desfazer se ela falhar ou for cancelada. */
    watchRun(runId) {
        const agent = globalThis.__TAURITAVERN__?.api?.agent;
        if (typeof agent?.subscribe !== 'function' || this.watching.has(runId)) return;
        let stop = null;
        const finish = async eventType => {
            stop?.();
            this.watching.delete(runId);
            await this.journal.setRunStatus(runId, eventType);
            if ((eventType === 'run_failed' || eventType === 'run_cancelled') && this.enabled() && !this.chatHasRun(runId)) {
                await this.undo([runId], eventType === 'run_failed' ? 'run com erro' : 'run cancelada');
            }
        };
        try {
            stop = agent.subscribe(runId, event => {
                if (TERMINAL_EVENTS.has(event?.type)) {
                    finish(event.type).catch(error => console.error(LOG_PREFIX, error));
                }
            }, { onError: error => console.warn(LOG_PREFIX, 'Falha ao acompanhar a run', error) });
            this.watching.set(runId, stop);
        } catch (error) {
            console.warn(LOG_PREFIX, 'Não consegui acompanhar a run', error);
        }
    }

    chatHasRun(runId) {
        const chat = SillyTavern.getContext().chat;
        if (!Array.isArray(chat)) return false;
        return chat.slice(-20).some(message => runIdsOfMessage(message).includes(runId));
    }

    async snapshot(entries) {
        const result = [];
        for (const { service, match } of this.services) {
            const own = entries.filter(entry => match(entry.kind));
            if (own.length && typeof service.snapshotEntries === 'function') result.push(...await service.snapshotEntries(own));
        }
        return result;
    }

    async restore(entries, chatId) {
        const totals = {};
        for (const { part, service, match, restore } of this.services) {
            const own = entries.filter(entry => match(entry.kind));
            if (own.length) totals[part] = (totals[part] ?? 0) + (Number(await restore(service, own, chatId)) || 0);
        }
        return totals;
    }

    static describe(totals) {
        return Object.entries(totals)
            .filter(([, count]) => count)
            .map(([part, count]) => (part === 'map' || part === 'campaign' ? PART_LABELS[part] : `${count} ${PART_LABELS[part]}`));
    }

    /** Desfaz runs ativas e guarda como elas deixaram as coisas (para refazer). */
    swapOut(runIds, { silent = false, reason = '' } = {}) {
        return this.queue(async () => {
            const runs = await this.journal.collect(runIds, 'active');
            if (!runs.length) return null;
            const totals = {};
            const chatId = SillyTavern.getContext().getCurrentChatId?.() ?? null;
            for (const run of runs) {
                // Só dá para refazer no mesmo chat (fichas, mapa e campanha do chat ficam nele).
                const redo = !run.chatId || run.chatId === chatId ? await this.snapshot(run.entries) : null;
                const restored = await this.restore(run.entries, run.chatId);
                for (const [part, count] of Object.entries(restored)) totals[part] = (totals[part] ?? 0) + count;
                await this.journal.store(run.runId, 'undone', { entries: [], redo });
            }
            const parts = RollbackManager.describe(totals);
            if (!silent && parts.length) {
                const summary = `Desfeito (${reason}): ${parts.join(', ')}`;
                this.activity.add({ tool: 'undo', ok: true, summary });
                globalThis.toastr?.info?.(`${summary}.`, 'Agent Studio');
            }
            return { totals, parts };
        });
    }

    /** Refaz uma run desfeita (a swipe dela voltou para a tela). */
    swapIn(runId, { silent = false } = {}) {
        return this.queue(async () => {
            const [run] = await this.journal.collect([runId], 'undone');
            if (!run) return null;
            if (!run.redo?.length) return { totals: {}, parts: [], missing: !run.redo };
            const before = await this.snapshot(run.redo);
            const totals = await this.restore(run.redo, run.chatId);
            await this.journal.store(run.runId, 'active', { entries: before, redo: null });
            const parts = RollbackManager.describe(totals);
            if (!silent && parts.length) {
                const summary = `Refeito: ${parts.join(', ')}`;
                this.activity.add({ tool: 'undo', ok: true, summary });
                globalThis.toastr?.info?.(`${summary}.`, 'Agent Studio');
            }
            return { totals, parts };
        });
    }

    /** Desfaz as runs indicadas (as já desfeitas são ignoradas). */
    async undo(runIds, reason) {
        const result = await this.swapOut(runIds, { reason });
        if (!result) return null;
        return {
            files: result.totals.files ?? 0,
            lorebooks: result.totals.lorebooks ?? 0,
            sheets: result.totals.sheets ?? 0,
            map: result.totals.map ?? 0,
            campaign: result.totals.campaign ?? 0,
        };
    }
}
