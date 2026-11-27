// Condições nas fichas, combate (iniciativa, rodadas), missões, relógio do jogo e o bloco de estado no prompt.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { createAgentMock, createExtensionStoreMock, createSillyTavernMock } from './mocks.mjs';

let st;
let agent;

function installGlobals() {
    st = createSillyTavernMock();
    agent = createAgentMock();
    globalThis.SillyTavern = st.SillyTavern;
    globalThis.__TAURITAVERN__ = { api: { agent: agent.api, extension: { store: createExtensionStoreMock() } } };
    globalThis.fetch = async () => ({ ok: false });
    globalThis.toastr = { info() {}, error() {}, success() {}, warning() {} };
}

installGlobals();
const { createStorage } = await import('../src/storage.js');
const { StudioFS } = await import('../src/studio-fs.js');
const { LorebookService } = await import('../src/lorebook.js');
const { ActivityLog } = await import('../src/activity.js');
const { AgentToolBridge, buildToolDefinitions } = await import('../src/tools.js');
const { SystemService } = await import('../src/system.js');
const { MapService } = await import('../src/map.js');
const { CampaignService, formatClock, parseTime } = await import('../src/campaign.js');
const { StatePrompt, STATE_PROMPT_KEY } = await import('../src/state-prompt.js');
const { RollbackManager, RunJournal } = await import('../src/journal.js');

/** Dados roteirizados: cada valor é o resultado de um dado (d20 por padrão). */
function scripted(...values) {
    const queue = [...values];
    return () => ((queue.shift() ?? 10) - 0.5) / 20;
}

async function setup({ dice = [] } = {}) {
    const storage = createStorage();
    const settings = { studioTools: true, loreReadTools: true, loreWriteTools: true, systemTools: true, mapTools: true, campaignTools: true, statePrompt: true, stateQuests: true, undoOnRegenerate: true, backupsPerBook: 20 };
    const fs = new StudioFS(storage);
    const lore = new LorebookService(storage, () => settings);
    const activity = new ActivityLog(storage);
    const system = new SystemService(storage, lore, { random: scripted(...dice) });
    const map = new MapService(storage, lore, system);
    const campaign = new CampaignService(system);
    const journal = new RunJournal(storage, { getChatId: () => st.context.getCurrentChatId() });
    for (const service of [fs, lore, system, map, campaign]) service.journal = journal;
    const rollback = new RollbackManager({ journal, fs, lore, system, map, campaign, activity, getSettings: () => settings });
    rollback.install();
    const statePrompt = new StatePrompt({ campaign, system, getSettings: () => settings });
    statePrompt.install();
    const bridge = new AgentToolBridge({ definitions: buildToolDefinitions({ fs, lore, system, map, campaign }), activity, getSettings: () => settings });
    await bridge.registerAll();
    const call = (name, args, runId = 'run-1') => agent.call(name, args, { runId });
    return { system, campaign, statePrompt, settings, call, activity };
}

describe('condições', () => {
    beforeEach(installGlobals);

    test('entram na conta dos testes e da Defesa, aparecem nas fichas e acabam sozinhas', async () => {
        const { call, system } = await setup({ dice: [12, 12] });
        await call('sheet_condition', { sheet: 'Aria', name: 'Envenenado', target: 'todos os testes', value: '-2', rounds: 2, description: 'Enjoo.' });
        await call('sheet_condition', { character: 'Aria', condition: 'Caído', target: 'Defesa', modifier: -2 });
        const roll = await call('system_roll', { sheet: 'Aria', check: 'Atletismo', dc: 10 });
        assert.equal(roll.total, 10, '12 + 0 (Força) - 2 (Envenenado)');
        assert.match(roll.math, /1d20: 12 - 2 \(condições \(todos os testes\)\) = 10/);
        const sheet = await call('sheet_read', { sheet: 'Aria' });
        assert.equal(sheet.stats.find(s => s.name === 'Defesa').total, 8);
        assert.deepEqual(sheet.conditions.map(c => [c.name, c.effect, c.duration]), [
            ['Envenenado', '-2 on todos os testes', '2 round(s) left'],
            ['Caído', '-2 on Defesa', 'until removed'],
        ]);
        assert.match((await call('sheet_list', {})).sheets[0].conditions, /Envenenado \(-2 todos os testes, 2 rodadas\); Caído \(-2 Defesa\)/);

        const expired = await system.tickConditions([sheet.id]);
        assert.deepEqual(expired, []);
        assert.deepEqual(await system.tickConditions([sheet.id]), [{ sheet: 'Aria', condition: 'Envenenado' }]);
        await call('sheet_condition', { sheet: 'Aria', action: 'curar', name: 'caido' });
        assert.equal((await call('sheet_read', { sheet: 'Aria' })).conditions, undefined);
        await assert.rejects(call('sheet_condition', { sheet: 'Aria', name: 'Bênção', value: 1 }), /needs a "target"/);
        await assert.rejects(call('sheet_condition', { sheet: 'Aria', name: 'Bênção', value: 1, target: 'Voo' }), /Unknown condition target "Voo"/);
    });
});

