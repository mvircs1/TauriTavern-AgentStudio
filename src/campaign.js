// Campanha de cada chat: relógio do jogo, combate (iniciativa, rodadas, turnos) e diário de missões.
// Tudo fica no próprio chat (chat_metadata.agent_studio.campaign), então acompanha branches e exportações.

import { createSerialQueue, foldText, generateId, LOG_PREFIX } from './util.js';

const CHAT_META_KEY = 'agent_studio';
const MAX_QUESTS = 100;
const MAX_OBJECTIVES = 30;
const MAX_PARTICIPANTS = 30;
const TEXT = { title: 120, description: 2000, objective: 300, secret: 2000, small: 200, weather: 120 };
export const QUEST_STATUS = { active: 'ativa', done: 'concluída', failed: 'falhou' };

function clip(value, max) {
    return String(value ?? '').normalize('NFC').trim().slice(0, max);
}

function int(value, fallback = 0) {
    const number = Math.trunc(Number(value));
    return Number.isFinite(number) ? number : fallback;
}

function normalizeClock(clock) {
    if (!clock || typeof clock !== 'object') return null;
    return {
        day: Math.max(1, int(clock.day, 1)),
        minutes: ((int(clock.minutes, 8 * 60) % 1440) + 1440) % 1440,
        weather: clip(clock.weather, TEXT.weather),
        note: clip(clock.note, TEXT.small),
    };
}

function normalizeCombat(combat) {
    if (!combat || typeof combat !== 'object' || !Array.isArray(combat.order)) return null;
    const order = combat.order
        .filter(entry => entry && entry.name)
        .map(entry => ({ id: String(entry.id ?? generateId('t')), sheetId: entry.sheetId ? String(entry.sheetId) : null, name: clip(entry.name, 60), initiative: int(entry.initiative) }));
    if (!order.length) return null;
    return {
        round: Math.max(1, int(combat.round, 1)),
        turn: Math.min(Math.max(0, int(combat.turn)), order.length - 1),
        order,
        startedAt: combat.startedAt ?? new Date().toISOString(),
    };
}

function normalizeQuest(quest) {
    return {
        id: String(quest?.id ?? generateId('q')),
        title: clip(quest?.title, TEXT.title) || 'Missão',
        description: clip(quest?.description, TEXT.description),
        status: QUEST_STATUS[quest?.status] ? quest.status : 'active',
        objectives: (Array.isArray(quest?.objectives) ? quest.objectives : [])
            .map(objective => ({ id: String(objective?.id ?? generateId('o')), text: clip(objective?.text, TEXT.objective), done: objective?.done === true }))
            .filter(objective => objective.text)
            .slice(0, MAX_OBJECTIVES),
        giver: clip(quest?.giver, TEXT.small),
        reward: clip(quest?.reward, TEXT.small),
        secret: clip(quest?.secret, TEXT.secret),
        createdAt: quest?.createdAt ?? new Date().toISOString(),
        updatedAt: quest?.updatedAt ?? null,
    };
}

export function normalizeCampaign(stored) {
    const value = stored && typeof stored === 'object' ? stored : {};
    return {
        clock: normalizeClock(value.clock),
        combat: normalizeCombat(value.combat),
        quests: (Array.isArray(value.quests) ? value.quests : []).map(normalizeQuest).slice(0, MAX_QUESTS),
    };
}

/** "madrugada", "manhã", "tarde", "noite". */
export function periodOf(minutes) {
    const hour = Math.floor(minutes / 60);
    if (hour < 6) return 'madrugada';
    if (hour < 12) return 'manhã';
    if (hour < 18) return 'tarde';
    return 'noite';
}

export function formatClock(clock) {
    if (!clock) return '';
    const hh = String(Math.floor(clock.minutes / 60)).padStart(2, '0');
    const mm = String(clock.minutes % 60).padStart(2, '0');
    return `Dia ${clock.day}, ${hh}:${mm} (${periodOf(clock.minutes)})${clock.weather ? ` · ${clock.weather}` : ''}`;
}

