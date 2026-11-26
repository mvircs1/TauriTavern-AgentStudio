// Testes de tolerância das ferramentas (acentos, tipos, nomes alternativos) e do desfazer ao regenerar.
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
    st.books.set('Lyra Lore', {
        entries: {
            0: { uid: 0, comment: 'Lyra', key: ['Lyra'], content: 'Arqueira do Núcleo Celeste.', position: 0, order: 100 },
        },
    });
    st.books.set('Bestiário', { entries: {} });
    st.books.set('Chat Book', { entries: {} });
}

installGlobals();
const { createStorage } = await import('../src/storage.js');
const { StudioFS } = await import('../src/studio-fs.js');
const { LorebookService } = await import('../src/lorebook.js');
const { ActivityLog } = await import('../src/activity.js');
const { AgentToolBridge, buildToolDefinitions } = await import('../src/tools.js');
const { SystemService } = await import('../src/system.js');
const { RollbackManager, RunJournal } = await import('../src/journal.js');

function scriptedD20(...values) {
    const queue = [...values];
    return () => ((queue.shift() ?? 10) - 1) / 20;
}

async function setup({ random } = {}) {
    const storage = createStorage();
    const settings = { studioTools: true, loreReadTools: true, loreWriteTools: true, systemTools: true, undoOnRegenerate: true, backupsPerBook: 20 };
    const fs = new StudioFS(storage);
    const lore = new LorebookService(storage, () => settings);
    const activity = new ActivityLog(storage);
    const system = new SystemService(storage, lore, random ? { random } : undefined);
    const journal = new RunJournal(storage, { getChatId: () => st.context.getCurrentChatId() });
    fs.journal = journal;
    lore.journal = journal;
    system.journal = journal;
    const rollback = new RollbackManager({ journal, fs, lore, system, activity, getSettings: () => settings });
    rollback.install();
    const bridge = new AgentToolBridge({ definitions: buildToolDefinitions({ fs, lore, system }), activity, getSettings: () => settings });
    await bridge.registerAll();
    const call = (name, args, runId = 'run-1') => agent.call(name, args, { runId });
    return { storage, settings, fs, lore, activity, system, journal, rollback, bridge, call };
}

/** Simula o commit da resposta da run no chat (como o TauriTavern faz). */
function commitMessage(runId, swipeRunIds) {
    const message = { is_user: false, mes: 'resposta', extra: { tauritavern: { agent: { version: 2, runId } } } };
    if (swipeRunIds) {
        message.swipe_info = swipeRunIds.map(id => ({ extra: { tauritavern: { agent: { version: 2, runId: id } } } }));
    }
    st.context.chat.push(message);
    return message;
}

const generationStarted = (type, dryRun = false) => st.context.eventSource.emit('generation_started', type, {}, dryRun);

