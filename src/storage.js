// Armazenamento persistente do plugin.
// No TauriTavern usa window.__TAURITAVERN__.api.extension.store (arquivos JSON na pasta de dados,
// entram no backup do TT). Fora dele (SillyTavern no navegador) cai para o localforage (IndexedDB).

import { LOG_PREFIX } from './util.js';

const NAMESPACE = 'agent_studio';

/**
 * @typedef {object} Storage
 * @property {'tauritavern'|'browser'} kind
 * @property {(table: string, key: string) => Promise<any>} get  undefined se não existir
 * @property {(table: string, key: string, value: any) => Promise<void>} set
 * @property {(table: string, key: string) => Promise<void>} remove
 */

/** @returns {Storage} */
export function createStorage() {
    const store = globalThis.__TAURITAVERN__?.api?.extension?.store;
    if (store && typeof store.tryGetJson === 'function') {
        return createHostStorage(store);
    }
    return createBrowserStorage();
}

function createHostStorage(store) {
    return {
        kind: 'tauritavern',
        async get(table, key) {
            const result = await store.tryGetJson({ namespace: NAMESPACE, table, key });
            return result?.found ? result.value : undefined;
        },
        async set(table, key, value) {
            await store.setJson({ namespace: NAMESPACE, table, key, value });
        },
        async remove(table, key) {
            const existing = await store.tryGetJson({ namespace: NAMESPACE, table, key });
            if (!existing?.found) return;
            await store.deleteJson({ namespace: NAMESPACE, table, key });
        },
    };
}

function createBrowserStorage() {
    const localforage = globalThis.SillyTavern?.libs?.localforage;
    if (!localforage) {
        console.warn(LOG_PREFIX, 'Nenhum armazenamento persistente disponível; usando memória (os dados somem ao recarregar).');
        return createMemoryStorage();
    }
    const instance = localforage.createInstance({ name: 'AgentStudio', storeName: NAMESPACE });
    const fullKey = (table, key) => `${table}/${key}`;
    return {
        kind: 'browser',
        async get(table, key) {
            const value = await instance.getItem(fullKey(table, key));
            return value === null ? undefined : value;
        },
        async set(table, key, value) {
            await instance.setItem(fullKey(table, key), value);
        },
        async remove(table, key) {
            await instance.removeItem(fullKey(table, key));
        },
    };
}

/** Usado em testes e como último recurso. */
export function createMemoryStorage() {
    const map = new Map();
    const fullKey = (table, key) => `${table}/${key}`;
    return {
        kind: 'browser',
        async get(table, key) {
            const value = map.get(fullKey(table, key));
            return value === undefined ? undefined : structuredClone(value);
        },
        async set(table, key, value) {
            map.set(fullKey(table, key), structuredClone(value));
        },
        async remove(table, key) {
            map.delete(fullKey(table, key));
        },
        _map: map,
    };
}
