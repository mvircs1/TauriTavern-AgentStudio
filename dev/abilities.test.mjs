// Testes de estatísticas (Defesa, Iniciativa...) e habilidades das fichas.
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
    st.books.set('Lyra Lore', { entries: {} });
}

installGlobals();
const { createStorage } = await import('../src/storage.js');
const { StudioFS } = await import('../src/studio-fs.js');
const { LorebookService } = await import('../src/lorebook.js');
const { ActivityLog } = await import('../src/activity.js');
const { AgentToolBridge, buildToolDefinitions } = await import('../src/tools.js');
const { SystemService, rollExpression } = await import('../src/system.js');
const { RollbackManager, RunJournal } = await import('../src/journal.js');

/** Dados previsíveis: cada chamada devolve o próximo valor da lista (para qualquer dado). */
function scriptedDice(...values) {
    const queue = [...values];
    return () => queue.shift() ?? 1;
}

async function setup(dice = []) {
    const storage = createStorage();
    const settings = { studioTools: true, loreReadTools: true, loreWriteTools: true, systemTools: true, undoOnRegenerate: true, backupsPerBook: 20 };
    const lore = new LorebookService(storage, () => settings);
    const system = new SystemService(storage, lore);
    const queue = scriptedDice(...dice);
    system.die = sides => Math.min(sides, queue());
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
    return { system, activity, call };
}

describe('estatísticas', () => {
    beforeEach(installGlobals);

    test('Defesa = 10 + Destreza + bônus; Iniciativa e Deslocamento padrão', async () => {
        const { system, call } = await setup();
        await call('sheet_update', { attributes: [{ name: 'Destreza', score: 14 }], stats: [{ name: 'Defesa', bonus: 2 }] });
        const sheet = await system.readSheet();
        assert.deepEqual(sheet.stats, [
            { name: 'Defesa', total: 14, bonus: 2, is_defense: true },
            { name: 'Iniciativa', total: 2, bonus: 0 },
            { name: 'Deslocamento', total: 9, bonus: 0 },
        ]);
        const list = await call('sheet_list', {});
        assert.equal(list.sheets[0].defense, 'Defesa 14');
    });

    test('regras de estatísticas são editáveis e só uma é a Defesa', async () => {
        const { system } = await setup();
        await system.saveItem('stats', { name: 'Resistência Mágica', base: 10, attribute: 'inteligencia', defense: true, description: 'Contra magias.' });
        const definition = await system.getDefinition();
        assert.deepEqual(definition.stats.filter(s => s.defense).map(s => s.name), ['Resistência Mágica']);
        await system.deleteItem('attributes', 'inteligencia');
        assert.equal((await system.getDefinition()).stats.find(s => s.name === 'Resistência Mágica').attribute, null);
    });

    test('ataque contra a Defesa do alvo com system_roll', async () => {
        const { call } = await setup([12]);
        await call('sheet_create', { name: 'Goblin', attributes: [{ name: 'Destreza', score: 12 }], stats: { Defesa: 1 } });
        const attack = await call('system_roll', { check: 'Força', target: 'goblin', reason: 'espada' });
        assert.equal(attack.dc, 12, 'Defesa do Goblin = 10 + 1 (Destreza 12) + 1');
        assert.deepEqual(attack.against, { sheet: 'Goblin', stat: 'Defesa', value: 12 });
        assert.equal(attack.success, true);
        assert.match(attack.summary, /vs Defesa 12 de Goblin → SUCESSO \(margem \+0\)/);
        assert.equal(attack.outcome, 'SUCCESS');
        assert.match(attack.read_this, /SUCCESS, by a hair \(total 12 vs Defesa 12 of Goblin, margin \+0\)\. This result is final/);
    });

    test('Iniciativa pode ser rolada como teste', async () => {
        const { call } = await setup([7]);
        await call('sheet_update', { attributes: { Destreza: 16 } });
        const roll = await call('system_roll', { check: 'iniciativa' });
        assert.deepEqual([roll.type, roll.total], ['stat', 10]);
    });
});