describe('ferramentas tolerantes', () => {
    beforeEach(installGlobals);

    test('caminhos ignoram acentos, maiúsculas, forma Unicode e extensão', async () => {
        const { call } = await setup();
        await call('studio_write', { path: 'personagens/Ânima.md', content: 'Espírito do vento.' });
        const nfd = 'personagens/Ânima.md';
        assert.equal((await call('studio_read', { path: nfd })).content, 'Espírito do vento.');
        assert.equal((await call('studio_read', { path: 'Personagens/anima' })).path, 'personagens/Ânima.md');

        const written = await call('studio_write', { path: 'PERSONAGENS/Lyra', content: 'Arqueira.' });
        assert.equal(written.path, 'personagens/Lyra.md', 'reaproveita a pasta existente e põe .md');
        const again = await call('studio_write', { path: 'personagens/lyra.md', content: 'Arqueira élfica.' });
        assert.equal(again.created, false, 'não cria um arquivo duplicado só por causa da caixa');

        const moved = await call('studio_move', { from: 'personagens/lyra', to: 'personagens/Lyra-Antiga.md' });
        assert.equal(moved.to, 'personagens/Lyra-Antiga.md');
    });

    test('edição acha o trecho mesmo com acento decomposto, \\r\\n ou espaços no fim', async () => {
        const { call } = await setup();
        await call('studio_write', { path: 'a.md', content: 'Coração do reino   \nlinha 2' });
        const edited = await call('studio_edit', { path: 'a.md', old_string: 'Coração do reino\r\nlinha 2', new_string: 'Centro do reino\nlinha 2' });
        assert.equal(edited.replacements, 1);
        assert.equal((await call('studio_read', { path: 'a.md' })).content, 'Centro do reino\nlinha 2');
    });

    test('busca ignora acentos', async () => {
        const { call } = await setup();
        await call('studio_write', { path: 'notas.md', content: 'A ação começa no Núcleo.' });
        const result = await call('studio_search', { query: 'acao comeca' });
        assert.equal(result.results.length, 1);
        assert.match(result.results[0].snippet, /ação começa/);
        const lore = await call('lorebook_search', { query: 'nucleo celeste' });
        assert.equal(lore.results[0].uid, 0);
    });

    test('nomes alternativos de parâmetros, tipos em texto e argumentos como JSON', async () => {
        const { call } = await setup({ random: scriptedD20(15) });
        await call('studio_write', { file_path: 'x.md', text: 'um dois um' });
        await call('studio_edit', { file: 'x.md', old: 'um', new: '1', replace_all: 'true' });
        assert.equal((await call('studio_read', '{"path": "x.md"}')).content, '1 dois 1');
        await call('studio_write', { path: 'x.md', content: 'três', mode: 'acrescentar' });
        assert.equal((await call('studio_read', { path: 'x.md' })).content, '1 dois 1\ntrês');
        assert.equal((await call('studio_list', { recursive: 'false' })).total_files, 1);

        const hit = await call('sheet_resource', { character: 'aria', resource: 'vida', damage: 3 });
        assert.deepEqual([hit.before, hit.after], [10, 7]);
        await call('sheet_update', { attributes: { Destreza: 14 }, skills: { furtividade: '2' } });
        const roll = await call('system_roll', { skill: 'teste de Furtividade', difficulty: '15', advantage: true });
        assert.equal(roll.check, 'Furtividade');
        assert.equal(roll.mode, 'advantage');
        assert.equal(roll.dc, 15);
    });

    test('lorebooks: nome sem acento, campos soltos e saída do read copiada de volta', async () => {
        const { call } = await setup();
        const created = await call('lorebook_create_entry', { lorebook: 'bestiario', comment: 'Lobo Cinzento', keys: 'lobo, lobos', content: 'Caça em matilha.' });
        assert.equal(created.book, 'Bestiário');
        const entry = st.books.get('Bestiário').entries[created.uid];
        assert.deepEqual(entry.key, ['lobo', 'lobos']);

        const full = await call('lorebook_read', { book: 'BESTIARIO.json', uids: [created.uid] });
        const copied = { ...full.entries[0], content: 'Caça em matilha à noite.' };
        const updated = await call('lorebook_update_entry', { book: 'Bestiário', uid: String(created.uid), changes: copied });
        assert.ok(updated.updated_fields.includes('content'));
        assert.equal(updated.warnings, undefined, 'campos só de leitura são ignorados sem aviso');

        await call('lorebook_update_entry', { book: 'Bestiário', uid: created.uid, content: 'Texto solto no topo.', posicao: 1 });
        assert.equal(st.books.get('Bestiário').entries[created.uid].content, 'Texto solto no topo.');
    });

    test('o erro mostra ao modelo quais argumentos chegaram', async () => {
        const { call } = await setup();
        await assert.rejects(call('studio_read', { caminho: 'nada.md' }), /arguments received: caminho/);
    });
});

