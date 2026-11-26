// Testes do mapa (mundo/região/local), do bloco no prompt, do lorebook por local e do auto-preencher.
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
    st.books.set('Aetheria', {
        entries: {
            0: { uid: 0, comment: 'Taverna do Corvo', key: [], content: 'Dizem que o dono esconde um mapa no porão.', disable: false },
            1: { uid: 1, comment: 'Solenne', key: [], content: 'Cidade flutuante governada por sete torres.', disable: false },
            2: { uid: 2, comment: 'Antiga', key: [], content: 'Desativada.', disable: true },
        },
    });
}

installGlobals();
const { createStorage } = await import('../src/storage.js');
const { StudioFS } = await import('../src/studio-fs.js');
const { LorebookService } = await import('../src/lorebook.js');
const { ActivityLog } = await import('../src/activity.js');
const { AgentToolBridge, buildToolDefinitions } = await import('../src/tools.js');
const { SystemService } = await import('../src/system.js');
const { MapService, PROMPT_KEY } = await import('../src/map.js');
const { LocationPrompt } = await import('../src/map-prompt.js');
const { RollbackManager, RunJournal } = await import('../src/journal.js');
const { buildFillMessages, buildLoreContext, parseFillResponse, requestFill } = await import('../src/map-fill.js');

async function setup() {
    const storage = createStorage();
    const settings = { studioTools: true, loreReadTools: true, loreWriteTools: true, systemTools: true, mapTools: true, mapPrompt: true, mapLore: true, undoOnRegenerate: true, backupsPerBook: 20 };
    const lore = new LorebookService(storage, () => settings);
    const system = new SystemService(storage, lore);
    const map = new MapService(storage, lore, system);
    const activity = new ActivityLog(storage);
    const fs = new StudioFS(storage);
    const journal = new RunJournal(storage, { getChatId: () => st.context.getCurrentChatId() });
    fs.journal = journal;
    lore.journal = journal;
    system.journal = journal;
    map.journal = journal;
    new RollbackManager({ journal, fs, lore, system, map, activity, getSettings: () => settings }).install();
    const prompt = new LocationPrompt({ map, system, getSettings: () => settings });
    prompt.install();
    const bridge = new AgentToolBridge({ definitions: buildToolDefinitions({ fs, lore, system, map }), activity, getSettings: () => settings });
    await bridge.registerAll();
    const call = (name, args, runId = 'run-1') => agent.call(name, args, { runId });
    return { map, system, prompt, settings, call };
}

async function buildTown(call, runId) {
    await call('map_create', { name: 'Aetheria', level: 'world', type: 'reino', summary: 'Ilhas que flutuam sobre um mar de nuvens.' }, runId);
    await call('map_create', { name: 'Solenne', level: 'region', parent: 'Aetheria', type: 'cidade', summary: 'Capital de pontes e torres.' }, runId);
    await call('map_create', {
        name: 'Taverna do Corvo', parent: 'Solenne', type: 'taverna', summary: 'Barulhenta, cheira a cerveja e fumaça.',
        residents: [{ name: 'Mira', description: 'taverneira' }], move_player_here: true,
    }, runId);
    await call('map_create', { name: 'Porão', parent: 'Taverna do Corvo', connect_to: [{ place: 'Taverna do Corvo', description: 'alçapão', locked: true }], known: false }, runId);
    await call('map_create', { name: 'Rua do Mercado', parent: 'Solenne', connect_to: [{ place: 'Taverna do Corvo', description: 'porta da frente' }] }, runId);
    await call('map_create', { name: 'Passagem Secreta', parent: 'Solenne', connect_to: [{ place: 'Taverna do Corvo', hidden: true }] }, runId);
}

