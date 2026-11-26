// Sistema de arquivos virtual do Agent Studio.
// Um índice (meta/index) guarda caminhos e metadados; o conteúdo de cada arquivo fica numa chave
// própria (files/<id>), porque as chaves do extension store não aceitam "/".

import {
    ancestorsOf,
    baseName,
    clampInt,
    countLines,
    countOccurrences,
    createSerialQueue,
    generateId,
    isInside,
    joinPath,
    LOG_PREFIX,
    normalizePath,
    parentPath,
    truncate,
} from './util.js';

const INDEX_TABLE = 'meta';
const INDEX_KEY = 'index';
const FILES_TABLE = 'files';

export const MAX_FILE_CHARS = 1_000_000;
const READ_DEFAULT_CHARS = 20_000;
const READ_MAX_CHARS = 60_000;
const SNIPPET_CHARS = 200;

function emptyIndex() {
    return { version: 1, files: {}, folders: [], trash: {} };
}

function normalizeIndex(stored) {
    const index = emptyIndex();
    if (!stored || typeof stored !== 'object') return index;

    if (stored.files && typeof stored.files === 'object') {
        for (const [id, meta] of Object.entries(stored.files)) {
            if (meta && typeof meta.path === 'string') {
                index.files[id] = {
                    path: meta.path,
                    size: Number(meta.size) || 0,
                    created: meta.created ?? null,
                    updated: meta.updated ?? null,
                };
            }
        }
    }
    if (Array.isArray(stored.folders)) {
        index.folders = [...new Set(stored.folders.filter(folder => typeof folder === 'string' && folder))];
    }
    if (stored.trash && typeof stored.trash === 'object') {
        for (const [id, meta] of Object.entries(stored.trash)) {
            if (meta && typeof meta.path === 'string') {
                index.trash[id] = {
                    path: meta.path,
                    size: Number(meta.size) || 0,
                    deletedAt: meta.deletedAt ?? null,
                };
            }
        }
    }
    return index;
}

export class StudioFS {
    /** @param {import('./storage.js').Storage} storage */
    constructor(storage) {
        this.storage = storage;
        this.enqueue = createSerialQueue();
        this.index = null;
        /** @type {Map<string, string>} caminho -> id */
        this.byPath = new Map();
        /** @type {Map<string, string>} id -> texto */
        this.contentCache = new Map();
        this.listeners = new Set();
    }

    // ---------- infraestrutura ----------

    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(change) {
        for (const listener of this.listeners) {
            try {
                listener(change);
            } catch (error) {
                console.error(LOG_PREFIX, 'Erro num listener do estúdio', error);
            }
        }
    }

    run(task) {
        return this.enqueue(async () => {
            await this.ensureLoaded();
            return task();
        });
    }

    async ensureLoaded() {
        if (this.index) return;
        const stored = await this.storage.get(INDEX_TABLE, INDEX_KEY);
        this.index = normalizeIndex(stored);
        this.rebuildPathMap();
    }

    rebuildPathMap() {
        this.byPath.clear();
        for (const [id, meta] of Object.entries(this.index.files)) {
            this.byPath.set(meta.path, id);
        }
    }

    async saveIndex() {
        await this.storage.set(INDEX_TABLE, INDEX_KEY, this.index);
    }

    async loadContent(id) {
        if (this.contentCache.has(id)) return this.contentCache.get(id);
        const stored = await this.storage.get(FILES_TABLE, id);
        if (stored === undefined) {
            console.warn(LOG_PREFIX, `Conteúdo ausente para o arquivo ${id}; tratando como vazio.`);
        }
        const text = typeof stored?.text === 'string' ? stored.text : '';
        this.contentCache.set(id, text);
        return text;
    }

    async storeContent(id, text) {
        await this.storage.set(FILES_TABLE, id, { text });
        this.contentCache.set(id, text);
    }

    /** Pastas existentes: explícitas + ancestrais de arquivos e de pastas explícitas. */
    allFolders() {
        const folders = new Set();
        for (const folder of this.index.folders) {
            folders.add(folder);
            for (const ancestor of ancestorsOf(folder)) folders.add(ancestor);
        }
        for (const meta of Object.values(this.index.files)) {
            for (const ancestor of ancestorsOf(meta.path)) folders.add(ancestor);
        }
        return folders;
    }

    folderExists(path) {
        if (!path) return true;
        return this.allFolders().has(path);
    }

    requireFile(path) {
        const id = this.byPath.get(path);
        if (id) return { id, meta: this.index.files[id] };
        if (this.folderExists(path)) {
            throw new Error(`"${path}" is a folder, not a file. Use studio_list to see its contents.`);
        }
        throw new Error(`File not found: "${path}". Use studio_list or studio_search to find the right path.`);
    }

