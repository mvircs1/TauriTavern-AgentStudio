// Ferramentas que o modo Agent do TauriTavern pode chamar, e o registro delas via
// window.__TAURITAVERN__.api.agent.tools (TauriTavern 2.4.0+).
//
// Os schemas usam só type/description/properties/required/items/enum (de strings), para funcionar
// com qualquer provedor (alguns, como o Gemini, recusam "default", "minimum", tipos em array etc.).

import { deepNormalizeStrings, EXTENSION_ID, errorMessage, foldText, LOG_PREFIX } from './util.js';

export const STUDIO_PROFILE_ID = 'agent-studio-writer';
const BASE_PROFILE_ID = 'default-writer';

export const TOOL_GROUPS = Object.freeze({
    studio: 'studioTools',
    loreRead: 'loreReadTools',
    loreWrite: 'loreWriteTools',
    system: 'systemTools',
});

const SHEET_PARAM = { type: 'string', description: 'Sheet name or id (from sheet_list). Omit for the player\'s sheet.' };
const ATTRIBUTE_VALUES = {
    type: 'array',
    description: 'Attribute scores to set.',
    items: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Attribute name (as in system_info).' },
            score: { type: 'integer', description: 'Score; 10 is average (modifier +0).' },
        },
        required: ['name', 'score'],
    },
};
const SKILL_VALUES = {
    type: 'array',
    description: 'Skill changes: training level (from system_info "training_levels", or "none") and/or an extra free modifier added on top.',
    items: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Skill name (as in system_info).' },
            training: { type: 'string', description: 'Training level name, e.g. "Treinado", "Veterano", "Especialista", or "none".' },
            bonus: { type: 'integer', description: 'Extra free modifier (items, blessings, lasting circumstances).' },
        },
        required: ['name'],
    },
};
const RESOURCE_VALUES = {
    type: 'array',
    description: 'Resource values to set (e.g. raise max Vida).',
    items: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Resource name (e.g. Vida, Mana).' },
            max: { type: 'integer', description: 'New maximum.' },
            current: { type: 'integer', description: 'New current value (kept between 0 and max).' },
        },
        required: ['name'],
    },
};
const STAT_VALUES = {
    type: 'array',
    description: 'Stat bonuses to set (e.g. armor adds to Defesa: [{"name": "Defesa", "bonus": 2}]).',
    items: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Stat name (as in system_info), e.g. "Defesa".' },
            bonus: { type: 'integer', description: 'Bonus added to the stat (armor, shield, items).' },
        },
        required: ['name', 'bonus'],
    },
};
const ABILITY_PROPERTIES = {
    name: { type: 'string', description: 'Ability name (spell, power, technique, attack).' },
    description: { type: 'string', description: 'What it does, in a few sentences.' },
    cost: { type: 'integer', description: 'Resource cost per use (0 = free).' },
    cost_resource: { type: 'string', description: 'Resource paid, e.g. "Mana" (default Mana).' },
    check: { type: 'string', description: 'Skill, attribute or stat rolled to hit/succeed (e.g. "Arcanismo", "Força"). Omit if it always works.' },
    effect: { type: 'string', description: 'Effect: dice like "2d6+FOR" or "1d8+2" (rolled on use), or plain text.' },
    fields: {
        type: 'array',
        description: 'Extra fields defined by the user (see system_info section "abilities"), e.g. Alcance, Duração, Recarga.',
        items: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Field name, e.g. "Alcance".' },
                value: { type: 'string', description: 'Field value, e.g. "9 m".' },
            },
            required: ['name', 'value'],
        },
    },
};
const ABILITY_LIST = {
    type: 'array',
    description: 'Abilities of this character.',
    items: { type: 'object', properties: ABILITY_PROPERTIES, required: ['name'] },
};

/** Converte uma habilidade vinda do modelo (snake_case) para o formato do serviço. */
function abilityInput(args) {
    return {
        name: args.name,
        description: args.description,
        cost: args.cost,
        costResource: args.cost_resource,
        check: args.check,
        effect: args.effect,
        fields: args.fields,
    };
}

const LORE_LINK = {
    type: 'object',
    description: 'Lorebook entry of this character. A linked sheet persists outside this chat and appears in every chat where that lorebook is active.',
    properties: {
        book: { type: 'string', description: 'Lorebook name.' },
        uid: { type: 'integer', description: 'Entry uid (from lorebook_read or lorebook_search).' },
    },
    required: ['book', 'uid'],
};

const ENTRY_FIELDS_SCHEMA = {
    type: 'object',
    description: 'Lorebook entry fields. Omitted fields keep their current/default values.',
    properties: {
        comment: { type: 'string', description: 'Entry title/memo shown to the user in the editor (not sent to the model).' },
        content: { type: 'string', description: 'The text inserted into the prompt when the entry activates.' },
        key: { type: 'array', items: { type: 'string' }, description: 'Primary trigger keywords. Case-insensitive by default. A regex can be written as "/pattern/flags".' },
        keysecondary: { type: 'array', items: { type: 'string' }, description: 'Optional secondary keywords, combined with the primary ones according to selectiveLogic.' },
        selective: { type: 'boolean', description: 'Use secondary keywords (default true; only matters when keysecondary is not empty).' },
        selectiveLogic: { type: 'integer', description: 'How secondary keys combine: 0 = AND ANY (default), 1 = NOT ALL, 2 = NOT ANY, 3 = AND ALL.' },
        constant: { type: 'boolean', description: 'Always active, regardless of keywords.' },
        disable: { type: 'boolean', description: 'Disable the entry without deleting it.' },
        position: { type: 'integer', description: 'Where the content is inserted: 0 = before character definitions (default), 1 = after character definitions, 2 = top of Author\'s Note, 3 = bottom of Author\'s Note, 4 = inside the chat at "depth" (with "role"), 5 = top of example messages, 6 = bottom of example messages, 7 = outlet (only through the {{outlet::outletName}} macro).' },
        depth: { type: 'integer', description: 'Only for position 4: how many messages from the end of the chat (0 = after the last message). Default 4.' },
        role: { type: 'integer', description: 'Only for position 4: 0 = system (default), 1 = user, 2 = assistant.' },
        order: { type: 'integer', description: 'Insertion order among active entries; higher numbers are inserted later (closer to the end of the prompt). Default 100.' },
        probability: { type: 'integer', description: 'Chance (0-100) that the entry is inserted when triggered. Default 100.' },
        useProbability: { type: 'boolean', description: 'Whether "probability" is applied. Default true.' },
        group: { type: 'string', description: 'Inclusion group name(s), comma-separated. Only one entry of a group is inserted per generation.' },
        groupOverride: { type: 'boolean', description: 'Prioritize this entry inside its group (by order).' },
        groupWeight: { type: 'integer', description: 'Weight inside the group for random selection. Default 100.' },
        scanDepth: { type: 'integer', description: 'How many recent messages are scanned for this entry\'s keywords. Omit (or null) to use the global setting.' },
        caseSensitive: { type: 'boolean', description: 'Case-sensitive keyword matching. Omit (or null) to use the global setting.' },
        matchWholeWords: { type: 'boolean', description: 'Match whole words only. Omit (or null) to use the global setting.' },
        excludeRecursion: { type: 'boolean', description: 'Cannot be activated by other entries\' content (recursion).' },
        preventRecursion: { type: 'boolean', description: 'This entry\'s content will not activate other entries.' },
        delayUntilRecursion: { type: 'integer', description: 'Only activates during recursion (0 = off; a number sets the recursion level).' },
        sticky: { type: 'integer', description: 'Stays active for N messages after triggering. Omit (or null) for none.' },
        cooldown: { type: 'integer', description: 'Cannot trigger again for N messages. Omit (or null) for none.' },
        delay: { type: 'integer', description: 'Cannot trigger until the chat has at least N messages. Omit (or null) for none.' },
        outletName: { type: 'string', description: 'Outlet name, used with position 7.' },
        ignoreBudget: { type: 'boolean', description: 'Insert even if the World Info token budget is exhausted.' },
    },
};

