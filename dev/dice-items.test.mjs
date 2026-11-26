// Testes dos métodos de rolagem (D&D, Ordem, Direto, personalizado), treinamento de perícias e itens.
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
}

installGlobals();
const { createStorage } = await import('../src/storage.js');
const { StudioFS } = await import('../src/studio-fs.js');
const { LorebookService } = await import('../src/lorebook.js');
const { ActivityLog } = await import('../src/activity.js');
const { AgentToolBridge, buildToolDefinitions } = await import('../src/tools.js');
const { SystemService } = await import('../src/system.js');
const { RollbackManager, RunJournal } = await import('../src/journal.js');
const { describePool, formatRoll, normalizeDice, rollPool } = await import('../src/dice.js');

const sequence = (...values) => {
    const queue = [...values];
    return () => queue.shift() ?? 1;
};

async function setup(dice = []) {
    const storage = createStorage();
    const settings = { studioTools: true, loreReadTools: true, loreWriteTools: true, systemTools: true, undoOnRegenerate: true, backupsPerBook: 20 };
    const lore = new LorebookService(storage, () => settings);
    const system = new SystemService(storage, lore);
    const next = sequence(...dice);
    system.die = sides => Math.min(sides, next());
    const activity = new ActivityLog(storage);
    const fs = new StudioFS(storage);
    const journal = new RunJournal(storage, { getChatId: () => st.context.getCurrentChatId() });
    fs.journal = journal;
    lore.journal = journal;
    system.journal = journal;
    new RollbackManager({ journal, fs, lore, system, activity, getSettings: () => settings }).install();
    const bridge = new AgentToolBridge({ definitions: buildToolDefinitions({ fs, lore, system }), activity, getSettings: () => settings });
    await bridge.registerAll();
    const call = (name, args, runId = 'run-1') => agent.call(name, args, { runId });
    return { system, call, activity };
}

describe('dados (dice.js)', () => {
    const dnd = normalizeDice({ preset: 'dnd' });
    const ordem = normalizeDice({ preset: 'ordem', countMode: 'attribute', attributeBonus: 'none' });

    test('D&D: 1 dado; vantagem = 2 e fica o maior; desvantagem = 2 e fica o menor', () => {
        assert.deepEqual(rollPool(dnd, 1, { rollDie: sequence(12) }), { rolls: [12], result: 12, keep: 'highest', count: 1, label: '1d20' });
        assert.equal(rollPool(dnd, 1, { mode: 'advantage', rollDie: sequence(5, 17) }).result, 17);
        const dis = rollPool(dnd, 1, { mode: 'disadvantage', rollDie: sequence(5, 17) });
        assert.deepEqual([dis.result, dis.keep, dis.label], [5, 'lowest', '2d20 (menor)']);
    });

    test('Ordem: atributo = nº de d20 e fica o maior; atributo 0 = 2d20 e fica o menor', () => {
        assert.deepEqual(rollPool(ordem, 3, { rollDie: sequence(4, 18, 9) }).result, 18);
        const zero = rollPool(ordem, 0, { rollDie: sequence(15, 6) });
        assert.deepEqual([zero.rolls, zero.result, zero.label], [[15, 6], 6, '2d20 (menor)']);
        assert.equal(rollPool(ordem, 2, { extraDice: 1, rollDie: sequence(1, 2, 20) }).result, 20);
        assert.equal(describePool(ordem, 3), '3d20 (maior)');
        assert.equal(formatRoll(ordem, 2, 13), '2d20+13');
        assert.equal(formatRoll(dnd, 1, -1), '1d20-1');
    });

    test('soma (ex.: 3d6): vantagem descarta o menor', () => {
        const sum = normalizeDice({ countMode: 'fixed', fixedCount: 3, sides: 6, keep: 'sum', attributeBonus: 'value' });
        assert.equal(rollPool(sum, 3, { rollDie: sequence(1, 2, 3) }).result, 6);
        assert.equal(rollPool(sum, 3, { mode: 'advantage', rollDie: sequence(1, 6, 6, 6) }).result, 18);
    });
});

