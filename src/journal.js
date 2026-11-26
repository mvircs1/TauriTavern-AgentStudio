// Diário de alterações por run do Agent: antes da primeira mudança em cada coisa (arquivo, lorebook,
// ficha), guarda o estado anterior. Assim dá para desfazer tudo o que uma run fez quando a resposta
// dela é descartada (regenerar, nova swipe, run com erro ou cancelada).

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
        /** runKey -> { runId, chatId, startedAt, status: 'active'|'undone', runStatus } */
        this.index = null;
        /** runKey -> { runId, entries: [] } (cache) */
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
                this.entries.set(runKey, { runId, entries: [] });
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

    /** Devolve as entradas das runs ainda ativas (da mais nova para a mais antiga) e marca como desfeitas. */
    takeForUndo(runIds) {
        return this.enqueue(async () => {
            await this.load();
            const runs = [];
            for (const runId of new Set(runIds)) {
                const key = this.runKey(runId);
                const run = this.index[key];
                if (!run || run.status !== 'active') continue;
                const record = await this.loadEntries(key);
                runs.push({ key, run, entries: [...record.entries] });
            }
            runs.sort((a, b) => String(b.run.startedAt).localeCompare(String(a.run.startedAt)));
            for (const { key, run } of runs) {
                run.status = 'undone';
                run.undoneAt = new Date().toISOString();
                this.entries.set(key, { runId: run.runId, entries: [] });
                await this.storage.remove(ENTRIES_TABLE, key);
            }
            if (runs.length) await this.saveIndex();
            return runs.map(({ run, entries }) => ({ runId: run.runId, chatId: run.chatId, entries }));
        });
    }
}

const TERMINAL_EVENTS = new Set(['run_completed', 'run_partial_success', 'run_cancelled', 'run_failed']);

/** Ids das runs do Agent que geraram uma mensagem (inclusive as outras swipes dela). */
export function runIdsOfMessage(message) {
    const ids = new Set();
    const read = extra => {
        const runId = extra?.tauritavern?.agent?.runId;
        if (typeof runId === 'string' && runId) ids.add(runId);
    };
    read(message?.extra);
    if (Array.isArray(message?.swipe_info)) {
        for (const info of message.swipe_info) read(info?.extra);
    }
    return [...ids];
}

/**
 * Desfaz as alterações de runs descartadas:
 * - ao regenerar ou gerar uma nova swipe (evento GENERATION_STARTED, antes de o prompt ser montado);
 * - quando uma run falha ou é cancelada sem deixar mensagem no chat.
 */
export class RollbackManager {
    constructor({ journal, fs, lore, system, map = null, activity, getSettings }) {
        this.journal = journal;
        this.fs = fs;
        this.lore = lore;
        this.system = system;
        this.map = map;
        this.activity = activity;
        this.getSettings = getSettings;
        this.watching = new Map();
    }

    enabled() {
        return this.getSettings().undoOnRegenerate !== false;
    }

    install() {
        this.journal.onNewRun = runId => this.watchRun(runId);
        const context = SillyTavern.getContext();
        const types = context.eventTypes ?? context.event_types;
        if (context.eventSource && types?.GENERATION_STARTED) {
            context.eventSource.on(types.GENERATION_STARTED, (type, options, dryRun) => this.onGenerationStarted(type, dryRun));
        } else {
            console.warn(LOG_PREFIX, 'Evento GENERATION_STARTED indisponível; o desfazer ao regenerar fica desligado.');
        }
    }

    async onGenerationStarted(type, dryRun) {
        if (dryRun || !this.enabled() || (type !== 'regenerate' && type !== 'swipe')) return;
        try {
            const chat = SillyTavern.getContext().chat;
            const last = Array.isArray(chat) ? chat[chat.length - 1] : null;
            if (!last || last.is_user) return;
            const runIds = runIdsOfMessage(last);
            if (runIds.length) await this.undo(runIds, type === 'swipe' ? 'nova swipe' : 'regeneração');
        } catch (error) {
            console.error(LOG_PREFIX, 'Falha ao desfazer as alterações da resposta descartada', error);
            globalThis.toastr?.error?.(String(error?.message ?? error), 'Agent Studio: falha ao desfazer');
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

    /** Desfaz as runs indicadas (as já desfeitas são ignoradas). */
    async undo(runIds, reason) {
        const runs = await this.journal.takeForUndo(runIds);
        if (!runs.length) return null;
        const totals = { files: 0, lorebooks: 0, sheets: 0, map: 0, skipped: 0 };
        for (const run of runs) {
            const studio = run.entries.filter(entry => entry.kind.startsWith('studio_'));
            const lore = run.entries.filter(entry => entry.kind.startsWith('lorebook'));
            const sheets = run.entries.filter(entry => entry.kind === 'sheet');
            const map = run.entries.filter(entry => entry.kind.startsWith('map_'));
            if (studio.length) totals.files += await this.fs.undoEntries(studio);
            if (lore.length) totals.lorebooks += await this.lore.undoEntries(lore);
            if (sheets.length) {
                const result = await this.system.undoEntries(sheets, run.chatId);
                totals.sheets += result.restored;
                totals.skipped += result.skipped;
            }
            if (map.length && this.map) totals.map += await this.map.undoEntries(map, run.chatId);
        }
        const parts = [];
        if (totals.files) parts.push(`${totals.files} arquivo(s)`);
        if (totals.lorebooks) parts.push(`${totals.lorebooks} lorebook(s)`);
        if (totals.sheets) parts.push(`${totals.sheets} ficha(s)`);
        if (totals.map) parts.push('mapa');
        if (parts.length) {
            const summary = `Desfeito (${reason}): ${parts.join(', ')}`;
            this.activity.add({ tool: 'undo', ok: true, summary });
            globalThis.toastr?.info?.(`${summary}.`, 'Agent Studio');
        }
        if (totals.skipped) {
            console.warn(LOG_PREFIX, `${totals.skipped} ficha(s) de outro chat não foram desfeitas.`);
        }
        return totals;
    }
}
