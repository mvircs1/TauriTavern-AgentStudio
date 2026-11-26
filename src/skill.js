// Instala/atualiza a Skill "agent-studio" no TauriTavern (window.__TAURITAVERN__.api.skill),
// para o Agent saber como usar as ferramentas do plugin.

export const SKILL_NAME = 'agent-studio';

function skillApi() {
    return globalThis.__TAURITAVERN__?.api?.skill;
}

export function isSkillApiAvailable() {
    const api = skillApi();
    return typeof api?.installImport === 'function' && typeof api?.previewImport === 'function';
}

async function loadBundledSkill() {
    const response = await fetch(new URL('../skill/agent-studio/SKILL.md', import.meta.url));
    if (!response.ok) throw new Error(`Não encontrei o SKILL.md do plugin (HTTP ${response.status}).`);
    return response.text();
}

/**
 * Instala a Skill se ela não existir, ou substitui se a instalada for diferente da que vem com o plugin.
 * @param {{ loadContent?: () => Promise<string> }} [options] loadContent é substituível nos testes
 * @returns {Promise<{ status: 'unavailable'|'up-to-date'|'installed'|'replaced'|string }>}
 */
export async function syncSkill({ loadContent = loadBundledSkill } = {}) {
    if (!isSkillApiAvailable()) return { status: 'unavailable' };
    const api = skillApi();
    const content = await loadContent();
    const input = {
        kind: 'inlineFiles',
        files: [{ path: 'SKILL.md', encoding: 'utf8', content, mediaType: 'text/markdown' }],
    };
    const preview = await api.previewImport(input);
    if (preview?.conflict?.kind === 'same') return { status: 'up-to-date' };
    const result = await api.installImport({ input, conflictStrategy: 'replace' });
    return { status: result?.action ?? 'installed' };
}

/** @returns {Promise<{ available: boolean, installed: boolean, version?: string }>} */
export async function skillStatus() {
    const api = skillApi();
    if (typeof api?.list !== 'function') return { available: false, installed: false };
    const list = await api.list();
    const entry = (Array.isArray(list) ? list : []).find(item => item.name === SKILL_NAME);
    return { available: true, installed: Boolean(entry), version: entry?.version };
}
