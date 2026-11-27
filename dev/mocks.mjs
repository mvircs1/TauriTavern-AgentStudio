// Simulações do SillyTavern (getContext + World Info) e da API do TauriTavern
// (extension.store, agent.tools, agent.profiles), seguindo as regras lidas no código-fonte do TT 2.4.0.

const STORE_COMPONENT = /^[A-Za-z0-9_.-]+$/;

function validateComponent(label, value) {
    const trimmed = String(value ?? '').trim();
    if (!trimmed || trimmed.startsWith('.') || !STORE_COMPONENT.test(trimmed)) {
        throw new Error(`Invalid extension store ${label}`);
    }
    return trimmed;
}

export function createExtensionStoreMock() {
    const data = new Map();
    const fullKey = ({ namespace, table = 'main', key }) => [
        validateComponent('namespace', namespace),
        validateComponent('table', table),
        validateComponent('key', key),
    ].join('/');
    return {
        data,
        async tryGetJson(input) {
            const key = fullKey(input);
            return data.has(key) ? { found: true, value: structuredClone(data.get(key)) } : { found: false };
        },
        async getJson(input) {
            const key = fullKey(input);
            if (!data.has(key)) throw new Error(`Extension store entry not found: ${key}`);
            return structuredClone(data.get(key));
        },
        async setJson(input) {
            data.set(fullKey(input), JSON.parse(JSON.stringify(input.value)));
        },
        async deleteJson(input) {
            const key = fullKey(input);
            if (!data.has(key)) throw new Error(`Extension store entry not found: ${key}`);
            data.delete(key);
        },
    };
}

const ALLOWED_SCHEMA_KEYS = new Set(['type', 'description', 'properties', 'required', 'items', 'enum']);

/** Garante que o schema é portátil (sem keywords que alguns provedores recusam). */
export function assertPortableSchema(schema, path = 'inputSchema') {
    for (const key of Object.keys(schema)) {
        if (!ALLOWED_SCHEMA_KEYS.has(key)) throw new Error(`${path}: keyword não portátil "${key}"`);
    }
    if (typeof schema.type !== 'string') throw new Error(`${path}: "type" precisa ser uma string`);
    if (schema.enum && schema.type !== 'string') throw new Error(`${path}: enum só em strings`);
    if (schema.type === 'object' && !Object.keys(schema.properties ?? {}).length) {
        throw new Error(`${path}: objeto sem properties (o Gemini recusa)`);
    }
    if (schema.properties) {
        for (const [name, child] of Object.entries(schema.properties)) assertPortableSchema(child, `${path}.${name}`);
    }
    if (schema.items) assertPortableSchema(schema.items, `${path}[]`);
    if (schema.required) {
        for (const name of schema.required) {
            if (!schema.properties?.[name]) throw new Error(`${path}: required "${name}" não existe em properties`);
        }
    }
}

