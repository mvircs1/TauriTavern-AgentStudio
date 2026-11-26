// Testes da lógica do Agent Studio sem navegador: node --test dev/
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { assertPortableSchema, createAgentMock, createExtensionStoreMock, createSillyTavernMock } from './mocks.mjs';

let st;
let agent;
let store;

function installGlobals() {
    st = createSillyTavernMock();
    agent = createAgentMock();
    store = createExtensionStoreMock();
    globalThis.SillyTavern = st.SillyTavern;
    globalThis.__TAURITAVERN__ = { api: { agent: agent.api, extension: { store } } };
    globalThis.fetch = async () => ({ ok: false });
}

installGlobals();
const { createStorage } = await import('../src/storage.js');
const { StudioFS } = await import('../src/studio-fs.js');
const { LorebookService, sanitizeEntryFields } = await import('../src/lorebook.js');
const { ActivityLog } = await import('../src/activity.js');
const { AgentToolBridge, buildToolDefinitions, STUDIO_PROFILE_ID } = await import('../src/tools.js');
const { SystemService, modifier } = await import('../src/system.js');
const { normalizePath } = await import('../src/util.js');

/** Gerador "aleatório" previsível: devolve os d20 pedidos em sequência. */
function scriptedD20(...values) {
    const queue = [...values];
    return () => ((queue.shift() ?? 10) - 1) / 20;
}

function makeServices({ backupsPerBook = 20, random } = {}) {
    const storage = createStorage();
    const settings = { studioTools: true, loreReadTools: true, loreWriteTools: true, systemTools: true, backupsPerBook };
    const fs = new StudioFS(storage);
    const lore = new LorebookService(storage, () => settings);
    const activity = new ActivityLog(storage);
    const system = new SystemService(storage, lore, random ? { random } : undefined);
    const bridge = new AgentToolBridge({ definitions: buildToolDefinitions({ fs, lore, system }), activity, getSettings: () => settings });
    return { storage, settings, fs, lore, activity, system, bridge };
}

describe('caminhos', () => {
    test('normaliza barras, espaços e "."', () => {
        assert.equal(normalizePath(' /mundos\\Aetheria/./geo.md/ '), 'mundos/Aetheria/geo.md');
        assert.equal(normalizePath('', { allowRoot: true }), '');
    });
    test('recusa .., vazio e caracteres inválidos', () => {
        assert.throws(() => normalizePath('a/../b'), /\.\./);
        assert.throws(() => normalizePath(''), /required/);
        assert.throws(() => normalizePath('a/b?.md'), /cannot contain/);
    });
    test('aceita acentos', () => {
        assert.equal(normalizePath('Personagens/Ânima/descrição.md'), 'Personagens/Ânima/descrição.md');
    });
});