describe('habilidades', () => {
    beforeEach(installGlobals);

    test('rola expressões de dano com atributos', () => {
        const view = {
            attributes: [{ name: 'Força', modifier: 3 }, { name: 'Destreza', modifier: 1 }],
            skills: [{ name: 'Atletismo', total: 5 }],
            stats: [],
        };
        const dice = scriptedDice(4, 6);
        assert.deepEqual(rollExpression('2d6+FOR', view, () => dice()), { total: 13, detail: '2d6 (4+6) +FOR (+3) = 13' });
        assert.equal(rollExpression('1d8 + Destreza - 1', view, () => 5).total, 5);
        assert.equal(rollExpression('d4', view, () => 2).total, 2);
        assert.equal(rollExpression('atordoa o alvo', view, () => 1), null);
        assert.equal(rollExpression('2d6+Voar', view, () => 1), null);
    });

    test('criar, editar e remover habilidades na ficha', async () => {
        const { system, call } = await setup();
        await call('sheet_ability', {
            name: 'Bola de Fogo', description: 'Explosão de chamas.', cost: '3', cost_resource: 'mana',
            check: 'Inteligência', effect: '2d6', fields: { Alcance: '20 m', Recarga: '1x por cena' },
        });
        let sheet = await system.readSheet();
        assert.deepEqual(sheet.abilities, [{
            name: 'Bola de Fogo', description: 'Explosão de chamas.', cost: '3 Mana', check: 'Inteligência', effect: '2d6', Alcance: '20 m', Recarga: '1x por cena',
        }]);
        await assert.rejects(call('sheet_ability', { name: 'bola de fogo' }), /already has "Bola de Fogo"/);

        await call('sheet_ability', { action: 'editar', name: 'Bola de Fogo', cost: 4, fields: [{ name: 'Alcance', value: '30 m' }] });
        sheet = await system.readSheet();
        assert.equal(sheet.abilities[0].cost, '4 Mana');
        assert.equal(sheet.abilities[0].Alcance, '30 m');
        assert.equal(sheet.abilities[0].description, 'Explosão de chamas.', 'update só muda o que foi passado');

        await assert.rejects(call('sheet_ability', { name: 'Raio', check: 'Voar' }), /Unknown check/);
        await call('sheet_ability', { action: 'remove', ability: 'bola de fogo' });
        assert.deepEqual((await system.readSheet()).abilities, []);
    });

    test('usar habilidade: gasta Mana, rola contra a Defesa e aplica o dano', async () => {
        // d20 do teste = 15; efeito 2d6 = 3 + 5.
        const { system, call, activity } = await setup([15, 3, 5]);
        await call('sheet_update', { attributes: { Inteligência: 14 } });
        await call('sheet_ability', { name: 'Bola de Fogo', cost: 3, check: 'Inteligência', effect: '2d6' });
        await call('sheet_create', { name: 'Goblin', resources: [{ name: 'Vida', max: 7 }] });

        const used = await call('ability_use', { ability: 'bola de fogo', target: 'Goblin', apply: 'dano' });
        assert.deepEqual(used.cost, { resource: 'Mana', before: 10, after: 7 });
        assert.equal(used.check.total, 17);
        assert.equal(used.check.dc, 10);
        assert.equal(used.hit, true);
        assert.match(used.read_this, /Bola de Fogo used by Aria on Goblin; paid 3 Mana \(10 → 7\); HIT: SUCCESS \(total 17 vs Defesa 10\); effect 2d6 rolled 8; damage applied: Vida of Goblin 7 → 0\/7 \(reached 0!\)/);
        assert.equal(used.effect.total, 8);
        assert.deepEqual([used.applied.before, used.applied.after], [7, 0]);
        assert.match(activity.list()[0].summary, /Bola de Fogo \(Aria → Goblin\); -3 Mana; Inteligência: 1d20: 15 \+ 2 \(modificador de Inteligência\) = 17 vs Defesa 10 de Goblin → SUCESSO \(margem \+7\); efeito 2d6 \(3\+5\) = 8; Vida de Goblin 7 → 0/);

        const goblin = await system.readSheet('Goblin');
        assert.equal(goblin.resources[0].current, 0);
        assert.equal((await system.readSheet()).resources[1].current, 7);
    });

    test('errar não aplica dano, mas o custo é pago; sem Mana suficiente, recusa', async () => {
        const { system, call } = await setup([2, 6, 6]);
        await call('sheet_ability', { name: 'Raio', cost: 6, check: 'Destreza', effect: '2d6' });
        await call('sheet_create', { name: 'Guarda', stats: [{ name: 'Defesa', bonus: 5 }] });
        const miss = await call('ability_use', { ability: 'Raio', target: 'Guarda', apply: 'damage' });
        assert.equal(miss.hit, false);
        assert.deepEqual(miss.applied, { note: 'Missed: nothing applied.' });
        assert.equal((await system.readSheet('Guarda')).resources[0].current, 10);
        await assert.rejects(call('ability_use', { ability: 'Raio', target: 'Guarda' }), /Not enough Mana: Aria has 4, "Raio" costs 6/);
    });

    test('cura sem alvo vai para quem usou, até o máximo', async () => {
        const { system, call } = await setup([4]);
        await call('sheet_resource', { resource: 'Vida', delta: -6 });
        await call('sheet_ability', { name: 'Cura', cost: 2, effect: '1d4+2' });
        const healed = await call('ability_use', { ability: 'Cura', apply: 'heal' });
        assert.deepEqual([healed.applied.type, healed.applied.before, healed.applied.after], ['heal', 4, 10]);
        assert.equal((await system.readSheet()).resources[0].current, 10);
    });

    test('NPC criado já com habilidades; regenerar desfaz o uso da habilidade', async () => {
        const { system, call } = await setup([18, 6]);
        await call('sheet_create', {
            name: 'Feiticeiro',
            abilities: [{ name: 'Seta Sombria', cost: 2, cost_resource: 'Mana', check: 'Carisma', effect: '1d6' }],
        }, 'run-setup');
        assert.equal((await system.readSheet('Feiticeiro')).abilities[0].name, 'Seta Sombria');
        st.context.chat.push({ is_user: false, extra: { tauritavern: { agent: { runId: 'run-setup' } } } });
        st.context.chat.push({ is_user: true, mes: 'ataco' });

        await call('ability_use', { sheet: 'Feiticeiro', ability: 'Seta Sombria', target: 'Aria', apply: 'damage' }, 'run-B');
        assert.equal((await system.readSheet()).resources[0].current, 4);
        st.context.chat.push({ is_user: false, extra: { tauritavern: { agent: { runId: 'run-B' } } } });
        await st.context.eventSource.emit('generation_started', 'regenerate', {}, false);

        assert.equal((await system.readSheet()).resources[0].current, 10, 'Vida da Aria volta');
        assert.equal((await system.readSheet('Feiticeiro')).resources[1].current, 10, 'Mana do Feiticeiro volta');
    });
});
