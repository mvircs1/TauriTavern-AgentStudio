// Helpers compartilhados (sem dependência de DOM nem do SillyTavern).

export const EXTENSION_ID = 'agent-studio';
export const LOG_PREFIX = '[Agent Studio]';

const INVALID_SEGMENT_CHARS = /[\u0000-\u001f<>:"|?*]/;
const MAX_SEGMENT_LENGTH = 120;
const MAX_PATH_LENGTH = 400;

/**
 * Normaliza um caminho do estúdio: barras normais, sem barra no início/fim,
 * sem segmentos vazios ou ".", e recusa "..".
 * @param {unknown} input
 * @param {{ allowRoot?: boolean }} [options]
 * @returns {string} '' representa a raiz (só se allowRoot)
 */
export function normalizePath(input, { allowRoot = false } = {}) {
    const raw = typeof input === 'string' ? input.normalize('NFC') : '';
    const segments = raw
        .replace(/\\/g, '/')
        .split('/')
        .map(segment => segment.trim())
        .filter(segment => segment.length > 0 && segment !== '.');

    if (segments.length === 0) {
        if (allowRoot) return '';
        throw new Error('A path is required.');
    }

    for (const segment of segments) {
        if (segment === '..') {
            throw new Error(`Invalid path "${raw}": ".." is not allowed.`);
        }
        if (INVALID_SEGMENT_CHARS.test(segment)) {
            throw new Error(`Invalid path "${raw}": names cannot contain control characters or < > : " | ? *`);
        }
        if (segment.length > MAX_SEGMENT_LENGTH) {
            throw new Error(`Invalid path "${raw}": each name must be at most ${MAX_SEGMENT_LENGTH} characters.`);
        }
    }

    const path = segments.join('/');
    if (path.length > MAX_PATH_LENGTH) {
        throw new Error(`Invalid path: must be at most ${MAX_PATH_LENGTH} characters.`);
    }
    return path;
}

export function parentPath(path) {
    const index = path.lastIndexOf('/');
    return index === -1 ? '' : path.slice(0, index);
}

export function baseName(path) {
    const index = path.lastIndexOf('/');
    return index === -1 ? path : path.slice(index + 1);
}

export function joinPath(folder, name) {
    return folder ? `${folder}/${name}` : name;
}

/** true se `path` está dentro de `folder` (ou é a própria pasta). '' é a raiz. */
export function isInside(path, folder) {
    if (!folder) return true;
    return path === folder || path.startsWith(`${folder}/`);
}

/** Todos os ancestrais de um caminho, do mais raso ao mais fundo (sem a raiz). */
export function ancestorsOf(path) {
    const parts = path.split('/');
    const result = [];
    for (let i = 1; i < parts.length; i++) {
        result.push(parts.slice(0, i).join('/'));
    }
    return result;
}

/** Id curto e seguro para chaves do extension store ([A-Za-z0-9_.-]). */
export function generateId(prefix) {
    const time = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 8);
    return `${prefix}-${time}-${random}`;
}

/** Fila que executa uma tarefa assíncrona por vez, na ordem de chegada. */
export function createSerialQueue() {
    let tail = Promise.resolve();
    return function enqueue(task) {
        const result = tail.then(() => task());
        tail = result.catch(() => undefined);
        return result;
    };
}

export function clampInt(value, { min, max, fallback }) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(number)));
}

export function countLines(text) {
    if (!text) return 0;
    return text.split('\n').length;
}

/** Conta ocorrências não sobrepostas de `needle` em `haystack`. */
export function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
        count++;
        index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
}

/**
 * Forma canônica para comparar nomes: Unicode normalizado, sem acentos, minúsculas e espaços colapsados.
 * "Força", "forca", "FORÇA" e "Força" (forma decomposta) viram todos "forca".
 */
export function foldText(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Como foldText, mas preservando o comprimento do texto (já em NFC), para que uma posição achada no
 * texto "dobrado" sirva também no texto original (snippets de busca).
 */
export function foldKeepLength(text) {
    let output = '';
    for (const char of String(text ?? '')) {
        const base = char.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        if (base.length === char.length) {
            output += base;
        } else {
            const lower = char.toLowerCase();
            output += lower.length === char.length ? lower : char;
        }
    }
    return output;
}

/** Busca sem diferenciar acentos nem maiúsculas. Devolve a posição no texto (NFC) ou -1. */
export function foldedIndexOf(text, query) {
    const haystack = foldKeepLength(String(text ?? '').normalize('NFC'));
    const needle = foldKeepLength(String(query ?? '').normalize('NFC').trim());
    if (!needle) return -1;
    return haystack.indexOf(needle);
}

/**
 * Acha `needle` em `text` tolerando diferenças que modelos costumam introduzir: forma Unicode
 * (NFC/NFD, ex. "ã" composto ou decomposto), quebras de linha \r\n e espaços no fim das linhas.
 * Devolve as versões de texto/needle em que a busca funcionou, para a troca ser feita nelas.
 * @returns {{ text: string, needle: string, count: number }}
 */
export function locateFlexible(text, needle) {
    const transforms = [
        value => value,
        value => value.normalize('NFC'),
        value => value.normalize('NFC').replace(/\r\n?/g, '\n'),
        value => value.normalize('NFC').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, ''),
    ];
    for (const transform of transforms) {
        const candidateText = transform(String(text));
        const candidateNeedle = transform(String(needle));
        if (!candidateNeedle) continue;
        const count = countOccurrences(candidateText, candidateNeedle);
        if (count > 0) return { text: candidateText, needle: candidateNeedle, count };
    }
    return { text: String(text), needle: String(needle), count: 0 };
}

/** Normaliza recursivamente todas as strings de um valor JSON para NFC. */
export function deepNormalizeStrings(value) {
    if (typeof value === 'string') return value.normalize('NFC');
    if (Array.isArray(value)) return value.map(deepNormalizeStrings);
    if (value && typeof value === 'object') {
        const result = {};
        for (const [key, item] of Object.entries(value)) result[key] = deepNormalizeStrings(item);
        return result;
    }
    return value;
}

export function truncate(text, maxChars) {
    if (text.length <= maxChars) return { text, truncated: false };
    return { text: text.slice(0, maxChars), truncated: true };
}

export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

export function formatDateTime(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(iso);
    return date.toLocaleString();
}

export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