describe('estúdio (StudioFS)', () => {
    beforeEach(installGlobals);

    test('usa o extension store do TT com chaves válidas', async () => {
        const { storage, fs } = makeServices();
        assert.equal(storage.kind, 'tauritavern');
        await fs.write({ path: 'mundos/Aetheria/geografia.md', content: 'Montanhas ao norte.' });
        assert.ok([...store.data.keys()].every(key => key.startsWith('agent_studio/')));
    });

    test('escreve, lê, acrescenta e lista', async () => {
        const { fs } = makeServices();
        const created = await fs.write({ path: 'mundos/Aetheria/geografia.md', content: 'linha 1\nlinha 2' });
        assert.equal(created.created, true);
        await fs.write({ path: 'mundos/Aetheria/geografia.md', content: '\nlinha 3', mode: 'append' });
        const read = await fs.read({ path: 'mundos/Aetheria/geografia.md' });
        assert.equal(read.content, 'linha 1\nlinha 2\nlinha 3');
        assert.equal(read.total_lines, 3);

        await fs.write({ path: 'personagens/Lyra.md', content: 'Arqueira.' });
        const all = await fs.list();
        assert.deepEqual(all.folders, ['mundos', 'mundos/Aetheria', 'personagens']);
        assert.equal(all.total_files, 2);
        const shallow = await fs.list({ path: 'mundos', recursive: false });
        assert.deepEqual(shallow.folders, ['mundos/Aetheria']);
        assert.equal(shallow.files.length, 0);
    });

    test('lê em páginas por linha e por caracteres', async () => {
        const { fs } = makeServices();
        const text = Array.from({ length: 10 }, (_, i) => `linha ${i + 1}`).join('\n');
        await fs.write({ path: 'a.md', content: text });
        const page = await fs.read({ path: 'a.md', startLine: 3, lineCount: 2 });
        assert.equal(page.content, 'linha 3\nlinha 4');
        assert.equal(page.next_start_line, 5);
        const cut = await fs.read({ path: 'a.md', maxChars: 12 });
        assert.equal(cut.truncated, true);
        assert.equal(cut.next_start_line, cut.end_line);
    });

    test('edit exige trecho exato e único', async () => {
        const { fs } = makeServices();
        await fs.write({ path: 'a.md', content: 'gato e gato e cão' });
        await assert.rejects(fs.edit({ path: 'a.md', oldString: 'gato', newString: 'leão' }), /matches 2 places/);
        await assert.rejects(fs.edit({ path: 'a.md', oldString: 'rato', newString: 'x' }), /not found/);
        await fs.edit({ path: 'a.md', oldString: 'cão', newString: 'lobo $& $1' });
        assert.equal((await fs.read({ path: 'a.md' })).content, 'gato e gato e lobo $& $1');
        const all = await fs.edit({ path: 'a.md', oldString: 'gato', newString: 'leão', replaceAll: true });
        assert.equal(all.replacements, 2);
    });

    test('pastas, conflitos arquivo/pasta e mover', async () => {
        const { fs } = makeServices();
        await fs.makeFolder({ path: 'vazia' });
        assert.ok((await fs.list()).folders.includes('vazia'));
        await fs.write({ path: 'notas.md', content: 'x' });
        await assert.rejects(fs.write({ path: 'notas.md/sub.md', content: 'y' }), /is a file/);
        await assert.rejects(fs.write({ path: 'vazia', content: 'y' }), /is a folder/);

        await fs.move({ from: 'notas.md', to: 'vazia' });
        assert.equal((await fs.read({ path: 'vazia/notas.md' })).content, 'x');

        await fs.write({ path: 'mundos/A/geo.md', content: 'geo' });
        const moved = await fs.move({ from: 'mundos', to: 'arquivo/mundos-antigos' });
        assert.equal(moved.files_moved, 1);
        assert.equal((await fs.read({ path: 'arquivo/mundos-antigos/A/geo.md' })).content, 'geo');
        await assert.rejects(fs.move({ from: 'arquivo', to: 'arquivo/dentro' }), /inside itself/);
        await assert.rejects(fs.read({ path: 'mundos/A/geo.md' }), /not found/i);

        const toRoot = await fs.move({ from: 'vazia/notas.md', to: '' });
        assert.equal(toRoot.to, 'notas.md');
    });

    test('excluir vai para a lixeira e restaura com outro nome se houver conflito', async () => {
        const { fs } = makeServices();
        await fs.write({ path: 'pasta/a.md', content: 'A' });
        await fs.write({ path: 'pasta/b.md', content: 'B' });
        const deleted = await fs.delete({ path: 'pasta' });
        assert.equal(deleted.files, 2);
        assert.equal((await fs.list()).total_files, 0);
        assert.equal((await fs.listTrash()).length, 2);

        await fs.write({ path: 'pasta/a.md', content: 'novo A' });
        const trashA = (await fs.listTrash()).find(item => item.path === 'pasta/a.md');
        const restored = await fs.restoreFromTrash(trashA.id);
        assert.equal(restored.path, 'pasta/a (restaurado).md');
        assert.equal((await fs.read({ path: restored.path })).content, 'A');

        assert.equal(await fs.emptyTrash(), 1);
        assert.equal((await fs.listTrash()).length, 0);
    });

    test('a pasta continua existindo quando o último arquivo sai dela', async () => {
        const { fs } = makeServices();
        await fs.write({ path: 'mundos/Aetheria/geo.md', content: 'x' });
        await fs.delete({ path: 'mundos/Aetheria/geo.md' });
        assert.deepEqual((await fs.list()).folders, ['mundos', 'mundos/Aetheria']);
        await fs.write({ path: 'a/b.md', content: 'y' });
        await fs.move({ from: 'a/b.md', to: 'c.md' });
        assert.ok((await fs.list()).folders.includes('a'));
    });

    test('busca em nomes e conteúdo', async () => {
        const { fs } = makeServices();
        await fs.write({ path: 'personagens/Lyra.md', content: 'Nasceu em Aetheria.\nUsa um arco élfico.' });
        await fs.write({ path: 'mundos/Aetheria.md', content: 'Capital: Solenne.' });
        const result = await fs.search({ query: 'aetheria' });
        assert.deepEqual(result.results.map(r => [r.path, r.line]), [
            ['mundos/Aetheria.md', null],
            ['personagens/Lyra.md', 1],
        ]);
        const scoped = await fs.search({ query: 'arco', path: 'personagens' });
        assert.equal(scoped.results[0].line, 2);
    });

    test('o índice persiste entre instâncias', async () => {
        const { fs, storage } = makeServices();
        await fs.write({ path: 'x/y.md', content: 'persistiu' });
        const again = new StudioFS(storage);
        assert.equal((await again.read({ path: 'x/y.md' })).content, 'persistiu');
    });

    test('operações concorrentes não perdem arquivos', async () => {
        const { fs, storage } = makeServices();
        await Promise.all(Array.from({ length: 20 }, (_, i) => fs.write({ path: `lote/${i}.md`, content: String(i) })));
        const again = new StudioFS(storage);
        assert.equal((await again.list()).total_files, 20);
    });
});