/** "14:30", "14h", "9h15", "noon"... devolve minutos desde a meia-noite. */
export function parseTime(value) {
    const text = foldText(String(value ?? '')).replace(/[\s_-]+/g, '');
    const named = { amanhecer: 6 * 60, alvorada: 6 * 60, manha: 8 * 60, meiodia: 12 * 60, tarde: 15 * 60, entardecer: 18 * 60, anoitecer: 18 * 60, noite: 20 * 60, meianoite: 0, madrugada: 3 * 60, dawn: 6 * 60, morning: 8 * 60, noon: 12 * 60, afternoon: 15 * 60, dusk: 18 * 60, evening: 19 * 60, night: 21 * 60, midnight: 0 };
    if (text in named) return named[text];
    const match = /^(\d{1,2})(?:[:h](\d{2})?)?$/.exec(text);
    if (!match) throw new Error(`Invalid time "${value}". Use "HH:MM" (e.g. "14:30") or dawn/morning/noon/afternoon/dusk/night/midnight.`);
    const hours = Number(match[1]);
    const minutes = Number(match[2] ?? 0);
    if (hours > 23 || minutes > 59) throw new Error(`Invalid time "${value}".`);
    return hours * 60 + minutes;
}

/** Acha um item da lista pelo id, pelo número (1, 2...) ou pelo texto, sem acentos/maiúsculas. */
function findIn(list, reference, field) {
    const raw = String(reference ?? '').trim();
    if (!raw) return null;
    const byId = list.find(item => item.id === raw);
    if (byId) return byId;
    if (/^\d+$/.test(raw) && list[Number(raw) - 1]) return list[Number(raw) - 1];
    const wanted = foldText(raw);
    const exact = list.filter(item => foldText(item[field]) === wanted);
    if (exact.length === 1) return exact[0];
    const partial = list.filter(item => foldText(item[field]).includes(wanted) || wanted.includes(foldText(item[field])));
    return partial.length === 1 ? partial[0] : null;
}

export class CampaignService {
    /**
     * @param {import('./system.js').SystemService} system
     */
    constructor(system) {
        this.system = system;
        this.enqueue = createSerialQueue();
        this.listeners = new Set();
        /** @type {import('./journal.js').RunJournal|null} */
        this.journal = null;
    }

    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(change) {
        for (const listener of this.listeners) {
            try { listener(change); } catch (error) { console.error(LOG_PREFIX, error); }
        }
    }

    scope() {
        const context = SillyTavern.getContext();
        const chatId = typeof context.getCurrentChatId === 'function' ? context.getCurrentChatId() : null;
        return { context, chatId: chatId || null, hasChat: Boolean(chatId && context.chatMetadata) };
    }

    read(scope) {
        if (!scope.hasChat) return normalizeCampaign(null);
        return normalizeCampaign(scope.context.chatMetadata[CHAT_META_KEY]?.campaign);
    }

    async write(scope, campaign) {
        const meta = scope.context.chatMetadata;
        meta[CHAT_META_KEY] = { ...(meta[CHAT_META_KEY] ?? {}), campaign: normalizeCampaign(campaign) };
        await scope.context.saveMetadata();
    }

    /** Roda uma alteração: exige chat aberto, guarda o "antes" no diário da run e avisa quem escuta. */
    change(runId, task) {
        return this.enqueue(async () => {
            const scope = this.scope();
            if (!scope.hasChat) throw new Error('Open a chat first: the campaign (time, combat, quests) belongs to the chat.');
            if (runId && this.journal) {
                await this.journal.capture(runId, `campaign:${scope.chatId}`, async () => ({
                    kind: 'campaign',
                    chatId: scope.chatId,
                    before: scope.context.chatMetadata[CHAT_META_KEY]?.campaign ? structuredClone(scope.context.chatMetadata[CHAT_META_KEY].campaign) : null,
                }));
            }
            const campaign = this.read(scope);
            const result = await task(campaign, scope);
            await this.write(scope, campaign);
            this.emit({ type: 'campaign' });
            return result;
        });
    }

    snapshot() {
        return this.enqueue(async () => {
            const scope = this.scope();
            return { hasChat: scope.hasChat, ...this.read(scope) };
        });
    }

    // ---------- diário (desfazer/refazer) ----------

    undoEntries(entries, chatId) {
        return this.enqueue(async () => {
            const scope = this.scope();
            let changed = 0;
            for (const entry of entries) {
                if (entry.kind !== 'campaign' || !scope.hasChat || scope.chatId !== (entry.chatId ?? chatId)) continue;
                const meta = scope.context.chatMetadata;
                const bag = { ...(meta[CHAT_META_KEY] ?? {}) };
                if (entry.before) bag.campaign = structuredClone(entry.before);
                else delete bag.campaign;
                meta[CHAT_META_KEY] = bag;
                await scope.context.saveMetadata();
                changed++;
            }
            if (changed) this.emit({ type: 'undo' });
            return changed;
        });
    }