// ---------- preparação dos argumentos (tolerância a modelos "criativos") ----------

const PATH_ALIASES = ['file_path', 'filepath', 'file', 'filename', 'file_name', 'folder', 'directory', 'dir'];
const QUERY_ALIASES = ['q', 'text', 'search', 'term', 'keyword', 'keywords'];
const SHEET_ALIASES = ['character', 'sheet_name', 'sheet_id', 'who', 'char'];

/** Nomes alternativos de parâmetros, por ferramenta: canônico -> alternativas. */
const ARG_ALIASES = {
    studio_list: { path: PATH_ALIASES },
    studio_read: { path: PATH_ALIASES, start_line: ['startLine', 'line', 'from_line', 'offset'], line_count: ['lineCount', 'lines', 'count', 'num_lines'], max_chars: ['maxChars'] },
    studio_write: { path: [...PATH_ALIASES, 'name'], content: ['text', 'body', 'data', 'contents'], mode: ['write_mode'] },
    studio_edit: {
        path: PATH_ALIASES,
        old_string: ['old_text', 'oldString', 'old', 'find', 'search', 'target'],
        new_string: ['new_text', 'newString', 'new', 'replace', 'replacement', 'with'],
        replace_all: ['replaceAll', 'all', 'global'],
    },
    studio_search: { query: QUERY_ALIASES, path: PATH_ALIASES, case_sensitive: ['caseSensitive'] },
    studio_make_folder: { path: [...PATH_ALIASES, 'name'] },
    studio_move: { from: ['source', 'src', 'old_path', 'from_path', 'path'], to: ['destination', 'dest', 'target', 'new_path', 'to_path', 'new_name'] },
    studio_delete: { path: PATH_ALIASES },
    lorebook_list: { include_counts: ['includeCounts', 'counts'] },
    lorebook_read: { book: ['lorebook', 'world', 'world_info', 'worldinfo', 'book_name', 'lorebook_name', 'name'], uids: ['ids', 'uid', 'entry_ids', 'entries'] },
    lorebook_search: { query: QUERY_ALIASES, books: ['lorebooks', 'book', 'lorebook'] },
    lorebook_create_entry: { book: ['lorebook', 'world', 'world_info', 'book_name', 'lorebook_name'], entry: ['fields', 'data', 'entry_data', 'new_entry'] },
    lorebook_update_entry: {
        book: ['lorebook', 'world', 'world_info', 'book_name', 'lorebook_name'],
        uid: ['id', 'entry', 'entry_id', 'entry_uid'],
        changes: ['fields', 'updates', 'update', 'data', 'set'],
        content_edit: ['contentEdit', 'edit', 'patch'],
    },
    lorebook_delete_entry: { book: ['lorebook', 'world', 'world_info', 'book_name', 'lorebook_name'], uid: ['id', 'entry', 'entry_id', 'entry_uid'] },
    lorebook_create_book: { name: ['book', 'lorebook', 'title', 'book_name'] },
    system_info: {},
    sheet_list: {},
    sheet_read: { sheet: [...SHEET_ALIASES, 'name'] },
    sheet_create: { name: ['character', 'sheet', 'sheet_name', 'title'], link_lorebook: ['linkLorebook', 'lorebook_entry', 'link'] },
    sheet_update: { sheet: SHEET_ALIASES, link_lorebook: ['linkLorebook', 'lorebook_entry', 'link'], unlink_lorebook: ['unlinkLorebook', 'unlink'] },
    sheet_resource: { sheet: [...SHEET_ALIASES, 'name', 'target'], resource: ['stat', 'resource_name', 'pool', 'type'], delta: ['amount', 'change', 'diff', 'value'], set: ['value_set', 'new_value', 'to'] },
    sheet_delete: { sheet: [...SHEET_ALIASES, 'name'] },
    system_roll: {
        sheet: [...SHEET_ALIASES, 'name'],
        check: ['skill', 'attribute', 'stat', 'pericia', 'atributo', 'test', 'roll'],
        dc: ['difficulty', 'cd', 'dificuldade', 'difficulty_class'],
        against: ['target', 'opponent', 'vs', 'versus', 'alvo', 'target_sheet'],
        against_stat: ['againstStat', 'defense_stat', 'target_stat'],
        mode: ['roll_mode'],
        bonus: ['modifier', 'situational_bonus', 'extra'],
        extra_dice: ['extraDice', 'dice_bonus', 'bonus_dice', 'dados_extras'],
    },
    sheet_item: {
        sheet: [...SHEET_ALIASES, 'owner'],
        item: ['item_name', 'current_name', 'old_name', 'objeto'],
        name: ['new_name', 'title'],
        quantity: ['qty', 'amount', 'count', 'quantidade'],
        quantity_delta: ['delta', 'change', 'consume'],
        slot: ['equip_slot', 'body_slot', 'location', 'place', 'local', 'parte'],
        bonus_target: ['bonus_to', 'affects', 'stat'],
        bonus_value: ['bonus', 'modifier'],
    },
    sheet_ability: {
        sheet: SHEET_ALIASES,
        ability: ['ability_name', 'current_name', 'old_name', 'skill', 'power', 'spell', 'habilidade'],
        name: ['new_name', 'title'],
        cost_resource: ['costResource', 'resource', 'cost_type', 'recurso'],
        check: ['roll', 'test', 'attack_with', 'pericia'],
        effect: ['damage', 'dice', 'efeito', 'dano'],
    },
    ability_use: {
        sheet: [...SHEET_ALIASES, 'user', 'caster', 'attacker'],
        ability: ['ability_name', 'name', 'skill', 'power', 'spell', 'habilidade'],
        target: ['against', 'opponent', 'vs', 'alvo', 'defender', 'target_sheet'],
        dc: ['difficulty', 'cd', 'dificuldade'],
        apply: ['apply_effect', 'effect_mode'],
        resource: ['apply_resource', 'damage_resource', 'target_resource'],
    },
};