describe('lorebooks (LorebookService)', () => {
    beforeEach(installGlobals);

    function seed() {
        st.books.set('Lyra Lore', {
            entries: {
                0: { uid: 0, comment: 'Lyra', key: ['Lyra'], keysecondary: [], content: 'Lyra é uma arqueira de Aetheria.', constant: false, disable: false, position: 0, order: 100 },
                1: { uid: 1, comment: 'Aetheria', key: ['Aetheria', 'reino'], keysecondary: [], content: 'Reino nas nuvens.', constant: false, disable: false, position: 4, depth: 2, order: 100 },
            },
        });
        st.books.set('Chat Book', { entries: {} });
        st.books.set('Outro', { entries: {} });
    }

    test('lista com onde cada livro está ativo', async () => {
        seed();
        const { lore } = makeServices();
        const result = await lore.list({ includeCounts: true });
        const byName = Object.fromEntries(result.books.map(book => [book.name, book]));
        assert.deepEqual(byName['Lyra Lore'].active_for, ['character']);
        assert.deepEqual(byName['Chat Book'].active_for, ['chat']);
        assert.deepEqual(byName.Outro.active_for, []);
        assert.equal(byName['Lyra Lore'].entries, 2);
        assert.equal(result.current_character, 'Lyra');
    });

    test('lê resumo e entradas completas; sugere nomes parecidos', async () => {
        seed();
        const { lore } = makeServices();
        const summary = await lore.read({ book: 'Lyra Lore' });
        assert.equal(summary.total_entries, 2);
        assert.equal(summary.entries[1].position, 'at_depth');
        assert.equal(summary.entries[1].depth, 2);
        const full = await lore.read({ book: 'lyra lore', uids: [1, 9] });
        assert.equal(full.entries[0].content, 'Reino nas nuvens.');
        assert.deepEqual(full.missing_uids, [9]);
        assert.equal((await lore.read({ book: 'Lyra' })).book, 'Lyra Lore', 'nome parcial inequívoco é aceito');
        st.books.set('Lyra Extra', { entries: {} });
        await assert.rejects(lore.read({ book: 'Lyra' }), /Did you mean: "Lyra Extra", "Lyra Lore"/);
    });

    test('busca por título, chave e conteúdo', async () => {
        seed();
        const { lore } = makeServices();
        const result = await lore.search({ query: 'aetheria' });
        assert.equal(result.results.length, 2);
        const reino = result.results.find(r => r.uid === 1);
        assert.deepEqual(reino.matched_in, ['title', 'keys']);
    });

    test('cria entrada com template, aliases e aviso sem chaves', async () => {
        seed();
        const { lore } = makeServices();
        const created = await lore.createEntry({ book: 'Lyra Lore', fields: { title: 'Solenne', keys: 'Solenne, capital', content: 'A capital.' }, runId: 'r1' });
        assert.equal(created.uid, 2);
        const entry = st.books.get('Lyra Lore').entries[2];
        assert.equal(entry.comment, 'Solenne');
        assert.deepEqual(entry.key, ['Solenne', 'capital']);
        assert.equal(entry.selective, true);
        assert.equal(entry.probability, 100);
        assert.equal(entry.addMemo, true);
        assert.equal(created.warnings.length, 0);

        const noKeys = await lore.createEntry({ book: 'Lyra Lore', fields: { content: 'solta' }, runId: 'r1' });
        assert.equal(noKeys.warnings.length, 1);
    });

    test('valida campos e ignora os desconhecidos', () => {
        assert.throws(() => sanitizeEntryFields({ position: 9 }), /between 0 and 7/);
        assert.deepEqual(sanitizeEntryFields({ inventado: 1, position_name: 'x', uid: 3 }), {});
        assert.deepEqual(sanitizeEntryFields({ enabled: false, scanDepth: null }), { disable: true, scanDepth: null });
        assert.deepEqual(sanitizeEntryFields({ position: 'at depth', role: 'Assistant', constant: 'sim', order: '+150' }), { position: 4, role: 2, constant: true, order: 150 });
    });

    test('edita sem mexer no objeto do cache antes de salvar', async () => {
        seed();
        const { lore } = makeServices();
        const cached = st.books.get('Lyra Lore');
        const result = await lore.updateEntry({
            book: 'Lyra Lore',
            uid: 0,
            changes: { order: 250 },
            contentEdit: { old_string: 'arqueira', new_string: 'arqueira lendária' },
            runId: 'r1',
        });
        assert.deepEqual(result.updated_fields.sort(), ['content', 'order']);
        assert.equal(cached.entries[0].order, 100, 'o objeto antigo do cache não pode ser alterado');
        const saved = st.books.get('Lyra Lore').entries[0];
        assert.equal(saved.order, 250);
        assert.equal(saved.content, 'Lyra é uma arqueira lendária de Aetheria.');
        assert.ok(st.stats.editorReloads > 0);
        await assert.rejects(lore.updateEntry({ book: 'Lyra Lore', uid: 0 }), /Nothing to change/);
        await assert.rejects(lore.updateEntry({ book: 'Lyra Lore', uid: 42, changes: { order: 1 } }), /not found/);
    });

    test('um backup por livro por run, restauração e limite de backups', async () => {
        seed();
        const { lore } = makeServices({ backupsPerBook: 3 });
        await lore.updateEntry({ book: 'Lyra Lore', uid: 0, changes: { order: 1 }, runId: 'run-A' });
        await lore.updateEntry({ book: 'Lyra Lore', uid: 0, changes: { order: 2 }, runId: 'run-A' });
        await lore.deleteEntry({ book: 'Lyra Lore', uid: 1, runId: 'run-A' });
        let backups = await lore.listBackups();
        assert.equal(backups.length, 1, 'mesma run = um backup só');
        assert.equal(backups[0].entries, 2);
        assert.equal(Object.keys(st.books.get('Lyra Lore').entries).length, 1);

        await lore.restoreBackup(backups[0].id);
        const restored = st.books.get('Lyra Lore');
        assert.equal(Object.keys(restored.entries).length, 2);
        assert.equal(restored.entries[0].order, 100);
        backups = await lore.listBackups();
        assert.equal(backups[0].reason, 'before_restore');

        for (const run of ['run-B', 'run-C', 'run-D']) {
            await lore.updateEntry({ book: 'Lyra Lore', uid: 0, changes: { order: 5 }, runId: run });
        }
        backups = await lore.listBackups();
        assert.equal(backups.filter(item => item.book === 'Lyra Lore').length, 3);
    });

    test('cria lorebook e recusa duplicado', async () => {
        seed();
        const { lore } = makeServices();
        const result = await lore.createBook({ name: 'Bestiário' });
        assert.equal(result.created, true);
        assert.deepEqual(st.books.get('Bestiário'), { entries: {} });
        await assert.rejects(lore.createBook({ name: 'bestiário' }), /already exists/);
        await assert.rejects(lore.createBook({ name: 'a/b' }), /cannot contain/);
    });
});

