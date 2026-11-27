// Testes do sistema de RPG (regras, fichas, recursos e testes de d20): node --test dev/
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
    st.books.set('Lyra Lore', {
        entries: {
            0: { uid: 0, comment: 'Lyra', key: ['Lyra'], content: 'Arqueira.' },
            1: { uid: 1, comment: 'Capitão Voss', key: ['Voss'], content: 'Mercenário.' },
        },
    });
    st.books.set('Chat Book', { entries: {} });
}

installGlobals();
const { createStorage } = await import('../src/storage.js');
const { StudioFS } = await import('../src/studio-fs.js');
const { LorebookService } = await import('../src/lorebook.js');
const { ActivityLog } = await import('../src/activity.js');
const { AgentToolBridge, buildToolDefinitions, STUDIO_PROFILE_ID } = await import('../src/tools.js');
const { SystemService, modifier } = await import('../src/system.js');

/** Gerador "aleatório" previsível: devolve os d20 pedidos em sequência. */
function scriptedD20(...values) {
    const queue = [...values];
    return () => ((queue.shift() ?? 10) - 1) / 20;
}

function makeServices({ random } = {}) {
    const storage = createStorage();
    const settings = { studioTools: true, loreReadTools: true, loreWriteTools: true, systemTools: true, backupsPerBook: 20 };
    const fs = new StudioFS(storage);
    const lore = new LorebookService(storage, () => settings);
    const activity = new ActivityLog(storage);
    const system = new SystemService(storage, lore, random ? { random } : undefined);
    const bridge = new AgentToolBridge({ definitions: buildToolDefinitions({ fs, lore, system }), activity, getSettings: () => settings });
    return { storage, settings, lore, activity, system, bridge };
}