export function createAgentMock() {
    const tools = new Map();
    const profiles = new Map();
    profiles.set('default-writer', {
        schemaVersion: 5,
        kind: 'tauritavern.agentProfile',
        id: 'default-writer',
        displayName: 'Default Writer',
        description: 'General creative writing.',
        preset: { mode: 'currentPromptSnapshot' },
        model: { mode: 'currentPromptSnapshot' },
        run: { presentation: 'foreground', stream: true, directRunnable: true },
        tools: { allow: ['chat.search', 'workspace.commit', 'workspace.finish'], deny: [] },
        skills: { visible: ['*'], deny: [] },
        workspace: { visibleRoots: ['output'], writableRoots: ['output'] },
        plan: { mode: 'none' },
        output: { artifacts: [] },
    });

    const api = {
        tools: {
            async register(definition, execute) {
                if (typeof execute !== 'function') throw new TypeError('An extension tool execute function is required');
                const { extensionId, name, description, inputSchema, contexts } = definition;
                if (!String(extensionId ?? '').trim() || !String(name ?? '').trim()) throw new Error('extension.tool_identity_required');
                if (String(extensionId).includes(':')) throw new Error('tool.provider_id_invalid');
                if (!String(description ?? '').trim() || !Array.isArray(contexts) || !contexts.length) throw new Error('extension.tool_definition_invalid');
                if (contexts.some(context => context !== 'chat' && context !== 'session')) throw new Error('invalid contexts');
                if (!inputSchema || inputSchema.type !== 'object') throw new Error('extension.tool_schema_invalid');
                const id = `extension/${extensionId}:${name}`;
                if (tools.has(id)) throw new Error('extension.tool_already_registered');
                tools.set(id, { definition, execute, enabled: definition.enabled ?? true });
            },
            async setEnabled(id, enabled) {
                const tool = tools.get(id);
                if (!tool) throw new Error('extension.tool_not_registered');
                tool.enabled = enabled;
            },
            async list() {
                return {
                    tools: [...tools].map(([id, tool]) => ({
                        id,
                        nativeName: tool.definition.name,
                        source: 'extension',
                        extensionId: tool.definition.extensionId,
                        enabled: tool.enabled,
                    })),
                    diagnostics: [],
                };
            },
        },
        profiles: {
            async list() {
                return { profiles: [...profiles.values()].map(p => ({ id: p.id, displayName: p.displayName })), issues: [] };
            },
            async load(input) {
                const id = typeof input === 'string' ? input : input?.profileId;
                return { profile: profiles.has(id) ? structuredClone(profiles.get(id)) : null };
            },
            async save(input) {
                const profile = input?.profile ?? input;
                if (!profile || typeof profile !== 'object') throw new Error('agent.profile_required');
                if (profile.schemaVersion !== 5) throw new Error('agent.profile_schema_unsupported');
                if (!/^[a-z0-9_-]{1,128}$/.test(profile.id)) throw new Error('invalid profile id');
                const previous = profiles.get(profile.id);
                const before = new Set(previous?.tools?.allow ?? []);
                for (const id of profile.tools.allow) {
                    if (id.startsWith('extension/') && !before.has(id) && !tools.has(id)) {
                        throw new Error(`extension.tool_unavailable: load the extension before enabling ${id}`);
                    }
                }
                if (new Set(profile.tools.allow).size !== profile.tools.allow.length) throw new Error('duplicate allow entries');
                profiles.set(profile.id, structuredClone(profile));
            },
        },
    };

    // Acompanhamento de runs: subscribe(runId, handler) recebe eventos; finishRun simula o fim.
    const subscribers = new Map();
    api.subscribe = (runId, handler) => {
        subscribers.set(runId, handler);
        return () => subscribers.delete(runId);
    };
    async function finishRun(runId, type) {
        subscribers.get(runId)?.({ seq: 99, id: 'e', runId, timestamp: new Date().toISOString(), level: 'info', type, payload: {} });
        await new Promise(resolve => setTimeout(resolve, 10));
    }

    /** Simula o runtime do Agent chamando uma ferramenta. */
    async function call(name, args, context = {}) {
        const entry = [...tools.values()].find(tool => tool.definition.name === name);
        if (!entry) throw new Error(`tool ${name} not registered`);
        if (!entry.enabled) return { unavailable: true };
        return entry.execute(args, { runId: 'run-1', invocationId: 'inv-1', callId: 'call-1', target: { kind: 'chat' }, signal: new AbortController().signal, attachImage() {}, ...context });
    }

    return { api, tools, profiles, call, subscribers, finishRun };
}