describe('mapa', () => {
    beforeEach(installGlobals);

    test('sem mapa, a IA recebe a orientação de criar lugares', async () => {
        const { call } = await setup();
        const look = await call('map_look', {});
        assert.equal(look.world, null);
        assert.match(look.note, /map_create/);
    });

    test('a IA constrói mundo › região › local e se move', async () => {
        const { call } = await setup();
        await buildTown(call);
        const look = await call('map_look', {});
        assert.equal(look.world, 'Mundo de Lyra');
        assert.equal(look.path, 'Aetheria › Solenne › Taverna do Corvo');
        assert.equal(look.player_is_here, true);
        assert.deepEqual(look.residents, ['Mira — taverneira']);
        assert.deepEqual(look.inside, ['Porão [unexplored]']);
        assert.ok(look.exits.includes('Porão — alçapão [locked, unexplored]'));
        assert.ok(look.exits.includes('Passagem Secreta [hidden]'));

        await assert.rejects(call('map_create', { name: 'Bairro', level: 'region', parent: 'Taverna do Corvo' }), /region must be inside a world-level place/);
        await assert.rejects(call('map_create', { name: 'taverna do corvo', parent: 'Solenne' }), /already exists/);

        const moved = await call('map_move', { to: 'porao' });
        assert.equal(moved.to, 'Porão');
        assert.equal((await call('map_look', {})).known_to_player, true);
        const found = await call('map_search', { query: 'cerveja' });
        assert.deepEqual(found.results.map(r => r.path), ['Aetheria › Solenne › Taverna do Corvo']);
    });

    test('local sem pai vai para a região atual', async () => {
        const { call } = await setup();
        await buildTown(call);
        const created = await call('map_create', { name: 'Ferraria', summary: 'Martelos o dia todo.' });
        assert.equal(created.path, 'Aetheria › Solenne › Ferraria');
    });

    test('bloco no prompt: só o local atual, saídas visíveis e quem está lá', async () => {
        const { call, system, prompt } = await setup();
        await buildTown(call);
        await system.createSheet({ name: 'Voss' });
        await call('map_move', { who: 'Voss', to: 'Taverna do Corvo' });
        const text = await prompt.refresh();
        assert.match(text, /^\[Localização atual: Aetheria › Solenne › Taverna do Corvo \(taverna\)\]/);
        assert.match(text, /Barulhenta, cheira a cerveja e fumaça\./);
        assert.match(text, /Saídas: Porão \(alçapão, trancada, inexplorado\); Rua do Mercado \(porta da frente\)\./);
        assert.doesNotMatch(text, /Passagem Secreta/, 'conexões escondidas não vão para o prompt');
        assert.match(text, /Presentes: Mira \(taverneira\); Voss\./);
        assert.deepEqual(st.context.extensionPrompts[PROMPT_KEY], { value: text, position: 1, depth: 2, scan: true, role: 0 });
    });

    test('mover residente sem ficha e NPC com ficha', async () => {
        const { call, system } = await setup();
        await buildTown(call);
        await call('map_move', { who: 'mira', to: 'Rua do Mercado' });
        assert.deepEqual((await call('map_look', { place: 'Rua do Mercado' })).residents, ['Mira — taverneira']);
        assert.equal((await call('map_look', {})).residents, undefined);
        await system.createSheet({ name: 'Voss' });
        await call('map_move', { who: 'Voss', to: 'Rua do Mercado' });
        assert.deepEqual((await call('map_look', { place: 'Rua do Mercado' })).npcs_with_sheets_here, ['Voss']);
        await assert.rejects(call('map_move', { who: 'Fantasma', to: 'Porão' }), /not the player, an NPC sheet or a resident/);
    });

    test('o nome do jogador (ou a ficha dele) move o jogador; o painel marca os lugares de cima como conhecidos', async () => {
        const { call, map, system } = await setup();
        await buildTown(call);
        const moved = await call('map_move', { who: 'Aria', to: 'Rua do Mercado' });
        assert.equal(moved.moved, 'player');
        assert.ok((await system.listSheets()).sheets.some(sheet => sheet.kind === 'player' && sheet.name === 'Aria'));
        const snapshot = await map.snapshot();
        assert.ok(snapshot.sheets.every(sheet => sheet.name !== 'Aria'), 'a ficha do jogador não aparece como NPC');

        const porao = Object.values(snapshot.world.places).find(place => place.name === 'Porão');
        await map.setPosition({ placeId: porao.id });
        const state = (await map.snapshot()).state;
        const names = state.known.map(id => snapshot.world.places[id].name);
        for (const name of ['Porão', 'Taverna do Corvo', 'Solenne', 'Aetheria']) assert.ok(names.includes(name), name);
    });

    test('lorebook por local: ativa só as entradas do lugar atual (e não as desativadas)', async () => {
        const { call, prompt } = await setup();
        await buildTown(call);
        await call('map_update', { place: 'Solenne', link_lorebook: [{ book: 'Aetheria', uid: 1 }] });
        await call('map_update', { link_lorebook: [{ book: 'aetheria', uid: 0 }, { book: 'Aetheria', uid: 2 }] });
        const received = [];
        st.context.eventSource.on('worldinfo_force_activate', entries => received.push(...entries));
        const count = await prompt.activateLore();
        assert.equal(count, 2);
        assert.deepEqual(received.map(e => [e.world, e.uid]).sort(), [['Aetheria', 0], ['Aetheria', 1]]);

        received.length = 0;
        await call('map_move', { to: 'Rua do Mercado' });
        await prompt.activateLore();
        assert.deepEqual(received.map(e => e.uid), [1], 'fora da taverna, só a entrada da cidade');
    });

    test('desativar o bloco no prompt limpa o texto', async () => {
        const { call, prompt, settings } = await setup();
        await buildTown(call);
        settings.mapPrompt = false;
        assert.equal(await prompt.refresh(), '');
        assert.equal(st.context.extensionPrompts[PROMPT_KEY].value, '');
    });

    test('o mundo é por personagem; a posição é por chat', async () => {
        const { call, map } = await setup();
        await buildTown(call);
        st.switchChat('chat-2');
        const look = await call('map_look', {});
        assert.equal(look.world, 'Mundo de Lyra');
        assert.match(look.note, /position is not set/);
        st.switchChat('chat-3', { characterId: 1 });
        assert.equal((await call('map_look', {})).world, null);
        const worlds = (await map.snapshot()).worlds;
        assert.equal(worlds.length, 1);
    });

    test('regenerar desfaz lugares, posição e o mundo criado na resposta', async () => {
        const { call, map } = await setup();
        await buildTown(call, 'run-A');
        st.context.chat.push({ is_user: false, extra: { tauritavern: { agent: { runId: 'run-A' } } } });
        await st.context.eventSource.emit('generation_started', 'regenerate', {}, false);
        const snapshot = await map.snapshot();
        assert.equal(snapshot.worlds.length, 0);
        assert.equal(snapshot.state.position, null);
        assert.equal((await call('map_look', {}, 'run-B')).world, null);
    });

    test('excluir lugar com coisas dentro exige recursive', async () => {
        const { call } = await setup();
        await buildTown(call);
        await assert.rejects(call('map_delete', { place: 'Taverna do Corvo' }), /recursive/);
        const deleted = await call('map_delete', { place: 'Taverna do Corvo', recursive: true });
        assert.equal(deleted.places_removed, 2);
        assert.match((await call('map_look', {})).note, /position is not set/);
    });
});