/** Campos de entrada de lorebook que o modelo às vezes manda soltos, fora de "entry"/"changes". */
const ENTRY_FIELD_NAMES = new Set([
    ...Object.keys(ENTRY_FIELDS_SCHEMA.properties),
    'keys', 'keywords', 'title', 'secondary_keys', 'enabled',
]);

/** Ajustes específicos depois dos aliases. */
const ARG_FIXES = {
    studio_write: input => {
        const mode = foldText(input.mode ?? '');
        if (['add', 'acrescentar', 'anexar', 'adicionar', 'append_to_end', 'a'].includes(mode)) input.mode = 'append';
        else if (mode && mode !== 'append') input.mode = 'replace';
    },
    lorebook_create_entry: input => {
        // Campos da entrada mandados soltos no nível de cima.
        if (input.entry === undefined) {
            const entry = {};
            for (const [key, value] of Object.entries(input)) {
                if (ENTRY_FIELD_NAMES.has(key)) entry[key] = value;
            }
            if (Object.keys(entry).length) input.entry = entry;
        }
    },
    lorebook_update_entry: input => {
        if (input.changes === undefined) {
            const changes = {};
            for (const [key, value] of Object.entries(input)) {
                if (ENTRY_FIELD_NAMES.has(key)) changes[key] = value;
            }
            if (Object.keys(changes).length) input.changes = changes;
        }
        if (input.content_edit === undefined && (input.old_string !== undefined || input.old_text !== undefined)) {
            input.content_edit = { old_string: input.old_string ?? input.old_text, new_string: input.new_string ?? input.new_text ?? '' };
        }
    },
    sheet_resource: input => {
        // "damage": 4 / "heal": 3 / "spend": 2 viram delta com o sinal certo.
        if (input.delta === undefined && input.set === undefined) {
            const lose = input.damage ?? input.dano ?? input.spend ?? input.cost ?? input.gasto;
            const gain = input.heal ?? input.healing ?? input.cura ?? input.recover ?? input.restore;
            if (lose !== undefined) input.delta = -Math.abs(Number(lose));
            else if (gain !== undefined) input.delta = Math.abs(Number(gain));
        }
    },
    sheet_ability: input => {
        const action = foldText(input.action ?? '');
        if (['create', 'new', 'adicionar', 'criar', 'learn'].includes(action)) input.action = 'add';
        else if (['edit', 'change', 'modify', 'editar', 'alterar', 'set'].includes(action)) input.action = 'update';
        else if (['delete', 'del', 'forget', 'excluir', 'remover', 'apagar'].includes(action)) input.action = 'remove';
        // Para editar/remover, o nome atual pode vir em "name".
        if ((input.action === 'update' || input.action === 'remove') && input.ability === undefined && input.name !== undefined) {
            input.ability = input.name;
            delete input.name;
        }
    },
    sheet_item: input => {
        const action = foldText(input.action ?? '');
        if (['give', 'create', 'new', 'adicionar', 'criar', 'pegar', 'loot'].includes(action)) input.action = 'add';
        else if (['edit', 'change', 'equip', 'unequip', 'move', 'use', 'consume', 'editar', 'equipar', 'desequipar', 'usar'].includes(action)) input.action = 'update';
        else if (['delete', 'drop', 'discard', 'excluir', 'remover', 'largar'].includes(action)) input.action = 'remove';
        if (['unequip', 'desequipar'].includes(action) && input.slot === undefined) input.slot = 'mochila';
        if (typeof input.equip === 'string' && input.slot === undefined) input.slot = input.equip;
        if ((input.action === 'update' || input.action === 'remove') && input.item === undefined && input.name !== undefined) {
            input.item = input.name;
            delete input.name;
        }
    },
    ability_use: input => {
        const apply = foldText(input.apply ?? '');
        if (input.apply_damage === true || ['dano', 'damage', 'hurt', 'attack'].includes(apply)) input.apply = 'damage';
        else if (input.heal === true || ['cura', 'curar', 'heal', 'healing'].includes(apply)) input.apply = 'heal';
        else if (apply && apply !== 'none') input.apply = 'none';
        const mode = foldText(input.mode ?? '');
        if (input.advantage === true || ['vantagem', 'adv'].includes(mode)) input.mode = 'advantage';
        else if (input.disadvantage === true || ['desvantagem', 'dis'].includes(mode)) input.mode = 'disadvantage';
    },
    system_roll: input => {
        const mode = foldText(input.mode ?? '');
        if (input.advantage === true || ['vantagem', 'adv', 'with_advantage'].includes(mode)) input.mode = 'advantage';
        else if (input.disadvantage === true || ['desvantagem', 'dis', 'disadv', 'with_disadvantage'].includes(mode)) input.mode = 'disadvantage';
        else if (mode && mode !== 'advantage' && mode !== 'disadvantage') input.mode = 'normal';
    },
};

/** Converte um valor para o tipo do schema quando o modelo manda "5", "true", "[...]" etc. */
export function coerceValue(schema, value) {
    if (value === undefined || value === null || !schema) return value;
    switch (schema.type) {
        case 'boolean': {
            if (typeof value === 'boolean') return value;
            if (typeof value === 'number') return value !== 0;
            const text = foldText(value);
            if (['true', 'yes', 'sim', '1', 'on'].includes(text)) return true;
            if (['false', 'no', 'nao', '0', 'off', ''].includes(text)) return false;
            return value;
        }
        case 'integer':
        case 'number': {
            if (typeof value === 'number') return schema.type === 'integer' ? Math.trunc(value) : value;
            if (typeof value === 'string') {
                const text = value.trim().replace(/^\+/, '');
                if (text !== '' && Number.isFinite(Number(text))) return schema.type === 'integer' ? Math.trunc(Number(text)) : Number(text);
            }
            return value;
        }
        case 'string': {
            if (typeof value === 'number' || typeof value === 'boolean') return String(value);
            if (schema.enum && typeof value === 'string') {
                const match = schema.enum.find(option => foldText(option) === foldText(value));
                return match ?? value;
            }
            return value;
        }
        case 'array': {
            let list = value;
            if (typeof list === 'string') {
                const text = list.trim();
                if (text.startsWith('[')) {
                    try { list = JSON.parse(text); } catch { /* fica como texto */ }
                } else if (schema.items?.type === 'string' || schema.items?.type === 'integer') {
                    list = text.split(',').map(item => item.trim()).filter(Boolean);
                }
            }
            // Mapas {"Força": 14} são aceitos pelos serviços; não embrulha em lista.
            if (list && typeof list === 'object' && !Array.isArray(list) && schema.items?.type === 'object' && !('name' in list)) return list;
            if (!Array.isArray(list)) list = [list];
            return list.map(item => coerceValue(schema.items, item));
        }
        case 'object': {
            let object = value;
            if (typeof object === 'string') {
                try { object = JSON.parse(object); } catch { return value; }
            }
            if (!object || typeof object !== 'object' || Array.isArray(object)) return object;
            const result = { ...object };
            for (const [key, child] of Object.entries(schema.properties ?? {})) {
                if (key in result) result[key] = coerceValue(child, result[key]);
            }
            return result;
        }
        default:
            return value;
    }
}

