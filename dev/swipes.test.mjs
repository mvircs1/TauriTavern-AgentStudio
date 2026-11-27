// Swipes: ao trocar de swipe, o que a run da swipe na tela fez volta, e o das outras é desfeito.
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
    st.books.set('Lyra Lore', { entries: { 0: { uid: 0, comment: 'Lyra', key: ['Lyra'], content: 'Arqueira.', position: 0, order: 100 } } });
}

installGlobals();
const { createStorage } = await import('../src/storage.js');
const { StudioFS } = await import('../src/studio-fs.js');
const { LorebookService } = await import('../src/lorebook.js');
const { ActivityLog } = await import('../src/activity.js');
const { AgentToolBridge, buildToolDefinitions } = await import('../src/tools.js');
const { SystemService } = await import('../src/system.js');
const { MapService } = await import('../src/map.js');
const { RollbackManager, RunJournal, currentRunIdOfMessage } = await import('../src/journal.js');

async function setup() {
    const storage = createStorage();
    const settings = { studioTools: true, loreReadTools: true, loreWriteTools: true, systemTools: true, mapTools: true, campaignTools: true, undoOnRegenerate: true, backupsPerBook: 20 };
    const fs = new StudioFS(storage);
    const lore = new LorebookService(storage, () => settings);
    const activity = new ActivityLog(storage);
    const system = new SystemService(storage, lore);
    const map = new MapService(storage, lore, system);
    const journal = new RunJournal(storage, { getChatId: () => st.context.getCurrentChatId() });
    fs.journal = journal;
    lore.journal = journal;
    system.journal = journal;
    map.journal = journal;
    const rollback = new RollbackManager({ journal, fs, lore, system, map, activity, getSettings: () => settings });
    rollback.install();
    const bridge = new AgentToolBridge({ definitions: buildToolDefinitions({ fs, lore, system, map }), activity, getSettings: () => settings });
    await bridge.registerAll();
    const call = (name, args, runId) => agent.call(name, args, { runId });
    return { fs, lore, system, map, journal, rollback, call };
}

const agentExtra = runId => ({ tauritavern: { agent: { version: 2, runId } } });
const emit = (type, ...args) => st.context.eventSource.emit(type, ...args);

/** Estado resumido de tudo o que as runs mexem. */
async function state({ fs, lore, system, map }) {
    const files = (await fs.list({})).files.map(file => file.path).sort();
    const entries = Object.values((await lore.loadBook('Lyra Lore')).entries).map(entry => entry.comment).sort();
    const sheets = (await system.listSheets()).sheets.map(sheet => `${sheet.name} ${sheet.resources}`).sort();
    const snapshot = await map.snapshot();
    const places = snapshot.world ? Object.values(snapshot.world.places).map(place => place.name).sort() : [];
    const here = snapshot.state.position ? snapshot.world.places[snapshot.state.position]?.name ?? null : null;
    return { files, entries, sheets, places, here };
}

function lastMessage(runId) {
    const message = { is_user: false, mes: 'A', extra: agentExtra(runId), swipe_id: 0, swipes: ['A'], swipe_info: [{ extra: agentExtra(runId) }] };
    st.context.chat.push(message);
    return message;
}

