// "Auto-preencher" e "Refinar" o mapa: manda à IA o conteúdo de lorebooks escolhidos (sem a cena do
// chat) e o mapa atual, com um prompt auxiliar opcional, usando a conexão atual ou um Perfil de
// Conexão separado (outro modelo/API). A resposta vem em JSON e vira uma prévia antes de aplicar.

import { LOG_PREFIX } from './util.js';

const DEFAULT_CONTEXT_CHARS = 30_000;

export const FILL_MODES = {
    fill: {
        label: 'Auto-preencher',
        instruction: 'Create the places of this world that are implied by the lore and are still missing from the current map: world-level places (continents, kingdoms, planes), regions (cities, forests, districts) and locals (taverns, shops, houses, rooms, landmarks). Keep everything already on the map; you may add sub-places and connections to existing places. Prefer places that are useful for play. If the lore is thin, invent plausible places that fit its tone.',
    },
    refine: {
        label: 'Refinar',
        instruction: 'Improve the current map: make summaries vivid and useful for play, fill empty types/summaries/details, add secrets, residents and missing connections, fix inconsistencies with the lore, and add a few missing places where the map is thin. Return the places you change (same name) with their improved fields, plus new places and connections. Do not remove anything.',
    },
};

const FORMAT = `Reply with ONLY one JSON object, no commentary, in this exact shape:
{
  "places": [
    {
      "name": "Unique place name",
      "level": "world | region | local",
      "parent": "name of the containing place (a world-level place for regions; a region or local for locals; null for world-level places)",
      "type": "short type, e.g. kingdom, city, forest, tavern, shop, temple",
      "summary": "1-2 vivid sentences, what a visitor notices (this goes into the prompt when the player is there)",
      "details": "more detail for the narrator: layout, history, services, dangers",
      "secret": "optional hidden fact only the narrator knows",
      "residents": [ { "name": "NPC name", "description": "role, 3-8 words" } ]
    }
  ],
  "connections": [
    { "from": "place name", "to": "place name", "description": "how they connect: door, road (2 days north), stairs, portal...", "two_way": true }
  ]
}
Rules: names must be unique across the whole map; connect places of the same level that are physically linked (rooms inside a building, buildings in a city, cities on roads, kingdoms by borders); write in the same language as the lore.`;

/** Perfis de Conexão (Chat Completion) disponíveis para escolher o modelo. */
export function listConnectionProfiles() {
    try {
        const service = SillyTavern.getContext().ConnectionManagerRequestService;
        if (!service?.getSupportedProfiles) return [];
        return service.getSupportedProfiles().map(profile => ({
            id: profile.id,
            name: profile.name || profile.id,
            model: profile.model || '',
        }));
    } catch (error) {
        console.warn(LOG_PREFIX, 'Perfis de Conexão indisponíveis', error);
        return [];
    }
}

/** Junta o conteúdo das entradas dos lorebooks escolhidos, até um limite de caracteres. */
export async function buildLoreContext(books, { maxChars = DEFAULT_CONTEXT_CHARS } = {}) {
    const context = SillyTavern.getContext();
    const parts = [];
    let used = 0;
    let truncated = false;
    for (const book of books) {
        let data;
        try {
            data = await context.loadWorldInfo(book);
        } catch (error) {
            console.warn(LOG_PREFIX, `Não consegui ler o lorebook ${book}`, error);
            continue;
        }
        const entries = Object.values(data?.entries ?? {}).filter(entry => !entry.disable && String(entry.content ?? '').trim());
        if (!entries.length) continue;
        parts.push(`## Lorebook: ${book}`);
        for (const entry of entries) {
            const title = entry.comment || (entry.key ?? []).join(', ') || `Entry ${entry.uid}`;
            const block = `### ${title}\n${String(entry.content).trim()}`;
            if (used + block.length > maxChars) {
                truncated = true;
                break;
            }
            parts.push(block);
            used += block.length;
        }
        if (truncated) break;
    }
    return { text: parts.join('\n\n'), chars: used, truncated };
}

/** Monta as mensagens do pedido. */
export function buildFillMessages({ mode, lore, outline, worldName, extraPrompt }) {
    const system = `You are a world-building assistant for a role-play. You design maps with three levels: world (largest areas), region (cities, wilderness areas) and local (specific places). ${FILL_MODES[mode]?.instruction ?? FILL_MODES.fill.instruction}\n\n${FORMAT}`;
    const user = [
        worldName ? `World name: ${worldName}` : null,
        `# Lore\n${lore || '(no lore provided: invent a coherent setting)'}`,
        `# Current map\n${outline || '(empty map)'}`,
        extraPrompt ? `# Extra instructions from the user (follow them)\n${extraPrompt}` : null,
        'Now reply with the JSON object only.',
    ].filter(Boolean).join('\n\n');
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** Chama a IA: perfil de conexão escolhido, ou a conexão atual (narrador) se vazio. */
export async function requestFill(messages, { profileId = '', maxTokens = 4096, signal } = {}) {
    const context = SillyTavern.getContext();
    if (profileId) {
        const service = context.ConnectionManagerRequestService;
        if (!service?.sendRequest) throw new Error('Perfis de Conexão não estão disponíveis nesta versão.');
        const response = await service.sendRequest(profileId, messages, maxTokens, {
            stream: false,
            signal: signal ?? null,
            extractData: true,
            includePreset: false,
            includeInstruct: false,
        });
        return typeof response === 'string' ? response : (response?.content ?? '');
    }
    if (typeof context.generateRaw !== 'function') throw new Error('generateRaw indisponível.');
    return context.generateRaw({
        systemPrompt: messages[0].content,
        prompt: messages[1].content,
        responseLength: maxTokens,
    });
}

/** Tira o JSON da resposta (aceita bloco ```json, texto antes/depois, objeto já parseado). */
export function parseFillResponse(response) {
    if (response && typeof response === 'object') return validatePlan(response);
    const text = String(response ?? '').trim();
    if (!text) throw new Error('A IA não respondeu nada.');
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('A resposta não tem um JSON. Tente de novo ou use outro modelo.');
    let parsed;
    try {
        parsed = JSON.parse(candidate.slice(start, end + 1));
    } catch {
        // Conserta vírgulas sobrando, um erro comum de modelos.
        try {
            parsed = JSON.parse(candidate.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1'));
        } catch (error) {
            throw new Error(`Não consegui ler o JSON da resposta (${error.message}). Tente de novo ou use outro modelo.`);
        }
    }
    return validatePlan(parsed);
}

function validatePlan(plan) {
    const places = Array.isArray(plan?.places) ? plan.places.filter(place => place && typeof place.name === 'string' && place.name.trim()) : [];
    const connections = Array.isArray(plan?.connections) ? plan.connections.filter(c => c && c.from && c.to) : [];
    if (!places.length && !connections.length) throw new Error('A resposta veio sem lugares nem conexões.');
    return { places, connections };
}