/** Normaliza os argumentos de uma chamada: JSON em texto, Unicode (NFC), nomes alternativos e tipos. */
export function prepareArgs(definition, args) {
    let input = args;
    if (typeof input === 'string') {
        try { input = JSON.parse(input); } catch { input = {}; }
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
    input = deepNormalizeStrings(input);
    for (const [canonical, alternatives] of Object.entries(ARG_ALIASES[definition.name] ?? {})) {
        if (input[canonical] !== undefined) continue;
        const found = alternatives.find(alternative => input[alternative] !== undefined);
        if (found) {
            input[canonical] = input[found];
            delete input[found];
        }
    }
    ARG_FIXES[definition.name]?.(input);
    for (const [key, schema] of Object.entries(definition.inputSchema.properties ?? {})) {
        if (input[key] !== undefined) input[key] = coerceValue(schema, input[key]);
    }
    return input;
}

const STUDIO_INTRO ='The Agent Studio is the user\'s persistent, GLOBAL file space: it is shared across all chats and characters and survives between runs (unlike the per-run workspace). Use it to keep long-lived material organized in folders: world bibles, character sheets, lore drafts, plans, timelines, notes. Paths are relative and use "/", e.g. "worlds/Aetheria/geography.md". Folders are created automatically when a file is written.';

/**
 * @param {{ fs: import('./studio-fs.js').StudioFS, lore: import('./lorebook.js').LorebookService }} services
 */
export function buildToolDefinitions({ fs, lore, system }) {
    return [
        // ---------- estúdio ----------
        {
            name: 'studio_list',
            group: TOOL_GROUPS.studio,
            description: `${STUDIO_INTRO} This tool lists folders and files (with size and last update). Call it before creating files, to reuse the existing organization.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Folder to list. Omit or use "" for the root.' },
                    recursive: { type: 'boolean', description: 'Include everything inside subfolders (default true).' },
                    limit: { type: 'integer', description: 'Maximum folders and files returned (default 300, max 1000).' },
                },
            },
            run: args => fs.list({ path: args.path, recursive: args.recursive ?? true, limit: args.limit }),
            summarize: (args, result) => `Listou ${result.folder} (${result.total_files} arquivos)`,
        },
        {
            name: 'studio_read',
            group: TOOL_GROUPS.studio,
            description: 'Read a text file from the Agent Studio. Long files come in pages: when "next_start_line" is present, call again with start_line set to it to continue.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path, e.g. "worlds/Aetheria/geography.md".' },
                    start_line: { type: 'integer', description: 'First line to read (1-based, default 1).' },
                    line_count: { type: 'integer', description: 'Number of lines to read (default: until the end).' },
                    max_chars: { type: 'integer', description: 'Maximum characters returned (default 20000, max 60000).' },
                },
                required: ['path'],
            },
            run: args => fs.read({ path: args.path, startLine: args.start_line, lineCount: args.line_count, maxChars: args.max_chars }),
            summarize: args => `Leu ${args.path}`,
        },
        {
            name: 'studio_write',
            group: TOOL_GROUPS.studio,
            description: 'Create or overwrite a text file in the Agent Studio (Markdown recommended). mode "replace" (default) replaces the whole file; "append" adds to the end and creates the file if it does not exist. Missing folders are created automatically. For small changes to an existing file prefer studio_edit.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path, e.g. "characters/Lyra.md".' },
                    content: { type: 'string', description: 'Full text to write (or to append).' },
                    mode: { type: 'string', enum: ['replace', 'append'], description: '"replace" (default) or "append".' },
                },
                required: ['path', 'content'],
            },
            run: (args, context) => fs.write({ path: args.path, content: args.content, mode: args.mode ?? 'replace', runId: context.runId }),
            summarize: (args, result) => `${result.created ? 'Criou' : (args.mode === 'append' ? 'Acrescentou em' : 'Reescreveu')} ${result.path} (${result.size} caracteres)`,
        },
        {
            name: 'studio_edit',
            group: TOOL_GROUPS.studio,
            description: 'Edit an existing Agent Studio file by replacing an exact snippet of text. old_string must match the file exactly (spaces and line breaks included) and be unique, unless replace_all is true. Read the file first.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path.' },
                    old_string: { type: 'string', description: 'Exact text to find.' },
                    new_string: { type: 'string', description: 'Replacement text (can be empty to delete the snippet).' },
                    replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
                },
                required: ['path', 'old_string', 'new_string'],
            },
            run: (args, context) => fs.edit({ path: args.path, oldString: args.old_string, newString: args.new_string, replaceAll: args.replace_all === true, runId: context.runId }),
            summarize: (args, result) => `Editou ${result.path} (${result.replacements} troca${result.replacements === 1 ? '' : 's'})`,
        },
        {
            name: 'studio_search',
            group: TOOL_GROUPS.studio,
            description: 'Search text in Agent Studio files (file names and contents; case-insensitive by default). Returns the matching lines with file path and line number.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Text to search for.' },
                    path: { type: 'string', description: 'Limit the search to this folder (default: whole studio).' },
                    limit: { type: 'integer', description: 'Maximum results (default 20, max 100).' },
                    case_sensitive: { type: 'boolean', description: 'Default false.' },
                },
                required: ['query'],
            },
            run: args => fs.search({ query: args.query, path: args.path, limit: args.limit, caseSensitive: args.case_sensitive === true }),
            summarize: (args, result) => `Buscou "${args.query}" (${result.results.length} resultados)`,
        },
        {
            name: 'studio_make_folder',
            group: TOOL_GROUPS.studio,
            description: 'Create an empty folder in the Agent Studio. (studio_write already creates missing folders; use this only to prepare an empty structure.)',
            inputSchema: {
                type: 'object',
                properties: { path: { type: 'string', description: 'Folder path, e.g. "worlds/Aetheria".' } },
                required: ['path'],
            },
            run: (args, context) => fs.makeFolder({ path: args.path, runId: context.runId }),
            summarize: (args, result) => `${result.created ? 'Criou a pasta' : 'Pasta já existia:'} ${result.path}`,
        },
        {
            name: 'studio_move',
            group: TOOL_GROUPS.studio,
            description: 'Move or rename a file or a folder (with its contents) in the Agent Studio. If "to" is an existing folder, the item is moved inside it. Use "" as "to" to move to the root.',
            inputSchema: {
                type: 'object',
                properties: {
                    from: { type: 'string', description: 'Current path of the file or folder.' },
                    to: { type: 'string', description: 'New path, or an existing destination folder.' },
                },
                required: ['from', 'to'],
            },
            run: (args, context) => fs.move({ from: args.from, to: args.to ?? '', runId: context.runId }),
            summarize: (args, result) => (result.moved ? `Moveu ${result.from} → ${result.to}` : `Nada a mover (${result.from})`),
        },
        {
            name: 'studio_delete',
            group: TOOL_GROUPS.studio,
            description: 'Delete a file, or a folder with everything inside, from the Agent Studio. Items go to the Studio trash, where the user can restore them. Only delete when it is clearly what the user wants or the content is obsolete.',
            inputSchema: {
                type: 'object',
                properties: { path: { type: 'string', description: 'File or folder path.' } },
                required: ['path'],
            },
            run: (args, context) => fs.delete({ path: args.path, runId: context.runId }),
            summarize: (args, result) => `Excluiu ${result.deleted} (${result.files} arquivo${result.files === 1 ? '' : 's'} na lixeira)`,
        },

        // ---------- lorebooks: leitura ----------
        {
            name: 'lorebook_list',
            group: TOOL_GROUPS.loreRead,
            description: 'List the user\'s lorebooks (SillyTavern World Info). Lorebooks hold entries that are injected into the prompt when their keywords appear in the chat. "active_for" says where each one is in use right now: "global", "character" (primary book of the current character), "character_extra", "chat" or "persona"; an empty list means it is not active in this chat.',
            inputSchema: {
                type: 'object',
                properties: {
                    include_counts: { type: 'boolean', description: 'Also return how many entries each lorebook has (slower). Default false.' },
                },
            },
            run: args => lore.list({ includeCounts: args.include_counts === true }),
            summarize: (args, result) => `Listou ${result.total} lorebooks`,
        },
        {
            name: 'lorebook_read',
            group: TOOL_GROUPS.loreRead,
            description: 'Read a lorebook. Without "uids" it returns a paginated summary of the entries (uid, title, keys, flags, content preview); when "next_offset" is present, call again with offset set to it. With "uids" it returns those entries in full, with every editable field.',
            inputSchema: {
                type: 'object',
                properties: {
                    book: { type: 'string', description: 'Lorebook name (from lorebook_list).' },
                    uids: { type: 'array', items: { type: 'integer' }, description: 'Entries to read in full (max 25 per call).' },
                    offset: { type: 'integer', description: 'Summary pagination offset (default 0).' },
                    limit: { type: 'integer', description: 'Summary page size (default 100, max 300).' },
                },
                required: ['book'],
            },
            run: args => lore.read({ book: args.book, uids: args.uids, offset: args.offset, limit: args.limit }),
            summarize: (args, result) => (Array.isArray(args.uids) && args.uids.length
                ? `Leu ${result.entries.length} entrada(s) de "${result.book}"`
                : `Leu o resumo de "${result.book}" (${result.total_entries} entradas)`),
        },
        {
            name: 'lorebook_search',
            group: TOOL_GROUPS.loreRead,
            description: 'Search lorebook entries by text in title, keywords and content (case-insensitive). Omit "books" to search every lorebook.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Text to search for.' },
                    books: { type: 'array', items: { type: 'string' }, description: 'Lorebook names to search (default: all).' },
                    limit: { type: 'integer', description: 'Maximum results (default 20, max 100).' },
                },
                required: ['query'],
            },
            run: args => lore.search({ query: args.query, books: args.books, limit: args.limit }),
            summarize: (args, result) => `Buscou "${args.query}" nos lorebooks (${result.results.length} resultados)`,
        },

        // ---------- lorebooks: edição ----------
        {
            name: 'lorebook_create_entry',
            group: TOOL_GROUPS.loreWrite,
            description: 'Create a new entry in an existing lorebook. A backup of the lorebook is saved automatically first. Always set "content"; normally also "comment" (title) and "key" (trigger keywords), or "constant": true for entries that must always be active.',
            inputSchema: {
                type: 'object',
                properties: {
                    book: { type: 'string', description: 'Lorebook name.' },
                    entry: { ...ENTRY_FIELDS_SCHEMA, description: 'Fields of the new entry ("content" is required).' },
                },
                required: ['book', 'entry'],
            },
            run: (args, context) => lore.createEntry({ book: args.book, fields: args.entry, runId: context.runId }),
            summarize: (args, result) => `Criou a entrada #${result.uid} "${result.title}" em "${result.book}"`,
        },
        {
            name: 'lorebook_update_entry',
            group: TOOL_GROUPS.loreWrite,
            description: 'Change fields of an existing lorebook entry; only the fields you pass are changed. For a targeted change inside long content, use content_edit (exact old_string → new_string) instead of rewriting "content". A backup of the lorebook is saved automatically first.',
            inputSchema: {
                type: 'object',
                properties: {
                    book: { type: 'string', description: 'Lorebook name.' },
                    uid: { type: 'integer', description: 'Entry uid (from lorebook_read or lorebook_search).' },
                    changes: { ...ENTRY_FIELDS_SCHEMA, description: 'Fields to change.' },
                    content_edit: {
                        type: 'object',
                        description: 'Optional exact replacement inside the entry content.',
                        properties: {
                            old_string: { type: 'string', description: 'Exact text to find (must be unique in the content).' },
                            new_string: { type: 'string', description: 'Replacement text.' },
                        },
                        required: ['old_string', 'new_string'],
                    },
                },
                required: ['book', 'uid'],
            },
            run: (args, context) => lore.updateEntry({ book: args.book, uid: args.uid, changes: args.changes, contentEdit: args.content_edit, runId: context.runId }),
            summarize: (args, result) => `Editou a entrada #${result.uid} "${result.title}" em "${result.book}" (${result.updated_fields.join(', ')})`,
        },
        {
            name: 'lorebook_delete_entry',
            group: TOOL_GROUPS.loreWrite,
            description: 'Delete an entry from a lorebook. A backup is saved automatically first, so the user can restore it. Prefer "disable": true (lorebook_update_entry) when the entry might be needed again.',
            inputSchema: {
                type: 'object',
                properties: {
                    book: { type: 'string', description: 'Lorebook name.' },
                    uid: { type: 'integer', description: 'Entry uid.' },
                },
                required: ['book', 'uid'],
            },
            run: (args, context) => lore.deleteEntry({ book: args.book, uid: args.uid, runId: context.runId }),
            summarize: (args, result) => `Excluiu a entrada #${result.deleted_uid} "${result.title}" de "${result.book}"`,
        },
        {
            name: 'lorebook_create_book',
            group: TOOL_GROUPS.loreWrite,
            description: 'Create a new, empty lorebook. It is not linked to any chat or character: tell the user to link it in the World Info panel if it should be active.',
            inputSchema: {
                type: 'object',
                properties: { name: { type: 'string', description: 'Name of the new lorebook.' } },
                required: ['name'],
            },
            run: (args, context) => lore.createBook({ name: args.name, runId: context.runId }),
            summarize: (args, result) => `Criou o lorebook "${result.book}"`,
        },

        // ---------- sistema e fichas ----------
        {
            name: 'system_info',
            group: TOOL_GROUPS.system,
            description: 'Describe the user\'s RPG system: the dice method (e.g. 1d20 + modifier, or one d20 per attribute point keeping the highest), attributes, skills (each tied to an attribute) and their training levels, resources (like Vida/HP and Mana), stats (like Defesa = the DC to hit a character, Iniciativa), ability fields and body slots for items, with the descriptions the user wrote. No levels or XP. Read it once before working with sheets or checks.',
            inputSchema: {
                type: 'object',
                properties: {
                    section: { type: 'string', enum: ['all', 'rules', 'attributes', 'skills', 'resources', 'stats', 'abilities', 'items'], description: 'Part to return (default "all"). "rules" includes the dice method; "skills" the training levels; "items" the body slots.' },
                },
            },
            run: args => system.systemInfo({ section: args.section }),
            summarize: () => 'Consultou as regras do sistema',
        },
        {
            name: 'sheet_list',
            group: TOOL_GROUPS.system,
            description: 'List the character sheets available in this chat with their resources, defense and ability names: the player\'s sheet (the user\'s character; location "player"), NPC sheets of this chat ("chat"), and NPC sheets linked to entries of lorebooks active in this chat ("lorebook").',
            inputSchema: {
                type: 'object',
                properties: {
                    location: { type: 'string', enum: ['all', 'player', 'chat', 'lorebook'], description: 'Filter by where the sheet lives (default "all").' },
                },
            },
            run: args => system.listSheets({ location: args.location }),
            summarize: (args, result) => `Listou ${result.sheets.length} ficha(s)`,
        },
        {
            name: 'sheet_read',
            group: TOOL_GROUPS.system,
            description: 'Read a character sheet in full: resources (current/max), stats (Defesa, Iniciativa...), attribute scores and modifiers, skill bonuses and totals, abilities (cost, check, effect, extra fields) and notes.',
            inputSchema: { type: 'object', properties: { sheet: SHEET_PARAM } },
            run: args => system.readSheet(args.sheet),
            summarize: (args, result) => `Leu a ficha de ${result.name}`,
        },
        {
            name: 'sheet_create',
            group: TOOL_GROUPS.system,
            description: 'Create an NPC sheet (companion, rival, enemy), optionally with abilities. By default it belongs to this chat only. For a recurring character that has a lorebook entry, pass link_lorebook so the sheet persists in every chat where that lorebook is active. Values you omit use the defaults (score 10, resources at their default maximum).',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Character name.' },
                    notes: { type: 'string', description: 'Short notes (equipment, conditions, traits).' },
                    attributes: ATTRIBUTE_VALUES,
                    skills: SKILL_VALUES,
                    resources: RESOURCE_VALUES,
                    stats: STAT_VALUES,
                    abilities: ABILITY_LIST,
                    link_lorebook: LORE_LINK,
                },
                required: ['name'],
            },
            run: (args, context) => system.createSheet({
                name: args.name,
                notes: args.notes,
                attributes: args.attributes,
                skills: args.skills,
                resources: args.resources,
                stats: args.stats,
                abilities: Array.isArray(args.abilities) ? args.abilities.map(abilityInput) : undefined,
                linkLorebook: args.link_lorebook,
                runId: context.runId,
            }),
            summarize: (args, result) => `Criou a ficha de ${result.name}${result.location === 'lorebook' ? ' (vinculada a lorebook)' : ''}`,
        },
        {
            name: 'sheet_update',
            group: TOOL_GROUPS.system,
            description: 'Change a sheet: name, notes, attribute scores, skill bonuses, stat bonuses (e.g. armor +2 Defesa), resource maximum/current; link it to a lorebook entry (link_lorebook) or move it back into this chat (unlink_lorebook). For damage, healing or spending during play prefer sheet_resource; for abilities use sheet_ability.',
            inputSchema: {
                type: 'object',
                properties: {
                    sheet: SHEET_PARAM,
                    name: { type: 'string', description: 'New name.' },
                    notes: { type: 'string', description: 'New notes (replaces the old ones).' },
                    attributes: ATTRIBUTE_VALUES,
                    skills: SKILL_VALUES,
                    stats: STAT_VALUES,
                    resources: RESOURCE_VALUES,
                    link_lorebook: LORE_LINK,
                    unlink_lorebook: { type: 'boolean', description: 'Move a lorebook-linked sheet back into this chat only.' },
                },
            },
            run: (args, context) => system.updateSheet(args.sheet, {
                name: args.name,
                notes: args.notes,
                attributes: args.attributes,
                skills: args.skills,
                stats: args.stats,
                resources: args.resources,
                linkLorebook: args.link_lorebook,
                unlinkLorebook: args.unlink_lorebook === true,
                runId: context.runId,
            }),
            summarize: (args, result) => `Editou a ficha de ${result.name}`,
        },
        {
            name: 'sheet_resource',
            group: TOOL_GROUPS.system,
            description: 'Change a resource during play (e.g. Vida/HP, Mana): "delta" for damage, healing or spending (negative = lose, positive = recover) or "set" for an exact value. Kept between 0 and the maximum. Do it whenever the story causes damage, healing or resource use, so the sheet stays accurate.',
            inputSchema: {
                type: 'object',
                properties: {
                    sheet: SHEET_PARAM,
                    resource: { type: 'string', description: 'Resource name, e.g. "Vida" or "Mana".' },
                    delta: { type: 'integer', description: 'Change, e.g. -4 (damage) or 3 (healing).' },
                    set: { type: 'integer', description: 'Exact new value (instead of delta).' },
                },
                required: ['resource'],
            },
            run: (args, context) => system.adjustResource(args.sheet, { resource: args.resource, delta: args.delta, set: args.set, runId: context.runId }),
            summarize: (args, result) => `${result.resource} de ${result.sheet}: ${result.before} → ${result.after}/${result.max}`,
        },
        {
            name: 'sheet_ability',
            group: TOOL_GROUPS.system,
            description: 'Add, update or remove an ability (spell, power, technique, special attack) on a sheet. An ability has a cost (e.g. 3 Mana), a check rolled to hit (skill/attribute), an effect (dice like "2d6+FOR" are rolled on use, or plain text) and the user\'s extra fields (Alcance, Duração, Recarga...). For "update"/"remove", pass the current name in "ability"; for "update" only the fields you pass change.',
            inputSchema: {
                type: 'object',
                properties: {
                    sheet: SHEET_PARAM,
                    action: { type: 'string', enum: ['add', 'update', 'remove'], description: 'Default "add".' },
                    ability: { type: 'string', description: 'Current name of the ability to update/remove.' },
                    ...ABILITY_PROPERTIES,
                    name: { type: 'string', description: 'Name of the new ability (add) or new name (update).' },
                },
            },
            run: (args, context) => system.editAbility(args.sheet, {
                action: args.action ?? 'add',
                ability: args.ability,
                ...abilityInput(args),
                runId: context.runId,
            }),
            summarize: (args, result) => {
                const name = typeof result.ability === 'string' ? result.ability : result.ability?.name;
                const verb = { added: 'Criou', updated: 'Editou', removed: 'Removeu' }[result.action] ?? 'Mudou';
                return `${verb} a habilidade "${name}" de ${result.sheet}`;
            },
        },
        {
            name: 'ability_use',
            group: TOOL_GROUPS.system,
            description: 'Use an ability from a sheet: pays its cost (fails if there is not enough), rolls its check against "dc" or against the target\'s defense stat, and rolls its effect dice. With apply "damage" the effect total is subtracted from the target\'s resource (Vida by default) if it hits; with "heal" it is added (to the target, or to the user without a target). Results are random and recorded for the user: narrate according to them, never invent or reroll.',
            inputSchema: {
                type: 'object',
                properties: {
                    sheet: SHEET_PARAM,
                    ability: { type: 'string', description: 'Ability name.' },
                    target: { type: 'string', description: 'Target sheet name (its defense stat becomes the DC).' },
                    dc: { type: 'integer', description: 'Fixed difficulty instead of the target\'s defense.' },
                    apply: { type: 'string', enum: ['none', 'damage', 'heal'], description: 'Apply the effect total to a resource (default "none").' },
                    resource: { type: 'string', description: 'Resource affected by apply (default: the first one, usually Vida).' },
                    mode: { type: 'string', enum: ['normal', 'advantage', 'disadvantage'], description: 'Default "normal".' },
                    bonus: { type: 'integer', description: 'Situational bonus or penalty to the check.' },
                },
                required: ['ability'],
            },
            run: (args, context) => system.useAbility(args.sheet, {
                ability: args.ability,
                target: args.target,
                dc: args.dc,
                apply: args.apply ?? 'none',
                resource: args.resource,
                mode: args.mode ?? 'normal',
                bonus: args.bonus,
                runId: context.runId,
            }),
            summarize: (args, result) => result.summary,
        },
        {
            name: 'sheet_delete',
            group: TOOL_GROUPS.system,
            description: 'Delete an NPC sheet that is no longer needed (the player\'s sheet cannot be deleted).',
            inputSchema: { type: 'object', properties: { sheet: { type: 'string', description: 'Sheet name or id.' } }, required: ['sheet'] },
            run: (args, context) => system.deleteSheet(args.sheet, { runId: context.runId }),
            summarize: (args, result) => `Excluiu a ficha de ${result.deleted}`,
        },
        {
            name: 'system_roll',
            group: TOOL_GROUPS.system,
            description: 'Roll a check for a sheet: d20 + the skill total, attribute modifier or stat (+ optional situational bonus), against a difficulty class (dc) or against another sheet\'s defense ("against": the target\'s Defesa becomes the DC, for attacks). Use it when the outcome of an action is uncertain, then narrate according to the result. "advantage"/"disadvantage" roll 2d20 and keep the higher/lower. The roll is random and recorded for the user: never invent, change or reroll a result.',
            inputSchema: {
                type: 'object',
                properties: {
                    sheet: SHEET_PARAM,
                    check: { type: 'string', description: 'Skill, attribute or stat to test, e.g. "Furtividade", "Força", "Iniciativa".' },
                    dc: { type: 'integer', description: 'Difficulty: 10 easy, 15 medium, 20 hard, 25 very hard.' },
                    against: { type: 'string', description: 'Target sheet name: its defense stat is used as the DC (attacks).' },
                    against_stat: { type: 'string', description: 'Use another stat of the target as the DC (default: its defense stat).' },
                    mode: { type: 'string', enum: ['normal', 'advantage', 'disadvantage'], description: 'Default "normal".' },
                    bonus: { type: 'integer', description: 'Situational bonus or penalty (e.g. +2 for good tools, -2 for darkness).' },
                    extra_dice: { type: 'integer', description: 'Extra dice for this roll (+1 or -1), for dice methods with several dice.' },
                    reason: { type: 'string', description: 'Short description of what is being attempted.' },
                },
                required: ['check'],
            },
            run: args => system.roll(args.sheet, {
                check: args.check,
                dc: args.dc,
                against: args.against,
                againstStat: args.against_stat,
                mode: args.mode ?? 'normal',
                bonus: args.bonus,
                extraDice: args.extra_dice,
                reason: args.reason,
            }),
            summarize: (args, result) => result.summary,
        },
        {
            name: 'sheet_item',
            group: TOOL_GROUPS.system,
            description: 'Add, update or remove an item on a sheet (weapons, armor, potions, keys, loot). "slot" equips it on a body part (see system_info section "items") or puts it in the backpack ("mochila"); an item\'s bonus (e.g. +2 Defesa) only counts while it is equipped. Use quantity_delta to consume or gain (e.g. -1 potion; at 0 the item disappears). For "update"/"remove", pass the current name in "item".',
            inputSchema: {
                type: 'object',
                properties: {
                    sheet: SHEET_PARAM,
                    action: { type: 'string', enum: ['add', 'update', 'remove'], description: 'Default "add" (the same item in the same place stacks the quantity).' },
                    item: { type: 'string', description: 'Current name of the item to update/remove.' },
                    name: { type: 'string', description: 'Item name (add) or new name (update).' },
                    description: { type: 'string', description: 'What it is / does (damage, properties, value).' },
                    quantity: { type: 'integer', description: 'Exact quantity (default 1 when adding).' },
                    quantity_delta: { type: 'integer', description: 'Change in quantity, e.g. -1 when a potion is drunk.' },
                    slot: { type: 'string', description: 'Body slot to equip it on (e.g. "Torso", "Mão principal") or "mochila" for the backpack.' },
                    bonus_target: { type: 'string', description: 'Stat or skill the item improves while equipped, e.g. "Defesa" or "Pontaria".' },
                    bonus_value: { type: 'integer', description: 'Size of that bonus, e.g. 2. Use 0 to remove the bonus.' },
                },
            },
            run: (args, context) => system.editItem(args.sheet, {
                action: args.action ?? 'add',
                item: args.item,
                name: args.name,
                description: args.description,
                quantity: args.quantity,
                quantityDelta: args.quantity_delta,
                slot: args.slot,
                bonusTarget: args.bonus_target,
                bonusValue: args.bonus_value,
                runId: context.runId,
            }),
            summarize: (args, result) => {
                const name = typeof result.item === 'string' ? result.item : result.item?.name;
                const where = result.item?.location ? ` (${result.item.location === 'backpack' ? 'mochila' : result.item.location})` : '';
                const verb = { added: 'Deu', stacked: 'Somou', updated: 'Mudou', removed: 'Tirou', used_up: 'Acabou' }[result.action] ?? 'Mudou';
                return `${verb} o item "${name}"${where} de ${result.sheet}`;
            },
        },
    ];
}