    snapshotEntries(entries) {
        return this.enqueue(async () => {
            const scope = this.scope();
            const current = scope.hasChat ? scope.context.chatMetadata[CHAT_META_KEY]?.campaign : null;
            return entries.filter(entry => entry.kind === 'campaign').map(entry => ({
                key: entry.key,
                kind: 'campaign',
                chatId: scope.chatId,
                before: current ? structuredClone(current) : null,
            }));
        });
    }

    // ---------- tempo ----------

    /** Avança ou acerta o relógio do jogo e o clima. */
    time({ advanceMinutes = 0, advanceHours = 0, advanceDays = 0, setTime, setDay, weather, note, runId } = {}) {
        return this.change(runId, campaign => {
            const clock = campaign.clock ?? { day: 1, minutes: 8 * 60, weather: '', note: '' };
            const before = formatClock(clock);
            if (setDay !== undefined && setDay !== null && setDay !== '') clock.day = Math.max(1, int(setDay, clock.day));
            if (setTime !== undefined && setTime !== null && setTime !== '') {
                const target = parseTime(setTime);
                // "Até a noite" anda para a frente: se a hora já passou hoje, vai para o dia seguinte.
                if (setDay === undefined || setDay === null || setDay === '') {
                    if (target < clock.minutes && !advanceMinutes && !advanceHours && !advanceDays) clock.day += 1;
                }
                clock.minutes = target;
            }
            const advance = int(advanceMinutes) + int(advanceHours) * 60 + int(advanceDays) * 1440;
            if (advance < 0) throw new Error('Time only moves forward. Use set_day/set_time to fix a mistake.');
            const total = clock.minutes + advance;
            clock.day += Math.floor(total / 1440);
            clock.minutes = total % 1440;
            if (weather !== undefined && weather !== null) clock.weather = clip(weather, TEXT.weather);
            if (note !== undefined && note !== null) clock.note = clip(note, TEXT.small);
            campaign.clock = normalizeClock(clock);
            const now = formatClock(campaign.clock);
            return { before: campaign.clock && before !== now ? before : undefined, now, note: campaign.clock.note || undefined };
        });
    }

    // ---------- combate ----------

    /** Rola a iniciativa de uma ficha (estatística "Iniciativa", ou o atributo mais parecido). */
    async rollInitiative(sheetRef) {
        const info = await this.system.systemInfo({ section: 'all' });
        const statNames = (info.stats ?? []).map(stat => stat.name);
        const check = statNames.find(name => /inici|initiat/i.test(foldText(name)))
            ?? (info.attributes ?? []).map(a => a.name).find(name => /destr|dex|agil/i.test(foldText(name)))
            ?? (info.attributes ?? [])[0]?.name;
        const roll = await this.system.roll(sheetRef, { check, reason: 'Iniciativa' });
        return { total: roll.total, math: roll.math, sheet: roll.sheet };
    }

    /** Monta um participante: ficha (rola a iniciativa) ou um nome qualquer (iniciativa dada ou 1d20). */
    async participant(input) {
        const name = clip(typeof input === 'string' ? input : input?.name, 60);
        if (!name) throw new Error('Each participant needs a "name".');
        const given = typeof input === 'object' && input?.initiative !== undefined && input?.initiative !== null && input?.initiative !== '' ? int(input.initiative) : null;
        let sheet = null;
        try {
            const view = await this.system.readSheet(name);
            sheet = view?.id ? { id: view.id, name: view.name } : null;
        } catch {
            sheet = null;
        }
        if (sheet) {
            if (given !== null) return { entry: { sheetId: sheet.id, name: sheet.name, initiative: given }, detail: `${sheet.name}: ${given} (dada)` };
            const rolled = await this.rollInitiative(sheet.id);
            return { entry: { sheetId: sheet.id, name: sheet.name, initiative: rolled.total }, detail: `${sheet.name}: ${rolled.math}` };
        }
        const initiative = given ?? this.system.die(20);
        return { entry: { sheetId: null, name, initiative }, detail: `${name}: ${given !== null ? `${given} (dada)` : `1d20: ${initiative} (sem ficha)`}` };
    }

    combatView(combat) {
        if (!combat) return { active: false };
        const current = combat.order[combat.turn];
        return {
            active: true,
            round: combat.round,
            turn_of: current.name,
            next_up: combat.order[(combat.turn + 1) % combat.order.length].name,
            order: combat.order.map((entry, index) => `${index === combat.turn ? '▶ ' : ''}${entry.name} (${entry.initiative})${entry.sheetId ? '' : ' [no sheet]'}`),
        };
    }