    /** Mantém uma pasta mesmo que fique vazia (como num sistema de arquivos normal). */
    keepFolder(path) {
        if (path && !this.index.folders.includes(path)) this.index.folders.push(path);
    }

    assertNoFileAncestor(path) {
        for (const ancestor of ancestorsOf(path)) {
            if (this.byPath.has(ancestor)) {
                throw new Error(`Cannot use "${path}": "${ancestor}" is a file, not a folder.`);
            }
        }
    }

    // ---------- operações usadas pelas ferramentas e pelo painel ----------

    list({ path = '', recursive = true, limit = 300 } = {}) {
        return this.run(() => {
            const folder = normalizePath(path, { allowRoot: true });
            if (folder && !this.folderExists(folder)) {
                if (this.byPath.has(folder)) {
                    throw new Error(`"${folder}" is a file, not a folder. Use studio_read to read it.`);
                }
                throw new Error(`Folder not found: "${folder}".`);
            }
            const max = clampInt(limit, { min: 1, max: 1000, fallback: 300 });
            const within = candidate => candidate !== folder && isInside(candidate, folder)
                && (recursive || parentPath(candidate) === folder);

            const folders = [...this.allFolders()].filter(within).sort();
            const files = Object.values(this.index.files)
                .filter(meta => within(meta.path))
                .sort((a, b) => a.path.localeCompare(b.path))
                .map(meta => ({ path: meta.path, size: meta.size, updated: meta.updated }));

            return {
                folder: folder || '/',
                folders: folders.slice(0, max),
                files: files.slice(0, max),
                total_folders: folders.length,
                total_files: files.length,
                truncated: folders.length > max || files.length > max,
            };
        });
    }

    read({ path, startLine, lineCount, maxChars } = {}) {
        return this.run(async () => {
            const filePath = normalizePath(path);
            const { id } = this.requireFile(filePath);
            const text = await this.loadContent(id);
            const lines = text.split('\n');
            const totalLines = lines.length;

            const start = clampInt(startLine, { min: 1, max: Math.max(totalLines, 1), fallback: 1 });
            const available = totalLines - start + 1;
            const count = lineCount === undefined || lineCount === null
                ? available
                : clampInt(lineCount, { min: 1, max: available, fallback: available });
            const limit = clampInt(maxChars, { min: 1, max: READ_MAX_CHARS, fallback: READ_DEFAULT_CHARS });

            const selected = lines.slice(start - 1, start - 1 + count).join('\n');
            const { text: content, truncated } = truncate(selected, limit);
            const endLine = start + Math.max(countLines(content), 1) - 1;

            const result = {
                path: filePath,
                content,
                start_line: start,
                end_line: endLine,
                total_lines: totalLines,
                total_chars: text.length,
                truncated,
            };
            if (truncated) {
                result.next_start_line = endLine;
            } else if (endLine < totalLines) {
                result.next_start_line = endLine + 1;
            }
            return result;
        });
    }

    write({ path, content, mode = 'replace' } = {}) {
        return this.run(async () => {
            const filePath = normalizePath(path);
            if (typeof content !== 'string') throw new Error('content must be a string.');
            if (mode !== 'replace' && mode !== 'append') throw new Error('mode must be "replace" or "append".');
            if (this.folderExists(filePath) && !this.byPath.has(filePath)) {
                throw new Error(`"${filePath}" is a folder. Choose a file path inside it, e.g. "${filePath}/notes.md".`);
            }
            this.assertNoFileAncestor(filePath);

            const existingId = this.byPath.get(filePath);
            let text = content;
            if (mode === 'append' && existingId) {
                text = (await this.loadContent(existingId)) + content;
            }
            if (text.length > MAX_FILE_CHARS) {
                throw new Error(`File too large (${text.length} chars). The limit is ${MAX_FILE_CHARS}; split it into several files.`);
            }

            const now = new Date().toISOString();
            let id = existingId;
            if (id) {
                await this.storeContent(id, text);
                const meta = this.index.files[id];
                meta.size = text.length;
                meta.updated = now;
            } else {
                id = generateId('f');
                await this.storeContent(id, text);
                this.index.files[id] = { path: filePath, size: text.length, created: now, updated: now };
                this.byPath.set(filePath, id);
            }
            await this.saveIndex();
            this.emit({ type: 'write', path: filePath, id });
            return { path: filePath, created: !existingId, size: text.length, lines: countLines(text) };
        });
    }