describe('auto-preencher e refinar', () => {
    beforeEach(installGlobals);

    const plan = {
        places: [
            { name: 'Taverna do Corvo', level: 'local', parent: 'Solenne', type: 'taverna', summary: 'Lugar de mercenários.' },
            { name: 'Aetheria', level: 'world', type: 'reino', summary: 'Reino flutuante.' },
            { name: 'Solenne', level: 'region', parent: 'Aetheria', type: 'cidade', summary: 'Capital.', residents: [{ name: 'Rainha Elis', description: 'governante' }] },
            { name: 'Bosque Cinzento', level: 'region', parent: 'Aetheria', type: 'floresta' },
        ],
        connections: [{ from: 'Solenne', to: 'Bosque Cinzento', description: 'estrada, 1 dia a leste', two_way: true }, { from: 'Solenne', to: 'Lugar Nenhum' }],
    };

    test('lê JSON em bloco ```json, com texto em volta e vírgula sobrando', () => {
        const text = 'Aqui está:\n```json\n{"places": [{"name": "A", "level": "world"},], "connections": []}\n```\nPronto!';
        assert.deepEqual(parseFillResponse(text), { places: [{ name: 'A', level: 'world' }], connections: [] });
        assert.throws(() => parseFillResponse('sem json'), /não tem um JSON/);
        assert.throws(() => parseFillResponse('{"places": []}'), /sem lugares/);
    });

    test('prévia e aplicação: cria na ordem certa, liga e avisa o que ignorou; desfazer volta', async () => {
        const { map } = await setup();
        const preview = await map.previewPlan(plan, 'fill');
        assert.deepEqual(preview.created.map(p => `${p.name}<${p.parent ?? '-'}`), ['Aetheria<-', 'Solenne<Aetheria', 'Bosque Cinzento<Aetheria', 'Taverna do Corvo<Solenne']);
        assert.deepEqual(preview.connections, ['Solenne ↔ Bosque Cinzento']);
        assert.match(preview.problems.join(' '), /Lugar Nenhum/);
        assert.equal((await map.snapshot()).world, null, 'a prévia não grava nada');

        const applied = await map.applyPlan(plan, 'fill', 'Teste');
        assert.equal(applied.created, 4);
        const world = (await map.snapshot()).world;
        assert.equal(Object.keys(world.places).length, 4);
        const solenne = Object.values(world.places).find(p => p.name === 'Solenne');
        assert.deepEqual(solenne.residents, [{ name: 'Rainha Elis', description: 'governante' }]);

        const refine = await map.applyPlan({ places: [{ name: 'Solenne', summary: 'Capital de pontes douradas.' }, { name: 'Aetheria', summary: '' }] }, 'refine', 'Refino');
        assert.equal(refine.updated, 1);
        const refined = Object.values((await map.snapshot()).world.places).find(p => p.name === 'Solenne');
        assert.equal(refined.summary, 'Capital de pontes douradas.');

        const fill = await map.applyPlan({ places: [{ name: 'Solenne', summary: 'Outra coisa.' }] }, 'fill', 'Preencher');
        assert.equal(fill.updated, 0, 'preencher não reescreve campos que já têm texto');

        assert.equal(await map.undoLastFill(), 'Preencher');
        assert.equal(await map.undoLastFill(), 'Refino');
        const back = Object.values((await map.snapshot()).world.places).find(p => p.name === 'Solenne');
        assert.equal(back.summary, 'Capital.');
    });

    test('monta o contexto só com o lorebook (entradas ativas) e o mapa atual', async () => {
        const { map, call } = await setup();
        await call('map_create', { name: 'Aetheria', level: 'world' });
        const lore = await buildLoreContext(['Aetheria']);
        assert.match(lore.text, /### Taverna do Corvo\nDizem que o dono esconde um mapa no porão\./);
        assert.doesNotMatch(lore.text, /Desativada/);
        const outline = await map.outline();
        const messages = buildFillMessages({ mode: 'refine', lore: lore.text, outline: outline.text, worldName: outline.worldName, extraPrompt: 'Foque em lugares urbanos.' });
        assert.equal(messages[0].role, 'system');
        assert.match(messages[0].content, /Improve the current map/);
        assert.match(messages[1].content, /- \[world\] Aetheria/);
        assert.match(messages[1].content, /Foque em lugares urbanos\./);
    });

    test('usa o Perfil de Conexão escolhido, ou a conexão atual', async () => {
        const calls = [];
        st.context.ConnectionManagerRequestService = {
            async sendRequest(profileId, messages, maxTokens, custom) {
                calls.push({ profileId, messages, maxTokens, custom });
                return { content: '{"places": [{"name": "X"}]}', reasoning: '' };
            },
            getSupportedProfiles: () => [{ id: 'p1', name: 'Gemini Flash', model: 'gemini-2.5-flash' }],
        };
        st.context.generateRaw = async ({ systemPrompt, prompt }) => `{"places": [{"name": "${systemPrompt.length > 0 && prompt.length > 0 ? 'Y' : 'Z'}"}]}`;
        const messages = buildFillMessages({ mode: 'fill', lore: '', outline: '', extraPrompt: '' });
        assert.equal(parseFillResponse(await requestFill(messages, { profileId: 'p1', maxTokens: 2000 })).places[0].name, 'X');
        assert.equal(calls[0].profileId, 'p1');
        assert.equal(calls[0].maxTokens, 2000);
        assert.equal(calls[0].custom.includePreset, false);
        assert.equal(parseFillResponse(await requestFill(messages)).places[0].name, 'Y');
    });
});