describe('swipes', () => {
    beforeEach(installGlobals);

    test('qual run é a da swipe na tela', () => {
        assert.equal(currentRunIdOfMessage({ extra: agentExtra('a') }), 'a');
        const message = { extra: agentExtra('a'), swipe_id: 1, swipe_info: [{ extra: agentExtra('a') }] };
        assert.equal(currentRunIdOfMessage(message), null, 'swipe nova ainda sem resposta');
        message.swipe_info.push({ extra: agentExtra('b') });
        assert.equal(currentRunIdOfMessage(message), 'b');
    });

    test('voltar para uma swipe refaz o que a run dela fez; ir para outra desfaz', async () => {
        const services = await setup();
        const { call } = services;
        await call('studio_write', { path: 'base.md', content: 'antes de tudo' }, 'run-0');
        const before = await state(services);

        // Swipe 1 (run A).
        await call('studio_write', { path: 'notas/a.md', content: 'versão A' }, 'run-A');
        await call('lorebook_create_entry', { book: 'Lyra Lore', entry: { comment: 'Torre A', key: ['torre'], content: 'A' } }, 'run-A');
        await call('sheet_create', { name: 'Goblin A' }, 'run-A');
        await call('map_create', { name: 'Floresta', level: 'world', move_player_here: true }, 'run-A');
        const message = lastMessage('run-A');
        await emit('message_received', 0);
        const stateA = await state(services);
        assert.ok(stateA.files.includes('notas/a.md'));
        assert.equal(stateA.here, 'Floresta');

        // Nova swipe: o ST muda swipe_id e avisa MESSAGE_SWIPED antes de gerar.
        message.swipe_id = 1;
        await emit('message_swiped', 0);
        assert.deepEqual(await state(services), before, 'a swipe nova começa sem o que A fez');
        await emit('generation_started', 'swipe', {}, false);

        // Swipe 2 (run B) faz outras coisas.
        await call('studio_write', { path: 'notas/b.md', content: 'versão B' }, 'run-B');
        await call('studio_edit', { path: 'base.md', old_string: 'antes', new_string: 'depois' }, 'run-B');
        await call('sheet_create', { name: 'Lobo B' }, 'run-B');
        await call('map_create', { name: 'Montanha', level: 'world', move_player_here: true }, 'run-B');
        message.swipes.push('B');
        message.swipe_info.push({ extra: agentExtra('run-B') });
        message.extra = agentExtra('run-B');
        const stateB = await state(services);
        assert.equal(stateB.here, 'Montanha');

        // Volta para a swipe 1.
        message.swipe_id = 0;
        message.extra = agentExtra('run-A');
        await emit('message_swiped', 0);
        assert.deepEqual(await state(services), stateA);
        assert.equal((await services.fs.read({ path: 'base.md' })).content, 'antes de tudo');

        // E de novo para a 2.
        message.swipe_id = 1;
        message.extra = agentExtra('run-B');
        await emit('message_swiped', 0);
        assert.deepEqual(await state(services), stateB);
        assert.equal((await services.fs.read({ path: 'base.md' })).content, 'depois de tudo');

        // Apagar a swipe 2 (a da tela): a 1 volta e o que B fez some.
        message.swipes.splice(1, 1);
        message.swipe_info.splice(1, 1);
        message.swipe_id = 0;
        message.extra = agentExtra('run-A');
        await emit('message_swiped', 0);
        assert.deepEqual(await state(services), stateA);

        // Regenerar descarta tudo.
        await emit('generation_started', 'regenerate', {}, false);
        assert.deepEqual(await state(services), before);
    });

    test('lorebook criado numa swipe some e volta com ela', async () => {
        const services = await setup();
        const { call, lore } = services;
        await call('lorebook_create_book', { name: 'Bestiário' }, 'run-A');
        await call('lorebook_create_entry', { book: 'Bestiário', entry: { comment: 'Wyvern', key: ['wyvern'], content: 'Voa.' } }, 'run-A');
        const message = lastMessage('run-A');
        message.swipe_id = 1;
        await emit('message_swiped', 0);
        assert.ok(!(await lore.bookNames({ refresh: true })).includes('Bestiário'));
        message.swipe_id = 0;
        await emit('message_swiped', 0);
        assert.ok((await lore.bookNames({ refresh: true })).includes('Bestiário'));
        assert.equal(Object.values((await lore.loadBook('Bestiário')).entries)[0].comment, 'Wyvern');
    });

    test('trocar a swipe de uma mensagem que não é a última não mexe em nada', async () => {
        const services = await setup();
        await services.call('studio_write', { path: 'x.md', content: 'x' }, 'run-A');
        const message = lastMessage('run-A');
        message.swipe_id = 1;
        st.context.chat.push({ is_user: true, mes: 'oi' });
        await emit('message_swiped', 0);
        assert.deepEqual((await services.fs.list({})).files.map(f => f.path), ['x.md']);
    });

    test('desligado nas configurações, trocar de swipe não mexe em nada', async () => {
        const services = await setup();
        services.rollback.getSettings = () => ({ undoOnRegenerate: false });
        await services.call('studio_write', { path: 'x.md', content: 'x' }, 'run-A');
        const message = lastMessage('run-A');
        message.swipe_id = 1;
        await emit('message_swiped', 0);
        assert.deepEqual((await services.fs.list({})).files.map(f => f.path), ['x.md']);
    });
});
