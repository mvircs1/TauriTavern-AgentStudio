// Testes da Skill agent-studio: formato, cobertura das ferramentas e instalação automática.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import { createAgentMock, createExtensionStoreMock, createSillyTavernMock, createSkillMock } from './mocks.mjs';

const skillPath = new URL('../skill/agent-studio/SKILL.md', import.meta.url);
const content = await readFile(skillPath, 'utf8');

const st = createSillyTavernMock();
const agent = createAgentMock();
const skillApi = createSkillMock();
globalThis.SillyTavern = st.SillyTavern;
globalThis.__TAURITAVERN__ = { api: { agent: agent.api, extension: { store: createExtensionStoreMock() }, skill: skillApi } };

const { createStorage } = await import('../src/storage.js');
const { StudioFS } = await import('../src/studio-fs.js');
const { LorebookService } = await import('../src/lorebook.js');
const { SystemService } = await import('../src/system.js');
const { buildToolDefinitions } = await import('../src/tools.js');
const { SKILL_NAME, skillStatus, syncSkill } = await import('../src/skill.js');

describe('Skill agent-studio', () => {
    test('tem o frontmatter que o TauriTavern exige e cabe numa leitura', () => {
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
        assert.ok(frontmatter, 'SKILL.md precisa começar com frontmatter YAML');
        assert.match(frontmatter, /^name: agent-studio$/m);
        assert.match(frontmatter, /^description: .{40,}$/m);
        assert.match(frontmatter, /^version: \d+\.\d+\.\d+$/m);
        assert.ok(content.length < 20_000, `SKILL.md tem ${content.length} caracteres; o skill_read padrão lê 20000`);
    });

    test('cita todas as ferramentas registradas pelo plugin', () => {
        const storage = createStorage();
        const lore = new LorebookService(storage, () => ({ backupsPerBook: 20 }));
        const definitions = buildToolDefinitions({ fs: new StudioFS(storage), lore, system: new SystemService(storage, lore) });
        const missing = definitions.map(d => d.name).filter(name => !content.includes(`\`${name}\``));
        assert.deepEqual(missing, [], `ferramentas sem menção no SKILL.md: ${missing.join(', ')}`);
    });

    test('instala, reconhece que está atualizada e substitui versões antigas', async () => {
        const load = async () => content;
        assert.deepEqual(await syncSkill({ loadContent: load }), { status: 'installed' });
        assert.deepEqual(await syncSkill({ loadContent: load }), { status: 'up-to-date' });
        const status = await skillStatus();
        assert.equal(status.installed, true);
        assert.match(status.version, /^\d+\.\d+\.\d+$/);

        skillApi.installed.set(SKILL_NAME, { name: SKILL_NAME, version: '0.0.1', content: 'versão antiga' });
        assert.deepEqual(await syncSkill({ loadContent: load }), { status: 'replaced' });
        assert.equal(skillApi.installed.get(SKILL_NAME).content, content);
    });
});