export function createSillyTavernMock() {
    const books = new Map();
    const stats = { saves: 0, editorReloads: 0, metadataSaves: 0 };
    const extensionSettings = {};
    const chats = new Map([['chat-1', { world_info: 'Chat Book' }]]);
    const state = { chatId: 'chat-1' };
    // eventSource como o do ST: emit espera cada listener, em ordem.
    const listeners = new Map();
    const eventSource = {
        on(type, listener) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(listener);
        },
        async emit(type, ...args) {
            for (const listener of listeners.get(type) ?? []) await listener(...args);
        },
    };
    const context = {
        name1: 'Aria',
        chat: [],
        eventSource,
        eventTypes: {
            GENERATION_STARTED: 'generation_started',
            CHAT_CHANGED: 'chat_id_changed',
            WORLDINFO_FORCE_ACTIVATE: 'worldinfo_force_activate',
            MESSAGE_SWIPED: 'message_swiped',
            MESSAGE_RECEIVED: 'message_received',
            CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
        },
        async deleteWorldInfo(name) {
            books.delete(name);
        },
        // Como no ST: guarda os blocos que extensões põem no prompt.
        extensionPrompts: {},
        setExtensionPrompt(key, value, position, depth, scan, role) {
            context.extensionPrompts[key] = { value, position, depth, scan, role };
        },
        getCurrentChatId: () => state.chatId,
        get chatMetadata() {
            return state.chatId ? chats.get(state.chatId) : undefined;
        },
        async saveMetadata() {
            stats.metadataSaves++;
        },
        extensionSettings,
        saveSettingsDebounced() {},
        getWorldInfoNames: () => [...books.keys()],
        async updateWorldInfoList() {},
        // Como no ST: devolve o próprio objeto do cache (quem edita precisa clonar).
        async loadWorldInfo(name) {
            if (!books.has(name)) throw new Error(`World info read failed for ${name}`);
            return books.get(name);
        },
        async saveWorldInfo(name, data) {
            books.set(name, data);
            stats.saves++;
        },
        reloadWorldInfoEditor() {
            stats.editorReloads++;
        },
        characters: [
            { name: 'Lyra', avatar: 'Lyra.png', data: { extensions: { world: 'Lyra Lore' } } },
            { name: 'Kael', avatar: 'Kael.png', data: { extensions: {} } },
        ],
        characterId: 0,
        powerUserSettings: {},
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    };
    /** Simula abrir outro chat (opcionalmente de outro personagem). */
    function switchChat(chatId, { characterId = context.characterId, metadata = {} } = {}) {
        if (!chats.has(chatId)) chats.set(chatId, metadata);
        state.chatId = chatId;
        context.characterId = characterId;
    }
    return { context, books, stats, chats, switchChat, SillyTavern: { getContext: () => context, libs: {} } };
}

/** Simula window.__TAURITAVERN__.api.skill (importação de Skills com SKILL.md + frontmatter YAML). */
export function createSkillMock() {
    const installed = new Map();
    const parse = files => {
        const markdown = files.find(file => file.path === 'SKILL.md')?.content ?? '';
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
        if (!frontmatter) throw new Error('SKILL.md must start with YAML frontmatter');
        const field = key => (new RegExp(`^${key}:\s*(.+)$`, 'm').exec(frontmatter[1])?.[1] ?? '').trim();
        const name = field('name');
        if (!/^[a-z0-9_-]+$/.test(name)) throw new Error(`invalid skill name "${name}"`);
        if (!field('description')) throw new Error('description is required');
        return { name, version: field('version'), content: markdown };
    };
    return {
        installed,
        async previewImport(input) {
            const skill = parse(input.files);
            const current = installed.get(skill.name);
            const kind = !current ? 'new' : current.content === skill.content ? 'same' : 'different';
            return { skill: { name: skill.name }, files: input.files, conflict: { kind }, warnings: [], source: null };
        },
        async installImport({ input, conflictStrategy }) {
            const skill = parse(input.files);
            const current = installed.get(skill.name);
            if (current?.content === skill.content) return { name: skill.name, action: 'already_installed' };
            if (current && conflictStrategy !== 'replace') throw new Error('skill conflict');
            installed.set(skill.name, skill);
            return { name: skill.name, action: current ? 'replaced' : 'installed' };
        },
        async list() {
            return [...installed.values()].map(skill => ({ name: skill.name, version: skill.version, description: '' }));
        },
    };
}