export class AgentToolBridge {
    /**
     * @param {{ definitions: ReturnType<typeof buildToolDefinitions>, activity: import('./activity.js').ActivityLog, getSettings: () => Record<string, any> }} options
     */
    constructor({ definitions, activity, getSettings }) {
        this.definitions = definitions;
        this.activity = activity;
        this.getSettings = getSettings;
        /** @type {Map<string, string>} nome -> id estável */
        this.registered = new Map();
        this.errors = [];
    }

    get agentApi() {
        return globalThis.__TAURITAVERN__?.api?.agent;
    }

    isAvailable() {
        return typeof this.agentApi?.tools?.register === 'function';
    }

    isGroupEnabled(group) {
        return this.getSettings()[group] !== false;
    }

    toolId(name) {
        return this.registered.get(name) ?? `extension/${EXTENSION_ID}:${name}`;
    }

    async registerAll() {
        if (!this.isAvailable()) return;
        const tools = this.agentApi.tools;
        this.errors = [];
        for (const definition of this.definitions) {
            if (this.registered.has(definition.name)) continue;
            try {
                await tools.register({
                    extensionId: EXTENSION_ID,
                    name: definition.name,
                    description: definition.description,
                    inputSchema: definition.inputSchema,
                    contexts: ['chat', 'session'],
                    enabled: this.isGroupEnabled(definition.group),
                }, (args, context) => this.execute(definition, args, context));
                this.registered.set(definition.name, `extension/${EXTENSION_ID}:${definition.name}`);
            } catch (error) {
                const message = errorMessage(error);
                if (message.includes('already_registered')) {
                    this.registered.set(definition.name, `extension/${EXTENSION_ID}:${definition.name}`);
                    continue;
                }
                console.error(LOG_PREFIX, `Falha ao registrar a ferramenta ${definition.name}`, error);
                this.errors.push({ name: definition.name, message });
            }
        }
        await this.resolveIds();
    }

