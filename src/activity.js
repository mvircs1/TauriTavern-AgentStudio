// Registro das chamadas de ferramenta feitas pelo Agent, para o usuário ver o que mudou.

import { LOG_PREFIX } from './util.js';

const TABLE = 'meta';
const KEY = 'activity';
const MAX_ITEMS = 200;
const SAVE_DELAY_MS = 1500;

export class ActivityLog {
    /** @param {import('./storage.js').Storage} storage */
    constructor(storage) {
        this.storage = storage;
        this.items = [];
        this.loaded = false;
        this.saveTimer = null;
        this.listeners = new Set();
    }

    async load() {
        if (this.loaded) return;
        try {
            const stored = await this.storage.get(TABLE, KEY);
            if (Array.isArray(stored?.items)) this.items = stored.items.slice(0, MAX_ITEMS);
        } catch (error) {
            console.warn(LOG_PREFIX, 'Não consegui carregar o registro de atividade', error);
        }
        this.loaded = true;
    }

    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    add({ tool, ok, summary, error, runId }) {
        this.items.unshift({
            at: new Date().toISOString(),
            tool,
            ok,
            summary: summary ?? null,
            error: error ?? null,
            runId: runId ?? null,
        });
        if (this.items.length > MAX_ITEMS) this.items.length = MAX_ITEMS;
        this.scheduleSave();
        for (const listener of this.listeners) {
            try { listener(); } catch (e) { console.error(LOG_PREFIX, e); }
        }
    }

    list() {
        return [...this.items];
    }

    clear() {
        this.items = [];
        this.scheduleSave();
        for (const listener of this.listeners) {
            try { listener(); } catch (e) { console.error(LOG_PREFIX, e); }
        }
    }

    scheduleSave() {
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.storage.set(TABLE, KEY, { items: this.items }).catch(error => {
                console.warn(LOG_PREFIX, 'Não consegui salvar o registro de atividade', error);
            });
        }, SAVE_DELAY_MS);
    }
}