    combat({ action = 'status', participants, runId } = {}) {
        const act = ['start', 'next', 'add', 'remove', 'end', 'status'].includes(action) ? action : 'status';
        if (act === 'status') {
            return this.snapshot().then(campaign => this.combatView(campaign.combat));
        }
        const list = Array.isArray(participants) ? participants : participants ? [participants] : [];
        return this.change(runId, async campaign => {
            if (act === 'start') {
                if (!list.length) throw new Error('"participants" is required: the sheets (and other creatures) in the fight, e.g. ["Aria", "Goblin", {"name": "Lobo", "initiative": 12}].');
                if (list.length > MAX_PARTICIPANTS) throw new Error(`At most ${MAX_PARTICIPANTS} participants.`);
                const built = [];
                for (const item of list) built.push(await this.participant(item));
                const order = built.map(item => ({ id: generateId('t'), ...item.entry })).sort((a, b) => b.initiative - a.initiative);
                campaign.combat = normalizeCombat({ round: 1, turn: 0, order, startedAt: new Date().toISOString() });
                return {
                    ...this.combatView(campaign.combat),
                    initiative_rolls: built.map(item => item.detail),
                    read_this: `Combat started, round 1. It is ${campaign.combat.order[0].name}'s turn. Narrate one turn at a time and call combat {"action":"next"} after each creature acts.`,
                };
            }
            const combat = campaign.combat;
            if (!combat) throw new Error('There is no combat going on. Use action "start".');
            if (act === 'end') {
                campaign.combat = null;
                return { active: false, ended_after_rounds: combat.round };
            }
            if (act === 'add') {
                if (!list.length) throw new Error('"participants" is required.');
                const details = [];
                for (const item of list) {
                    const built = await this.participant(item);
                    details.push(built.detail);
                    const current = combat.order[combat.turn];
                    combat.order.push({ id: generateId('t'), ...built.entry });
                    combat.order.sort((a, b) => b.initiative - a.initiative);
                    combat.turn = combat.order.indexOf(current);
                }
                campaign.combat = normalizeCombat(combat);
                return { ...this.combatView(campaign.combat), initiative_rolls: details };
            }
            if (act === 'remove') {
                if (!list.length) throw new Error('"participants" is required (names to remove: fled, died...).');
                const removed = [];
                for (const item of list) {
                    const found = findIn(combat.order, typeof item === 'string' ? item : item?.name, 'name');
                    if (!found) throw new Error(`"${typeof item === 'string' ? item : item?.name}" is not in the combat. Order: ${combat.order.map(e => e.name).join(', ')}.`);
                    const index = combat.order.indexOf(found);
                    combat.order.splice(index, 1);
                    if (index < combat.turn) combat.turn -= 1;
                    removed.push(found.name);
                }
                if (!combat.order.length) {
                    campaign.combat = null;
                    return { active: false, removed, note: 'Nobody left: combat ended.' };
                }
                if (combat.turn >= combat.order.length) combat.turn = 0;
                campaign.combat = normalizeCombat(combat);
                return { ...this.combatView(campaign.combat), removed };
            }
            // next
            combat.turn += 1;
            let expired = [];
            if (combat.turn >= combat.order.length) {
                combat.turn = 0;
                combat.round += 1;
                // Nova rodada: condições com duração perdem 1 rodada.
                const ids = combat.order.map(entry => entry.sheetId).filter(Boolean);
                if (ids.length) expired = await this.system.tickConditions(ids, { runId });
            }
            campaign.combat = normalizeCombat(combat);
            const view = this.combatView(campaign.combat);
            if (expired.length) view.conditions_ended = expired.map(item => `${item.condition} (${item.sheet})`);
            view.read_this = `Round ${view.round}: now it is ${view.turn_of}'s turn.`;
            return view;
        });
    }

    // ---------- missões ----------

    questView(quest, { full = true } = {}) {
        const result = {
            title: quest.title,
            status: quest.status,
        };
        if (quest.description && full) result.description = quest.description;
        if (quest.objectives.length) result.objectives = quest.objectives.map((o, i) => `${i + 1}. [${o.done ? 'x' : ' '}] ${o.text}`);
        if (quest.giver) result.giver = quest.giver;
        if (quest.reward) result.reward = quest.reward;
        if (quest.secret && full) result.secret_for_narrator = quest.secret;
        return result;
    }