    /** Usa os ids que o próprio host informa, caso o formato mude no futuro. */
    async resolveIds() {
        try {
            const result = await this.agentApi.tools.list();
            for (const tool of result?.tools ?? []) {
                if (tool.source === 'extension' && tool.extensionId === EXTENSION_ID && this.registered.has(tool.nativeName)) {
                    this.registered.set(tool.nativeName, tool.id);
                }
            }
        } catch (error) {
            console.warn(LOG_PREFIX, 'Não consegui listar as ferramentas do Agent', error);
        }
    }

    async applyEnabledState() {
        if (!this.isAvailable()) return;
        for (const definition of this.definitions) {
            if (!this.registered.has(definition.name)) continue;
            try {
                await this.agentApi.tools.setEnabled(this.toolId(definition.name), this.isGroupEnabled(definition.group));
            } catch (error) {
                console.warn(LOG_PREFIX, `Falha ao ligar/desligar ${definition.name}`, error);
            }
        }
    }

    async execute(definition, args, context) {
        const callContext = context ?? {};
        let input = {};
        try {
            input = prepareArgs(definition, args);
            const result = await definition.run(input, callContext);
            let summary = null;
            try { summary = definition.summarize?.(input, result) ?? null; } catch { /* resumo é opcional */ }
            this.activity.add({ tool: definition.name, ok: true, summary, runId: callContext.runId });
            return result;
        } catch (error) {
            const message = errorMessage(error);
            this.activity.add({ tool: definition.name, ok: false, error: message, runId: callContext.runId });
            // Mostra ao modelo quais argumentos chegaram, para ele conseguir se corrigir.
            const received = Object.keys(input).join(', ') || 'none';
            throw new Error(`${message} (arguments received: ${received})`);
        }
    }