describe('combate', () => {
    beforeEach(installGlobals);

    test('iniciativa, turnos, rodadas e condições que passam com as rodadas', async () => {
        // Iniciativas: Aria 15, Goblin 8; Lobo sem ficha com 12 dado.
        const { call } = await setup({ dice: [15, 8] });
        await call('sheet_create', { name: 'Goblin' });
        await call('sheet_condition', { sheet: 'Goblin', name: 'Atordoado', rounds: 1 });
        const started = await call('combat', { action: 'iniciar', combatants: ['Aria', 'Goblin', { name: 'Lobo', initiative: 12 }] });
        assert.deepEqual(started.order, ['▶ Aria (15)', 'Lobo (12) [no sheet]', 'Goblin (8)']);
        assert.equal(started.turn_of, 'Aria');
        assert.match(started.read_this, /round 1.*Aria's turn/);
        assert.ok(started.initiative_rolls[0].startsWith('Aria: 1d20: 15'));

        assert.equal((await call('combat', { action: 'next' })).turn_of, 'Lobo');
        assert.equal((await call('combat', { action: 'next' })).turn_of, 'Goblin');
        const round2 = await call('combat', { action: 'next' });
        assert.deepEqual([round2.round, round2.turn_of], [2, 'Aria']);
        assert.deepEqual(round2.conditions_ended, ['Atordoado (Goblin)']);

        const removed = await call('combat', { action: 'remove', participants: ['lobo'] });
        assert.deepEqual(removed.order, ['▶ Aria (15)', 'Goblin (8)']);
        const ended = await call('combat', { action: 'end' });
        assert.equal(ended.ended_after_rounds, 2);
        assert.equal((await call('combat', {})).active, false);
        await assert.rejects(call('combat', { action: 'next' }), /no combat/);
    });
});

describe('missões e tempo', () => {
    beforeEach(installGlobals);

    test('missão com objetivos: criar, marcar por número ou texto, concluir', async () => {
        const { call } = await setup();
        const created = await call('quest', { action: 'nova', title: 'Resgatar Mira', objectives: 'Achar o porão; Falar com o guarda', giver: 'Bento', secret: 'O guarda é cúmplice.' });
        assert.deepEqual(created.created.objectives, ['1. [ ] Achar o porão', '2. [ ] Falar com o guarda']);
        const updated = await call('quest', { action: 'update', quest: 'mira', complete_objectives: ['1'], add_objectives: ['Fugir da cidade'] });
        assert.deepEqual(updated.quest.objectives, ['1. [x] Achar o porão', '2. [ ] Falar com o guarda', '3. [ ] Fugir da cidade']);
        const partial = await call('quest', { action: 'update', quest: 'Resgatar', complete_objectives: ['guarda', 'Voar'] });
        assert.deepEqual(partial.not_found, ['Objective not found: "Voar" (use the number or the text).']);
        await call('quest', { action: 'complete', quest: 'Resgatar Mira' });
        const list = await call('quest', {});
        assert.deepEqual(list.active, []);
        assert.deepEqual(list.finished, ['Resgatar Mira (concluída)']);
        await assert.rejects(call('quest', { action: 'fail', quest: 'Dragão' }), /Quest not found/);
    });

    test('relógio: avançar, virar o dia, ir para uma hora e clima', async () => {
        const { call } = await setup();
        assert.equal(parseTime('14h30'), 870);
        assert.equal(parseTime('meio-dia'), 720);
        let now = await call('game_time', { set_day: 1, set_time: '20:00', weather: 'chuva fina' });
        assert.equal(now.now, 'Dia 1, 20:00 (noite) · chuva fina');
        now = await call('game_time', { hours: 8 });
        assert.equal(now.now, 'Dia 2, 04:00 (madrugada) · chuva fina');
        now = await call('game_time', { time: 'dawn' });
        assert.equal(now.now, 'Dia 2, 06:00 (manhã) · chuva fina');
        now = await call('game_time', { set_time: '05:00' });
        assert.equal(now.now, 'Dia 3, 05:00 (madrugada) · chuva fina', 'uma hora que já passou vai para o dia seguinte');
        await assert.rejects(call('game_time', { advance_hours: -2 }), /only moves forward/);
        assert.equal(formatClock(null), '');
    });
});

describe('bloco de estado no prompt', () => {
    beforeEach(installGlobals);

    test('mostra tempo, Vida/Mana e condições do jogador, combate e missões; some quando desligado', async () => {
        const { call, statePrompt, settings } = await setup({ dice: [15, 8] });
        assert.equal(await statePrompt.refresh(), '[Estado do jogo (Agent Studio, sempre atual; use estes números)]\nAria: Vida 10/10, Mana 10/10 · Defesa 10');
        await call('game_time', { set_time: '14:30', set_day: 3 });
        await call('sheet_resource', { sheet: 'Aria', resource: 'Vida', delta: -4 });
        await call('sheet_condition', { sheet: 'Aria', name: 'Envenenado', target: 'checks', value: -2, rounds: 3 });
        await call('sheet_create', { name: 'Goblin' });
        await call('combat', { action: 'start', participants: ['Aria', 'Goblin'] });
        await call('quest', { action: 'create', title: 'Resgatar Mira', objectives: ['Achar o porão'] });
        const text = await statePrompt.refresh();
        assert.equal(text, [
            '[Estado do jogo (Agent Studio, sempre atual; use estes números)]',
            'Tempo: Dia 3, 14:30 (tarde)',
            'Aria: Vida 6/10, Mana 10/10 · Defesa 10 · condições: Envenenado (-2 todos os testes, 3 rodadas)',
            'COMBATE, rodada 1. Ordem: ▶Aria (13), Goblin (8). Vez de: Aria.', // 15 - 2 (Envenenado)
            '  Goblin: Vida 10/10, Mana 10/10 · Defesa 10',
            'Missões ativas: Resgatar Mira (falta: Achar o porão)',
        ].join('\n'));
        assert.deepEqual(st.context.extensionPrompts[STATE_PROMPT_KEY], { value: text, position: 1, depth: 1, scan: false, role: 0 });
        settings.stateQuests = false;
        assert.doesNotMatch(await statePrompt.refresh(), /Missões/);
        settings.statePrompt = false;
        assert.equal(await statePrompt.refresh(), '');
    });

    test('regenerar desfaz combate, missões e tempo; voltar para a swipe refaz', async () => {
        const { call, campaign } = await setup({ dice: [15, 8] });
        await call('quest', { action: 'create', title: 'Antiga' }, 'run-0');
        await call('game_time', { set_time: '10:00' }, 'run-A');
        await call('quest', { action: 'create', title: 'Nova' }, 'run-A');
        await call('combat', { action: 'start', participants: ['Aria'] }, 'run-A');
        const after = await campaign.snapshot();
        const message = { is_user: false, mes: 'A', extra: { tauritavern: { agent: { runId: 'run-A' } } }, swipe_id: 0, swipes: ['A'], swipe_info: [{ extra: { tauritavern: { agent: { runId: 'run-A' } } } }] };
        st.context.chat.push(message);
        message.swipe_id = 1;
        await st.context.eventSource.emit('message_swiped', 0);
        const undone = await campaign.snapshot();
        assert.deepEqual(undone.quests.map(q => q.title), ['Antiga']);
        assert.equal(undone.combat, null);
        assert.equal(undone.clock, null);
        message.swipe_id = 0;
        await st.context.eventSource.emit('message_swiped', 0);
        assert.deepEqual(await campaign.snapshot(), after);
    });
});