describe('desfazer ao regenerar', () => {
    beforeEach(installGlobals);

    async function runChanges(call, runId) {
        await call('studio_write', { path: 'diario.md', content: 'Dia 1.' }, runId);
        await call('lorebook_create_entry', { book: 'Lyra Lore', entry: { comment: 'Ruína', key: ['ruína'], content: 'Templo caído.' } }, runId);
        await call('sheet_resource', { resource: 'Vida', delta: -4 }, runId);
        await call('sheet_create', { name: 'Goblin' }, runId);
    }

    test('regenerar volta arquivos, lorebooks e fichas ao estado de antes da resposta', async () => {
        const { call, fs, system, activity } = await setup();
        await fs.write({ path: 'mundo.md', content: 'Versão do usuário.' });
        await runChanges(call, 'run-A');
        await call('studio_edit', { path: 'mundo.md', old_string: 'usuário', new_string: 'Agent' }, 'run-A');
        commitMessage('run-A');

        await generationStarted('regenerate');

        assert.equal((await fs.read({ path: 'mundo.md' })).content, 'Versão do usuário.');
        await assert.rejects(fs.read({ path: 'diario.md' }), /not found/);
        assert.equal((await fs.listTrash()).length, 1, 'o arquivo criado vai para a lixeira');
        assert.equal(Object.keys(st.books.get('Lyra Lore').entries).length, 1);
        const sheets = await system.listSheets();
        assert.deepEqual(sheets.sheets.map(s => s.name), ['Aria']);
        assert.equal(sheets.sheets[0].resources, 'Vida 10/10, Mana 10/10');
        assert.match(activity.list()[0].summary, /Desfeito \(regeneração\): 2 arquivo\(s\), 1 lorebook\(s\), 2 ficha\(s\)/);

        await generationStarted('regenerate');
        assert.match(activity.list()[0].summary, /Desfeito \(regeneração\)/, 'desfazer de novo não faz nada');
        assert.equal(activity.list().filter(item => item.tool === 'undo').length, 1);
    });

    test('nova swipe desfaz a swipe atual e as anteriores que ainda valiam', async () => {
        const { call, fs } = await setup();
        await call('studio_write', { path: 'a.md', content: 'A' }, 'run-A');
        await call('studio_write', { path: 'b.md', content: 'B' }, 'run-B');
        commitMessage('run-B', ['run-A', 'run-B']);

        await generationStarted('swipe');
        assert.equal((await fs.list()).total_files, 0);
    });

    test('não desfaz em dry run, geração normal ou mensagem do usuário', async () => {
        const { call, fs } = await setup();
        await call('studio_write', { path: 'a.md', content: 'A' }, 'run-A');
        commitMessage('run-A');
        await generationStarted('regenerate', true);
        await generationStarted('normal');
        assert.equal((await fs.list()).total_files, 1);
        st.context.chat.push({ is_user: true, mes: 'oi' });
        await generationStarted('regenerate');
        assert.equal((await fs.list()).total_files, 1);
    });

    test('a opção desligada não desfaz nada', async () => {
        const { call, fs, settings } = await setup();
        settings.undoOnRegenerate = false;
        await call('studio_write', { path: 'a.md', content: 'A' }, 'run-A');
        commitMessage('run-A');
        await generationStarted('regenerate');
        assert.equal((await fs.list()).total_files, 1);
    });

    test('run com erro ou cancelada sem resposta no chat é desfeita; com resposta, fica', async () => {
        const { call, fs } = await setup();
        await call('studio_write', { path: 'falhou.md', content: 'x' }, 'run-F');
        await agent.finishRun('run-F', 'run_failed');
        assert.equal((await fs.list()).total_files, 0);

        await call('studio_write', { path: 'ok.md', content: 'y' }, 'run-OK');
        await agent.finishRun('run-OK', 'run_completed');
        await call('studio_write', { path: 'parcial.md', content: 'z' }, 'run-P');
        commitMessage('run-P');
        await agent.finishRun('run-P', 'run_cancelled');
        assert.deepEqual((await fs.list()).files.map(f => f.path), ['ok.md', 'parcial.md']);
    });

    test('lorebook criado pela run é apagado; ficha de lorebook e vínculos voltam', async () => {
        const { call, system } = await setup();
        await call('lorebook_create_book', { name: 'Facções' }, 'run-A');
        const voss = await call('sheet_create', { name: 'Voss', link_lorebook: { book: 'Lyra Lore', uid: 0 } }, 'run-A');
        assert.equal(voss.location, 'lorebook');
        commitMessage('run-A');
        await generationStarted('regenerate');
        assert.ok(!st.books.has('Facções'));
        assert.ok(!(await system.listSheets()).sheets.some(s => s.name === 'Voss'));
    });

    test('mudanças do próprio usuário (sem run) não entram no desfazer', async () => {
        const { call, fs, system } = await setup();
        await fs.write({ path: 'meu.md', content: 'meu' });
        await system.adjustResource('player', { resource: 'Vida', delta: -2 });
        await call('studio_write', { path: 'agent.md', content: 'x' }, 'run-A');
        commitMessage('run-A');
        await generationStarted('regenerate');
        assert.deepEqual((await fs.list()).files.map(f => f.path), ['meu.md']);
        assert.equal((await system.readSheet()).resources[0].current, 8);
    });
});