    registeredIds() {
        return this.definitions.filter(d => this.registered.has(d.name)).map(d => this.toolId(d.name));
    }

    async listProfiles() {
        const result = await this.agentApi.profiles.list();
        return Array.isArray(result?.profiles) ? result.profiles : [];
    }

    /**
     * Libera as ferramentas registradas num Profile. Com profileId === STUDIO_PROFILE_ID e o Profile
     * ainda inexistente, cria-o como cópia do default-writer (que não pode ser editado).
     */
    async grantToProfile(profileId) {
        const profiles = this.agentApi.profiles;
        const ids = this.registeredIds();
        if (!ids.length) throw new Error('Nenhuma ferramenta do Agent Studio está registrada.');

        const loadProfile = async id => {
            try {
                return (await profiles.load(id))?.profile ?? null;
            } catch (error) {
                console.warn(LOG_PREFIX, `Não consegui carregar o Profile ${id}`, error);
                return null;
            }
        };

        let profile = await loadProfile(profileId);
        let created = false;
        if (!profile) {
            if (profileId !== STUDIO_PROFILE_ID) throw new Error(`Profile "${profileId}" não encontrado.`);
            const base = await loadProfile(BASE_PROFILE_ID);
            if (!base) throw new Error('Não encontrei o Profile default-writer para copiar.');
            profile = structuredClone(base);
            profile.id = STUDIO_PROFILE_ID;
            profile.displayName = 'Agent Studio Writer';
            profile.description = 'Cópia do Default Writer com as ferramentas do Agent Studio (estúdio de arquivos, lorebooks e fichas de RPG).';
            created = true;
        } else {
            profile = structuredClone(profile);
        }

        profile.tools = profile.tools ?? {};
        const allow = Array.isArray(profile.tools.allow) ? profile.tools.allow : [];
        const added = ids.filter(id => !allow.includes(id));
        profile.tools.allow = [...allow, ...added];
        if (Array.isArray(profile.tools.deny)) {
            profile.tools.deny = profile.tools.deny.filter(id => !ids.includes(id));
        }
        await profiles.save(profile);
        return { profileId: profile.id, displayName: profile.displayName, created, added: added.length };
    }

