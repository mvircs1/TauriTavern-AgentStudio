// Leva o mapa para o prompt, nos dois modos (normal e Agent):
// - um bloco curto com o local atual (setExtensionPrompt, dentro do chat, perto do fim);
// - as entradas de lorebook vinculadas ao local (e aos NPCs com ficha presentes) são ativadas na
//   próxima geração (evento WORLDINFO_FORCE_ACTIVATE), sem precisar de palavra-chave.

import { PROMPT_KEY } from './map.js';
import { LOG_PREFIX } from './util.js';

// Valores de extension_prompt_types / extension_prompt_roles (SillyTavern 1.19).
const IN_CHAT = 1;
const SYSTEM_ROLE = 0;
const DEPTH = 2;

export class LocationPrompt {
    /**
     * @param {{ map: import('./map.js').MapService, system?: import('./system.js').SystemService, getSettings: () => Record<string, any> }} deps
     */
    constructor({ map, system = null, getSettings }) {
        this.map = map;
        this.system = system;
        this.getSettings = getSettings;
        this.timer = null;
        this.lastText = '';
    }

    context() {
        return SillyTavern.getContext();
    }

    /** Atualiza (ou limpa) o bloco do local atual no prompt. */
    async refresh() {
        const context = this.context();
        if (typeof context.setExtensionPrompt !== 'function') return '';
        let text = '';
        try {
            text = this.getSettings().mapPrompt !== false ? await this.map.promptBlock() : '';
        } catch (error) {
            console.warn(LOG_PREFIX, 'Não consegui montar o bloco de localização', error);
        }
        context.setExtensionPrompt(PROMPT_KEY, text, IN_CHAT, DEPTH, true, SYSTEM_ROLE);
        this.lastText = text;
        return text;
    }

    scheduleRefresh() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.refresh().catch(error => console.warn(LOG_PREFIX, error)), 200);
    }

    /** Ativa as entradas de lorebook do local atual para a próxima geração. Devolve quantas. */
    async activateLore() {
        if (this.getSettings().mapLore === false) return 0;
        const context = this.context();
        const types = context.eventTypes ?? context.event_types;
        if (!types?.WORLDINFO_FORCE_ACTIVATE || !context.eventSource) return 0;
        const refs = await this.map.forcedEntryRefs();
        if (!refs.length) return 0;
        const entries = [];
        for (const ref of refs) {
            try {
                const data = await context.loadWorldInfo(ref.book);
                const entry = data?.entries?.[ref.uid];
                // Entradas desativadas não são ativadas pelo SillyTavern.
                if (entry && !entry.disable) entries.push({ ...structuredClone(entry), world: ref.book });
            } catch (error) {
                console.warn(LOG_PREFIX, `Entrada ${ref.book} #${ref.uid} indisponível`, error);
            }
        }
        if (entries.length) await context.eventSource.emit(types.WORLDINFO_FORCE_ACTIVATE, entries);
        return entries.length;
    }

    install() {
        const context = this.context();
        const types = context.eventTypes ?? context.event_types;
        if (context.eventSource && types?.GENERATION_STARTED) {
            // Antes de cada geração (o evento é esperado antes do World Info e da montagem do prompt).
            context.eventSource.on(types.GENERATION_STARTED, async () => {
                await this.refresh();
                await this.activateLore();
            });
        }
        if (context.eventSource && types?.CHAT_CHANGED) {
            context.eventSource.on(types.CHAT_CHANGED, () => this.scheduleRefresh());
        }
        this.map.onChange(() => this.scheduleRefresh());
        this.system?.onChange(() => this.scheduleRefresh());
        this.scheduleRefresh();
    }
}
