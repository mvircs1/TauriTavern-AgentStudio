// Bloco curto de estado do jogo no prompt (modo normal e Agent), para a IA não esquecer nem inventar:
// hora do jogo, Vida/Mana e condições do jogador, combate (ordem e vez) e missões ativas.

import { formatClock } from './campaign.js';
import { LOG_PREFIX } from './util.js';

export const STATE_PROMPT_KEY = 'agent_studio_state';
// Valores de extension_prompt_types / extension_prompt_roles (SillyTavern 1.19).
const IN_CHAT = 1;
const SYSTEM_ROLE = 0;
const DEPTH = 1;
const MAX_QUESTS_IN_PROMPT = 4;

export class StatePrompt {
    /**
     * @param {{ campaign: import('./campaign.js').CampaignService, system: import('./system.js').SystemService, getSettings: () => Record<string, any> }} deps
     */
    constructor({ campaign, system, getSettings }) {
        this.campaign = campaign;
        this.system = system;
        this.getSettings = getSettings;
        this.timer = null;
        this.lastText = '';
    }

    /** Monta o texto do bloco (vazio se não houver nada útil). */
    async build() {
        const settings = this.getSettings();
        const campaign = await this.campaign.snapshot();
        if (!campaign.hasChat) return '';
        let sheets = [];
        try {
            sheets = (await this.system.listSheets()).sheets;
        } catch {
            sheets = [];
        }
        const lines = [];
        if (campaign.clock) lines.push(`Tempo: ${formatClock(campaign.clock)}${campaign.clock.note ? ` · ${campaign.clock.note}` : ''}`);

        const describe = sheet => {
            const bits = [];
            if (sheet.resources) bits.push(sheet.resources);
            if (sheet.defense) bits.push(sheet.defense);
            if (sheet.conditions) bits.push(`condições: ${sheet.conditions}`);
            return `${sheet.name}: ${bits.join(' · ') || 'sem dados'}`;
        };
        const player = sheets.find(sheet => sheet.kind === 'player');
        if (player && settings.statePlayer !== false) lines.push(describe(player));

        if (campaign.combat) {
            const { combat } = campaign;
            const order = combat.order.map((entry, index) => `${index === combat.turn ? '▶' : ''}${entry.name} (${entry.initiative})`).join(', ');
            lines.push(`COMBATE, rodada ${combat.round}. Ordem: ${order}. Vez de: ${combat.order[combat.turn].name}.`);
            for (const entry of combat.order) {
                if (!entry.sheetId || entry.sheetId === player?.id) continue;
                const sheet = sheets.find(item => item.id === entry.sheetId);
                if (sheet) lines.push(`  ${describe(sheet)}`);
            }
        }

        if (settings.stateQuests !== false) {
            const active = campaign.quests.filter(quest => quest.status === 'active');
            if (active.length) {
                const shown = active.slice(-MAX_QUESTS_IN_PROMPT).map(quest => {
                    const pending = quest.objectives.filter(o => !o.done).map(o => o.text);
                    return pending.length ? `${quest.title} (falta: ${pending.slice(0, 3).join('; ')}${pending.length > 3 ? '…' : ''})` : quest.title;
                });
                const more = active.length > MAX_QUESTS_IN_PROMPT ? ` (+${active.length - MAX_QUESTS_IN_PROMPT})` : '';
                lines.push(`Missões ativas${more}: ${shown.join(' · ')}`);
            }
        }
        if (!lines.length) return '';
        return `[Estado do jogo (Agent Studio, sempre atual; use estes números)]\n${lines.join('\n')}`;
    }

    async refresh() {
        const context = SillyTavern.getContext();
        if (typeof context.setExtensionPrompt !== 'function') return '';
        let text = '';
        try {
            text = this.getSettings().statePrompt !== false ? await this.build() : '';
        } catch (error) {
            console.warn(LOG_PREFIX, 'Não consegui montar o bloco de estado', error);
        }
        context.setExtensionPrompt(STATE_PROMPT_KEY, text, IN_CHAT, DEPTH, false, SYSTEM_ROLE);
        this.lastText = text;
        return text;
    }

    scheduleRefresh() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.refresh().catch(error => console.warn(LOG_PREFIX, error)), 200);
    }

    install() {
        const context = SillyTavern.getContext();
        const types = context.eventTypes ?? context.event_types;
        if (context.eventSource && types?.GENERATION_STARTED) {
            context.eventSource.on(types.GENERATION_STARTED, () => this.refresh());
        }
        if (context.eventSource && types?.CHAT_CHANGED) {
            context.eventSource.on(types.CHAT_CHANGED, () => this.scheduleRefresh());
        }
        this.campaign.onChange(() => this.scheduleRefresh());
        this.system.onChange(() => this.scheduleRefresh());
        this.scheduleRefresh();
    }
}