    quest({ action = 'list', quest: reference, title, description, giver, reward, secret, objectives, addObjectives, completeObjectives, uncheckObjectives, removeObjectives, runId } = {}) {
        const act = ['create', 'update', 'complete', 'fail', 'reopen', 'remove', 'list'].includes(action) ? action : 'list';
        if (act === 'list') {
            return this.snapshot().then(campaign => {
                const active = campaign.quests.filter(q => q.status === 'active');
                const closed = campaign.quests.filter(q => q.status !== 'active');
                return {
                    active: active.map(q => this.questView(q)),
                    finished: closed.slice(-20).map(q => `${q.title} (${QUEST_STATUS[q.status]})`),
                };
            });
        }
        return this.change(runId, campaign => {
            const lines = value => (Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value])
                .map(item => clip(typeof item === 'object' ? item?.text : item, TEXT.objective)).filter(Boolean);
            if (act === 'create') {
                const clean = clip(title, TEXT.title);
                if (!clean) throw new Error('"title" is required.');
                if (campaign.quests.length >= MAX_QUESTS) throw new Error(`At most ${MAX_QUESTS} quests per chat: remove old ones.`);
                const clash = campaign.quests.find(q => foldText(q.title) === foldText(clean) && q.status === 'active');
                if (clash) throw new Error(`An active quest "${clash.title}" already exists. Use action "update".`);
                const quest = normalizeQuest({
                    title: clean, description, giver, reward, secret,
                    objectives: lines(objectives ?? addObjectives).map(text => ({ text })),
                });
                campaign.quests.push(quest);
                return { created: this.questView(quest) };
            }
            const quest = findIn(campaign.quests, reference ?? title, 'title');
            if (!quest) {
                throw new Error(`Quest not found: "${reference ?? title ?? ''}". Quests: ${campaign.quests.map(q => `"${q.title}"`).join(', ') || 'none'}.`);
            }
            if (act === 'remove') {
                campaign.quests = campaign.quests.filter(q => q !== quest);
                return { removed: quest.title };
            }
            if (act === 'complete' || act === 'fail' || act === 'reopen') {
                quest.status = act === 'complete' ? 'done' : act === 'fail' ? 'failed' : 'active';
                if (act === 'complete') for (const objective of quest.objectives) objective.done = true;
                quest.updatedAt = new Date().toISOString();
                return { quest: this.questView(quest, { full: false }) };
            }
            // update
            if (title !== undefined && reference !== undefined && clip(title, TEXT.title)) quest.title = clip(title, TEXT.title);
            if (description !== undefined) quest.description = clip(description, TEXT.description);
            if (giver !== undefined) quest.giver = clip(giver, TEXT.small);
            if (reward !== undefined) quest.reward = clip(reward, TEXT.small);
            if (secret !== undefined) quest.secret = clip(secret, TEXT.secret);
            const missing = [];
            const mark = (refs, done) => {
                for (const ref of lines(refs)) {
                    const objective = findIn(quest.objectives, ref, 'text');
                    if (objective) objective.done = done;
                    else missing.push(ref);
                }
            };
            mark(completeObjectives, true);
            mark(uncheckObjectives, false);
            for (const ref of lines(removeObjectives)) {
                const objective = findIn(quest.objectives, ref, 'text');
                if (objective) quest.objectives = quest.objectives.filter(o => o !== objective);
                else missing.push(ref);
            }
            for (const text of lines(addObjectives)) {
                if (quest.objectives.length >= MAX_OBJECTIVES) throw new Error(`At most ${MAX_OBJECTIVES} objectives.`);
                quest.objectives.push({ id: generateId('o'), text, done: false });
            }
            quest.updatedAt = new Date().toISOString();
            const result = { quest: this.questView(quest) };
            if (missing.length) result.not_found = missing.map(text => `Objective not found: "${text}" (use the number or the text).`);
            if (quest.objectives.length && quest.objectives.every(o => o.done) && quest.status === 'active') {
                result.note = 'All objectives are done: call quest {"action":"complete"} when the story closes it.';
            }
            return result;
        });
    }

    // ---------- interface ----------

    /** Alterações vindas do painel (sem run). */
    saveQuest(input) {
        return this.change(null, campaign => {
            const existing = input.id ? campaign.quests.find(q => q.id === input.id) : null;
            const quest = normalizeQuest({ ...(existing ?? {}), ...input, updatedAt: new Date().toISOString() });
            if (!quest.title) throw new Error('O título é obrigatório.');
            if (existing) campaign.quests = campaign.quests.map(q => (q === existing ? quest : q));
            else campaign.quests.push(quest);
            return quest.id;
        });
    }

    removeQuest(id) {
        return this.change(null, campaign => {
            campaign.quests = campaign.quests.filter(q => q.id !== id);
        });
    }

    setClock(clock) {
        return this.change(null, campaign => {
            campaign.clock = clock ? normalizeClock(clock) : null;
        });
    }
}