describe('métodos de rolagem nas fichas', () => {
    beforeEach(installGlobals);

    test('modelo Ordem: Destreza 2, Pontaria Veterano + modificador 3 = 2d20+13', async () => {
        const { system, call } = await setup([14, 7]);
        await system.applyDicePreset('ordem');
        const definition = await system.getDefinition();
        assert.equal(definition.defaultScore, 1);
        assert.deepEqual(definition.trainingLevels.map(l => [l.name, l.bonus]), [['Treinado', 5], ['Veterano', 10], ['Especialista', 15]]);
        await system.saveItem('skills', { name: 'Pontaria', attribute: 'destreza', description: 'Armas de disparo.' });

        await call('sheet_update', { attributes: { Destreza: 2 }, skills: [{ name: 'Pontaria', training: 'veterano', bonus: 3 }] });
        const sheet = await system.readSheet();
        const aim = sheet.skills.find(s => s.name === 'Pontaria');
        assert.deepEqual(aim, { name: 'Pontaria', attribute: 'Destreza', roll: '2d20+13', training: 'Veterano (+10)', extra_modifier: 3 });
        assert.deepEqual(sheet.attributes.find(a => a.name === 'Destreza'), { name: 'Destreza', score: 2, roll: '2d20' });
        assert.equal(sheet.stats.find(s => s.name === 'Defesa').total, 12, 'Defesa = 10 + valor da Destreza');

        const roll = await call('system_roll', { check: 'Pontaria', dc: 20 });
        assert.deepEqual([roll.dice, roll.rolls, roll.d20, roll.total, roll.success], ['2d20 (maior)', [14, 7], 14, 27, true]);
        assert.match(roll.summary, /Pontaria de Aria: 2d20 \(maior\) \[14, 7\] → 14 \+13 = 27 vs CD 20: sucesso/);

        const info = await call('system_info', { section: 'rules' });
        assert.match(info.rules, /as many d20 as the attribute value/);
        assert.equal(info.dice_method.preset, 'ordem');
    });

    test('treinamento pode ser tirado e os níveis renomeados', async () => {
        const { system, call } = await setup();
        await call('sheet_update', { skills: [{ name: 'Furtividade', training: 'Treinado' }] });
        assert.equal((await system.readSheet()).skills.find(s => s.name === 'Furtividade').training, 'Treinado (+2)');
        const level = (await system.getDefinition()).trainingLevels[0];
        await system.saveItem('trainingLevels', { id: level.id, name: 'Aprendiz', bonus: 3 });
        assert.equal((await system.readSheet()).skills.find(s => s.name === 'Furtividade').training, 'Aprendiz (+3)');
        await call('sheet_update', { skills: [{ name: 'Furtividade', training: 'nenhum' }] });
        assert.equal((await system.readSheet()).skills.find(s => s.name === 'Furtividade').training, undefined);
        await assert.rejects(call('sheet_update', { skills: [{ name: 'Furtividade', training: 'Lendário' }] }), /Unknown training level/);
    });

    test('modelo Direto e método personalizado (3d6 somados)', async () => {
        const { system, call } = await setup([10, 2, 3, 4]);
        await system.applyDicePreset('direto');
        await call('sheet_update', { attributes: { Força: 3 } });
        const strong = await call('system_roll', { check: 'Força' });
        assert.deepEqual([strong.dice, strong.total], ['1d20', 13]);

        const custom = await system.setDice({ keep: 'sum', sides: 6, fixedCount: 3 });
        assert.equal(custom.dice.preset, 'custom');
        const sum = await call('system_roll', { check: 'Força' });
        assert.deepEqual([sum.dice, sum.rolls, sum.total], ['3d6', [2, 3, 4], 12]);
        assert.equal(sum.natural, undefined);
    });
});

describe('itens e equipamento', () => {
    beforeEach(installGlobals);

    test('equipar dá bônus; na mochila não conta', async () => {
        const { system, call } = await setup();
        const added = await call('sheet_item', { name: 'Cota de Malha', slot: 'torso', bonus_target: 'Defesa', bonus_value: 3, description: 'Armadura média.' });
        assert.deepEqual(added.item, { name: 'Cota de Malha', description: 'Armadura média.', bonus: '+3 Defesa', location: 'Torso' });
        let sheet = await system.readSheet();
        assert.deepEqual(sheet.stats.find(s => s.name === 'Defesa'), { name: 'Defesa', total: 13, bonus: 0, from_items: 3, is_defense: true });
        assert.deepEqual(sheet.equipment, { Torso: [{ name: 'Cota de Malha', description: 'Armadura média.', bonus: '+3 Defesa' }] });

        await call('sheet_item', { action: 'desequipar', item: 'cota de malha' });
        sheet = await system.readSheet();
        assert.equal(sheet.stats.find(s => s.name === 'Defesa').total, 10);
        assert.equal(sheet.backpack[0].name, 'Cota de Malha');

        await call('sheet_item', { name: 'Luvas de Arqueiro', equip: 'Acessórios', bonus_target: 'Furtividade', bonus_value: 2 });
        assert.equal((await system.readSheet()).skills.find(s => s.name === 'Furtividade').from_items, 2);
        await assert.rejects(call('sheet_item', { name: 'Anel', slot: 'Cauda' }), /Unknown body slot/);
    });

    test('poções empilham, são consumidas e somem em 0', async () => {
        const { system, call } = await setup();
        await call('sheet_item', { name: 'Poção de Cura', quantity: 2, description: 'Cura 2d4.' });
        const stacked = await call('sheet_item', { name: 'poção de cura' });
        assert.equal(stacked.action, 'stacked');
        assert.equal((await system.readSheet()).backpack[0].quantity, 3);
        await call('sheet_item', { action: 'use', item: 'Poção de Cura', quantity_delta: -1 });
        assert.equal((await system.readSheet()).backpack[0].quantity, 2);
        const gone = await call('sheet_item', { action: 'update', item: 'Poção de Cura', quantity_delta: -5 });
        assert.equal(gone.action, 'used_up');
        assert.deepEqual((await system.readSheet()).backpack, []);
    });

    test('partes do corpo são editáveis; item numa parte apagada volta para a mochila', async () => {
        const { system, call } = await setup();
        await system.saveItem('slots', { name: 'Cauda', description: 'Para personagens com cauda.' });
        await call('sheet_item', { name: 'Laço de fita', slot: 'Cauda' });
        assert.ok((await system.readSheet()).equipment.Cauda);
        const tail = (await system.getDefinition()).slots.find(s => s.name === 'Cauda');
        await system.deleteItem('slots', tail.id);
        assert.equal((await system.readSheet()).backpack[0].name, 'Laço de fita');
    });

    test('regenerar desfaz itens ganhos e gastos', async () => {
        const { system, call } = await setup();
        await call('sheet_item', { name: 'Poção', quantity: 2 }, 'run-A');
        st.context.chat.push({ is_user: false, extra: { tauritavern: { agent: { runId: 'run-A' } } } });
        await st.context.eventSource.emit('generation_started', 'regenerate', {}, false);
        assert.deepEqual((await system.readSheet()).backpack, []);
    });
});