    edit({ path, oldString, newString, replaceAll = false } = {}) {
        return this.run(async () => {
            const filePath = normalizePath(path);
            if (typeof oldString !== 'string' || oldString.length === 0) {
                throw new Error('old_string must be a non-empty string. To rewrite the whole file use studio_write.');
            }
            if (typeof newString !== 'string') throw new Error('new_string must be a string.');
            const { id, meta } = this.requireFile(filePath);
            const text = await this.loadContent(id);
            const occurrences = countOccurrences(text, oldString);
            if (occurrences === 0) {
                throw new Error(`old_string was not found in "${filePath}". Read the file again and copy the exact text, including spaces and line breaks.`);
            }
            if (occurrences > 1 && !replaceAll) {
                throw new Error(`old_string matches ${occurrences} places in "${filePath}". Include more surrounding text to make it unique, or set replace_all to true.`);
            }
            const updated = replaceAll
                ? text.split(oldString).join(newString)
                : text.replace(oldString, () => newString);
            if (updated.length > MAX_FILE_CHARS) {
                throw new Error(`File would exceed ${MAX_FILE_CHARS} chars.`);
            }
            await this.storeContent(id, updated);
            meta.size = updated.length;
            meta.updated = new Date().toISOString();
            await this.saveIndex();
            this.emit({ type: 'write', path: filePath, id });
            return { path: filePath, replacements: replaceAll ? occurrences : 1, size: updated.length };
        });
    }

    makeFolder({ path } = {}) {
        return this.run(async () => {
            const folder = normalizePath(path);
            if (this.byPath.has(folder)) throw new Error(`"${folder}" already exists as a file.`);
            this.assertNoFileAncestor(folder);
            if (this.folderExists(folder)) return { path: folder, created: false };
            this.index.folders.push(folder);
            await this.saveIndex();
            this.emit({ type: 'folder', path: folder });
            return { path: folder, created: true };
        });
    }

    move({ from, to } = {}) {
        return this.run(async () => {
            const source = normalizePath(from);
            // '' (raiz) é aceito como destino: o item vai para a raiz com o mesmo nome.
            let target = normalizePath(to, { allowRoot: true });

            const fileId = this.byPath.get(source);
            const isFolder = !fileId && this.folderExists(source);
            if (!fileId && !isFolder) throw new Error(`Not found: "${source}".`);

            if (this.folderExists(target) && target !== source) {
                target = joinPath(target, baseName(source));
            }
            if (target === source) return { from: source, to: target, moved: false };
            if (this.byPath.has(target) || this.folderExists(target)) {
                throw new Error(`Cannot move to "${target}": something already exists there.`);
            }
            this.assertNoFileAncestor(target);

            this.keepFolder(parentPath(source));
            if (fileId) {
                this.index.files[fileId].path = target;
                this.byPath.delete(source);
                this.byPath.set(target, fileId);
                await this.saveIndex();
                this.emit({ type: 'move', from: source, to: target });
                return { from: source, to: target, type: 'file', moved: true };
            }

            if (isInside(target, source)) throw new Error('A folder cannot be moved inside itself.');
            const rebase = path => target + path.slice(source.length);
            let filesMoved = 0;
            for (const meta of Object.values(this.index.files)) {
                if (isInside(meta.path, source)) {
                    meta.path = rebase(meta.path);
                    filesMoved++;
                }
            }
            this.index.folders = this.index.folders.map(folder => (isInside(folder, source) ? rebase(folder) : folder));
            if (!this.index.folders.includes(target)) this.index.folders.push(target);
            this.rebuildPathMap();
            await this.saveIndex();
            this.emit({ type: 'move', from: source, to: target });
            return { from: source, to: target, type: 'folder', files_moved: filesMoved, moved: true };
        });
    }

    delete({ path } = {}) {
        return this.run(async () => {
            const target = normalizePath(path);
            const now = new Date().toISOString();
            const fileId = this.byPath.get(target);
            const trashFile = id => {
                const meta = this.index.files[id];
                this.index.trash[id] = { path: meta.path, size: meta.size, deletedAt: now };
                delete this.index.files[id];
            };

            this.keepFolder(parentPath(target));
            if (fileId) {
                trashFile(fileId);
                this.rebuildPathMap();
                await this.saveIndex();
                this.emit({ type: 'delete', path: target });
                return { deleted: target, type: 'file', files: 1, note: 'Moved to the Studio trash; the user can restore it.' };
            }
            if (!this.folderExists(target)) throw new Error(`Not found: "${target}".`);

            let count = 0;
            for (const [id, meta] of Object.entries(this.index.files)) {
                if (isInside(meta.path, target)) {
                    trashFile(id);
                    count++;
                }
            }
            this.index.folders = this.index.folders.filter(folder => !isInside(folder, target));
            this.rebuildPathMap();
            await this.saveIndex();
            this.emit({ type: 'delete', path: target });
            return { deleted: target, type: 'folder', files: count, note: 'Files were moved to the Studio trash; the user can restore them.' };
        });
    }