    /** Quantas ferramentas do plugin um Profile libera (e quantas estão desligadas nas configurações). */
    async profileCoverage(profileId = STUDIO_PROFILE_ID) {
        if (!this.isAvailable()) return null;
        const ids = this.registeredIds();
        const disabled = this.definitions.filter(d => this.registered.has(d.name) && !this.isGroupEnabled(d.group)).length;
        let profile = null;
        try {
            profile = (await this.agentApi.profiles.load(profileId))?.profile ?? null;
        } catch {
            profile = null;
        }
        if (!profile) return { exists: false, granted: 0, total: ids.length, disabled };
        const allow = Array.isArray(profile.tools?.allow) ? profile.tools.allow : [];
        const deny = Array.isArray(profile.tools?.deny) ? profile.tools.deny : [];
        const granted = ids.filter(id => allow.includes(id) && !deny.includes(id)).length;
        return { exists: true, granted, total: ids.length, disabled, displayName: profile.displayName };
    }

    /** Se o Profile "Agent Studio Writer" já existe, libera nele as ferramentas novas desta versão. */
    async syncStudioProfile() {
        if (!this.isAvailable()) return null;
        let profile = null;
        try {
            profile = (await this.agentApi.profiles.load(STUDIO_PROFILE_ID))?.profile ?? null;
        } catch {
            return null;
        }
        if (!profile) return null;
        const allow = Array.isArray(profile.tools?.allow) ? profile.tools.allow : [];
        if (this.registeredIds().every(id => allow.includes(id))) return null;
        return this.grantToProfile(STUDIO_PROFILE_ID);
    }
}