describe('sistema de RPG (SystemService)', () => {
    beforeEach(installGlobals);

    test('modificador no estilo D&D', () => {
        const table = { 1: -5, 8: -1, 9: -1, 10: 0, 11: 0, 12: 1, 13: 1, 14: 2, 18: 4, 20: 5 };
        for (const [score, expected] of Object.entries(table)) assert.equal(modifier(Number(score)), expected, `valor ${score}`);
    });

    test('regras padrão e edição de atributos, perícias e recursos', async () => {
        const { system, storage, lore } = makeServices();
        const definition = await system.getDefinition();
        assert.equal(definition.attributes.length, 5);
        assert.equal(definition.skills.length, 8);
        assert.deepEqual(definition.resources.map(r => r.name), ['Vida', 'Mana']);

        const wisdom = await system.saveItem('attributes', { name: 'Sabedoria', description: 'Intuição.' });
        assert.equal(wisdom.id, 'sabedoria');
        await system.saveItem('attributes', { id: 'forca', name: 'Potência', description: 'Força bruta.' });
        await assert.rejects(system.saveItem('attributes', { name: 'potencia' }), /Já existe/);
        await system.saveItem('skills', { name: 'Intuição', attribute: 'sabedoria', description: 'Ler pessoas.' });
        await system.saveItem('resources', { name: 'Estamina', defaultMax: 6 });

        await system.deleteItem('attributes', 'sabedoria');
        const after = await system.getDefinition();
        assert.equal(after.attributes.find(a => a.id === 'forca').name, 'Potência');
        assert.equal(after.skills.find(s => s.name === 'Intuição').attribute, null);
        assert.equal(after.resources.find(r => r.name === 'Estamina').defaultMax, 6);

        const again = new SystemService(storage, lore);
        assert.equal((await again.getDefinition()).attributes.find(a => a.id === 'forca').name, 'Potência', 'as regras persistem');
    });

    test('a ficha do jogador é uma por personagem', async () => {
        const { system } = makeServices();
        const first = await system.snapshot();
        const player = first.sheets.find(s => s.location === 'player');
        assert.equal(player.name, 'Aria');
        await system.updateSheet('player', { attributes: [{ name: 'força', score: 14 }] });

        st.switchChat('chat-2');
        const sameCharacter = await system.readSheet();
        assert.equal(sameCharacter.attributes.find(a => a.name === 'Força').score, 14);

        st.switchChat('chat-3', { characterId: 1 });
        const otherCharacter = await system.readSheet();
        assert.equal(otherCharacter.attributes.find(a => a.name === 'Força').score, 10);
        assert.notEqual(otherCharacter.id, sameCharacter.id);
    });

    test('fichas de NPC ficam no chat', async () => {
        const { system } = makeServices();
        const goblin = await system.createSheet({ name: 'Goblin', resources: [{ name: 'Vida', max: 7, current: 7 }] });
        assert.equal(goblin.location, 'chat');
        assert.ok(st.chats.get('chat-1').agent_studio.sheets[goblin.id]);
        assert.ok(st.stats.metadataSaves > 0);
        await assert.rejects(system.createSheet({ name: 'goblin' }), /already exists/);

        st.switchChat('chat-2');
        assert.ok(!(await system.listSheets()).sheets.some(s => s.name === 'Goblin'));
        st.switchChat('chat-1');
        assert.ok((await system.listSheets()).sheets.some(s => s.name === 'Goblin'));

        await assert.rejects(system.deleteSheet('player'), /cannot be deleted/);
        await system.deleteSheet('Goblin');
        assert.equal(Object.keys(st.chats.get('chat-1').agent_studio.sheets).length, 0);
    });

    test('ficha vinculada a lorebook aparece onde o lorebook está ativo', async () => {
        const { system, lore } = makeServices();
        const voss = await system.createSheet({ name: 'Capitão Voss', linkLorebook: { book: 'Lyra Lore', uid: 1 } });
        assert.equal(voss.location, 'lorebook');
        assert.deepEqual(voss.linked_lorebook_entry, { book: 'Lyra Lore', uid: 1, title: 'Capitão Voss' });

        st.switchChat('chat-2');
        assert.ok((await system.listSheets()).sheets.some(s => s.name === 'Capitão Voss'), 'outro chat da Lyra vê a ficha');
        st.switchChat('chat-3', { characterId: 1 });
        assert.ok(!(await system.listSheets()).sheets.some(s => s.name === 'Capitão Voss'), 'Kael não usa o Lyra Lore');

        st.switchChat('chat-2', { characterId: 0 });
        const summary = await lore.read({ book: 'Lyra Lore' });
        assert.equal(summary.entries.find(e => e.uid === 1).sheet, 'Capitão Voss');

        await assert.rejects(system.createSheet({ name: 'X', linkLorebook: { book: 'Lyra Lore', uid: 9 } }), /not found/);
        await assert.rejects(system.updateSheet('player', { linkLorebook: { book: 'Lyra Lore', uid: 0 } }), /cannot be linked/);

        const unlinked = await system.updateSheet('Voss', { unlinkLorebook: true });
        assert.equal(unlinked.location, 'chat');
        assert.ok(st.chats.get('chat-2').agent_studio.sheets[voss.id]);
    });

    test('Vida e Mana ficam entre 0 e o máximo', async () => {
        const { system } = makeServices();
        const hit = await system.adjustResource('player', { resource: 'vida', delta: -15 });
        assert.deepEqual([hit.before, hit.after, hit.max], [10, 0, 10]);
        assert.match(hit.note, /reached 0/);
        const heal = await system.adjustResource(undefined, { resource: 'Vida', set: 99 });
        assert.equal(heal.after, 10);
        await system.updateSheet('player', { resources: [{ name: 'Mana', max: 20, current: 20 }] });
        const spend = await system.adjustResource('player', { resource: 'Mana', delta: -3 });
        assert.equal(spend.after, 17);
        await assert.rejects(system.adjustResource('player', { resource: 'Vida' }), /delta/);
        await assert.rejects(system.adjustResource('player', { resource: 'Sanidade', delta: 1 }), /Unknown resource/);
    });

    test('testes de d20 com perícia, atributo, vantagem e CD', async () => {
        const { system } = makeServices({ random: scriptedD20(14, 5, 17, 5, 17, 1, 20) });
        await system.updateSheet('player', { attributes: [{ name: 'Destreza', score: 14 }], skills: [{ name: 'Furtividade', bonus: 2 }] });

        const sneak = await system.roll('player', { check: 'furtividade', dc: 15 });
        assert.deepEqual([sneak.type, sneak.d20, sneak.modifier, sneak.total, sneak.success], ['skill', 14, '+4', 18, true]);
        assert.match(sneak.summary, /Furtividade de Aria: 1d20: 14 \+ 2 \(Destreza\) \+ 2 \(modificador extra\) = 18 vs CD 15 → SUCESSO \(margem \+3\)/);

        const advantage = await system.roll('player', { check: 'Destreza', mode: 'advantage' });
        assert.deepEqual([advantage.rolls, advantage.d20, advantage.total], [[5, 17], 17, 19]);
        const disadvantage = await system.roll('player', { check: 'Destreza', mode: 'disadvantage', bonus: -2 });
        assert.deepEqual([disadvantage.d20, disadvantage.total], [5, 5]);

        const fumble = await system.roll('player', { check: 'Força', dc: 5 });
        assert.equal(fumble.natural, 1);
        assert.equal(fumble.success, false);
        assert.equal(fumble.outcome, 'CRITICAL FAILURE');
        const crit = await system.roll('player', { check: 'Força' });
        assert.equal(crit.natural, 20);
        assert.equal(crit.success, undefined, 'sem CD não há sucesso/falha');
        assert.equal(crit.outcome, 'NO DC');
        assert.match(crit.read_this, /no DC given/);

        await assert.rejects(system.roll('player', { check: 'Voar' }), /Unknown check/);
    });

    test('d20 real fica entre 1 e 20', async () => {
        const { system } = makeServices();
        const seen = new Set();
        for (let i = 0; i < 400; i++) seen.add(system.d20());
        assert.ok([...seen].every(value => value >= 1 && value <= 20));
        assert.equal(seen.size, 20);
    });

    test('o Agent usa as fichas pelas ferramentas', async () => {
        const { bridge, activity } = makeServices({ random: scriptedD20(12) });
        await bridge.registerAll();
        const info = await agent.call('system_info', { section: 'attributes' });
        assert.equal(info.attributes.length, 5);
        assert.equal(info.rules, undefined);

        await agent.call('sheet_create', { name: 'Lobo', resources: [{ name: 'Vida', max: 11, current: 11 }], attributes: [{ name: 'Força', score: 13 }] });
        const list = await agent.call('sheet_list', {});
        assert.deepEqual(list.sheets.map(s => [s.name, s.location]), [['Aria', 'player'], ['Lobo', 'chat']]);
        assert.equal(list.sheets[1].resources, 'Vida 11/11, Mana 10/10');

        const bite = await agent.call('sheet_resource', { sheet: 'Aria', resource: 'Vida', delta: -4 });
        assert.equal(bite.after, 6);
        const roll = await agent.call('system_roll', { check: 'Atletismo', sheet: 'Lobo', dc: 10 });
        assert.equal(roll.total, 13);
        assert.equal(roll.success, true);
        assert.match(activity.list()[0].summary, /Atletismo de Lobo: 1d20: 12 \+ 1 \(Força\) = 13 vs CD 10 → SUCESSO \(margem \+3\)/);
        assert.match(activity.list()[1].summary, /Vida de Aria: 10 → 6\/10/);
    });

    test('o Profile Agent Studio Writer recebe as ferramentas novas sozinho', async () => {
        const { bridge } = makeServices();
        await bridge.registerAll();
        await bridge.grantToProfile(STUDIO_PROFILE_ID);
        const profile = agent.profiles.get(STUDIO_PROFILE_ID);
        profile.tools.allow = profile.tools.allow.filter(id => !id.includes(':sheet_') && !id.includes(':system_'));
        const synced = await bridge.syncStudioProfile();
        assert.equal(synced.added, 11);
        assert.equal(await bridge.syncStudioProfile(), null, 'nada a fazer na segunda vez');
    });
});