    search({ query, path = '', limit = 20, caseSensitive = false } = {}) {
        return this.run(async () => {
            const raw = typeof query === 'string' ? query.trim() : '';
            if (!raw) throw new Error('query is required.');
            const folder = normalizePath(path, { allowRoot: true });
            const max = clampInt(limit, { min: 1, max: 100, fallback: 20 });
            const needle = caseSensitive ? raw : raw.toLowerCase();
            const normalize = value => (caseSensitive ? value : value.toLowerCase());

            const results = [];
            let truncated = false;
            const files = Object.entries(this.index.files)
                .filter(([, meta]) => isInside(meta.path, folder))
                .sort(([, a], [, b]) => a.path.localeCompare(b.path));

            outer:
            for (const [id, meta] of files) {
                if (normalize(meta.path).includes(needle)) {
                    results.push({ path: meta.path, line: null, snippet: '(file name matches)' });
                    if (results.length >= max) { truncated = true; break; }
                }
                const lines = (await this.loadContent(id)).split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const position = normalize(lines[i]).indexOf(needle);
                    if (position === -1) continue;
                    results.push({ path: meta.path, line: i + 1, snippet: snippetAround(lines[i], position, raw.length) });
                    if (results.length >= max) { truncated = true; break outer; }
                }
            }
            return { query: raw, folder: folder || '/', results, truncated };
        });
    }

    // ---------- usados só pelo painel ----------

    snapshot() {
        return this.run(() => ({
            files: Object.entries(this.index.files).map(([id, meta]) => ({ id, ...meta })),
            folders: [...this.allFolders()].sort(),
            trashCount: Object.keys(this.index.trash).length,
        }));
    }

    readById(id) {
        return this.run(async () => {
            const meta = this.index.files[id];
            if (!meta) throw new Error('Arquivo não encontrado.');
            return { id, ...meta, text: await this.loadContent(id) };
        });
    }

    listTrash() {
        return this.run(() => Object.entries(this.index.trash)
            .map(([id, meta]) => ({ id, ...meta }))
            .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt))));
    }

    restoreFromTrash(id) {
        return this.run(async () => {
            const meta = this.index.trash[id];
            if (!meta) throw new Error('Item não está na lixeira.');
            let path = meta.path;
            if (this.byPath.has(path) || this.folderExists(path)) {
                const folder = parentPath(path);
                const name = baseName(path);
                const dot = name.lastIndexOf('.');
                const stem = dot > 0 ? name.slice(0, dot) : name;
                const ext = dot > 0 ? name.slice(dot) : '';
                let n = 1;
                do {
                    path = joinPath(folder, `${stem} (restaurado${n > 1 ? ` ${n}` : ''})${ext}`);
                    n++;
                } while (this.byPath.has(path) || this.folderExists(path));
            }
            this.assertNoFileAncestor(path);
            this.index.files[id] = { path, size: meta.size, created: meta.deletedAt, updated: new Date().toISOString() };
            delete this.index.trash[id];
            this.byPath.set(path, id);
            await this.saveIndex();
            this.emit({ type: 'restore', path });
            return { path };
        });
    }

    purgeFromTrash(id) {
        return this.run(async () => {
            if (!this.index.trash[id]) return;
            delete this.index.trash[id];
            await this.storage.remove(FILES_TABLE, id);
            this.contentCache.delete(id);
            await this.saveIndex();
            this.emit({ type: 'purge' });
        });
    }

    emptyTrash() {
        return this.run(async () => {
            const ids = Object.keys(this.index.trash);
            for (const id of ids) {
                await this.storage.remove(FILES_TABLE, id);
                this.contentCache.delete(id);
            }
            this.index.trash = {};
            await this.saveIndex();
            this.emit({ type: 'purge' });
            return ids.length;
        });
    }
}

function snippetAround(line, position, length) {
    if (line.length <= SNIPPET_CHARS) return line.trim();
    const half = Math.floor((SNIPPET_CHARS - length) / 2);
    const start = Math.max(0, position - Math.max(half, 0));
    const end = Math.min(line.length, start + SNIPPET_CHARS);
    return `${start > 0 ? '…' : ''}${line.slice(start, end).trim()}${end < line.length ? '…' : ''}`;
}