describe('ferramentas do Agent (AgentToolBridge)', () => {
    beforeEach(installGlobals);

    test('registra as 25 ferramentas com schemas portáteis e nomes válidos para o modelo', async () => {
        const { bridge } = makeServices();
        assert.equal(bridge.isAvailable(), true);
        await bridge.registerAll();
        assert.equal(bridge.errors.length, 0, JSON.stringify(bridge.errors));
        assert.equal(agent.tools.size, 25);
        for (const [id, tool] of agent.tools) {
            assert.match(tool.definition.name, /^[A-Za-z0-9_-]{1,64}$/);
            assert.ok(!/^(workspace|chat|skill|agent|worldinfo|dice|task)_/.test(tool.definition.name), `${id} colide com aliases nativos`);
            assertPortableSchema(tool.definition.inputSchema);
        }
        assert.ok(bridge.registeredIds().includes('extension/agent-studio:studio_write'));
    });

    test('o Agent usa o estúdio e os lorebooks pelas ferramentas, com registro de atividade', async () => {
        st.books.set('Lyra Lore', { entries: {} });
        const { bridge, activity } = makeServices();
        await bridge.registerAll();

        await agent.call('studio_write', { path: 'mundos/Aetheria.md', content: '# Aetheria' });
        const read = await agent.call('studio_read', { path: 'mundos/Aetheria.md' });
        assert.equal(read.content, '# Aetheria');
        await assert.rejects(agent.call('studio_read', { path: 'nada.md' }), /File not found/);

        const created = await agent.call('lorebook_create_entry', { book: 'Lyra Lore', entry: { comment: 'Aetheria', key: ['Aetheria'], content: 'Reino.' } });
        await agent.call('lorebook_update_entry', { book: 'Lyra Lore', uid: created.uid, changes: { constant: true } });
        assert.equal(st.books.get('Lyra Lore').entries[created.uid].constant, true);

        const items = activity.list();
        assert.equal(items.length, 5);
        assert.equal(items.find(item => !item.ok).tool, 'studio_read');
        assert.match(items[0].summary, /Editou a entrada #0 "Aetheria"/);
    });

    test('desligar um grupo desativa as ferramentas dele', async () => {
        const { bridge, settings } = makeServices();
        await bridge.registerAll();
        settings.loreWriteTools = false;
        await bridge.applyEnabledState();
        assert.equal(agent.tools.get('extension/agent-studio:lorebook_update_entry').enabled, false);
        assert.equal(agent.tools.get('extension/agent-studio:lorebook_read').enabled, true);
        const result = await agent.call('lorebook_delete_entry', { book: 'x', uid: 0 });
        assert.deepEqual(result, { unavailable: true });
    });

    test('cria o Profile Agent Studio Writer a partir do default-writer e atualiza sem duplicar', async () => {
        const { bridge } = makeServices();
        await bridge.registerAll();
        const first = await bridge.grantToProfile(STUDIO_PROFILE_ID);
        assert.equal(first.created, true);
        assert.equal(first.added, 25);
        const saved = agent.profiles.get(STUDIO_PROFILE_ID);
        assert.equal(saved.displayName, 'Agent Studio Writer');
        assert.ok(saved.tools.allow.includes('workspace.commit'), 'mantém as ferramentas nativas');
        assert.ok(saved.tools.allow.includes('extension/agent-studio:studio_list'));
        assert.deepEqual(agent.profiles.get('default-writer').tools.allow, ['chat.search', 'workspace.commit', 'workspace.finish']);

        const second = await bridge.grantToProfile(STUDIO_PROFILE_ID);
        assert.equal(second.created, false);
        assert.equal(second.added, 0);
        await assert.rejects(bridge.grantToProfile('nao-existe'), /não encontrado/);
    });
});
