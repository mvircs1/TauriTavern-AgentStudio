// Sistema de arquivos virtual do Agent Studio.
// Um índice (meta/index) guarda caminhos e metadados; o conteúdo de cada arquivo fica numa chave
// própria (files/<id>), porque as chaves do extension store não aceitam "/".
//
// Os caminhos são tolerantes: "Personagens/lyra" acha "personagens/Lyra.md", e acentos, maiúsculas
// ou a forma Unicode (composta/decomposta) não importam para achar algo que já existe.

import {
    ancestorsOf,
    baseName,
    clampInt,
    countLines,
    createSerialQueue,
    foldedIndexOf,
    foldText,
    generateId,
    isInside,
    joinPath,
    locateFlexible,
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

const foldPath = path => path.split('/').map(foldText).join('/');
const withoutExtension = path => path.replace(/\.[^./]+$/, '');
const hasExtension = path => /\.[^./]+$/.test(baseName(path));

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
        /** @type {import('./journal.js').RunJournal|null} */
        this.journal = null;
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

    // ---------- resolução tolerante de caminhos ----------

    /**
     * Acha um arquivo/pasta existente: primeiro exato; depois ignorando acentos, maiúsculas e
     * (para arquivos) a extensão. Devolve null se não achar; erro se ficar ambíguo.
     * @param {'file'|'folder'|'any'} kind
     */
    resolveExisting(path, kind = 'any') {
        if (kind !== 'folder' && this.byPath.has(path)) return { path, type: 'file' };
        if (kind !== 'file' && this.folderExists(path)) return { path, type: 'folder' };
        const target = foldPath(path);
        const found = [];
        if (kind !== 'folder') {
            for (const filePath of this.byPath.keys()) {
                const folded = foldPath(filePath);
                if (folded === target || foldPath(withoutExtension(filePath)) === target) found.push({ path: filePath, type: 'file' });
            }
        }
        if (kind !== 'file') {
            for (const folder of this.allFolders()) {
                if (foldPath(folder) === target) found.push({ path: folder, type: 'folder' });
            }
        }
        if (found.length === 1) return found[0];
        if (found.length > 1) {
            throw new Error(`"${path}" is ambiguous; it could be: ${found.map(item => `"${item.path}"`).join(', ')}.`);
        }
        return null;
    }

    requireFile(rawPath) {
        const path = normalizePath(rawPath);
        const resolved = this.resolveExisting(path, 'file');
        if (resolved) return { path: resolved.path, id: this.byPath.get(resolved.path) };
        if (this.resolveExisting(path, 'folder')) {
            throw new Error(`"${path}" is a folder, not a file. Use studio_list to see its contents.`);
        }
        throw new Error(`File not found: "${path}". Use studio_list or studio_search to find the right path.`);
    }

    /**
     * Caminho para escrever: reaproveita pastas e arquivo já existentes que só diferem em acentos ou
     * maiúsculas (evita criar "Personagens/" ao lado de "personagens/"), e põe ".md" se faltar extensão.
     */
    canonicalWritePath(path) {
        const segments = path.split('/');
        const folders = this.allFolders();
        let current = '';
        for (const segment of segments.slice(0, -1)) {
            const exact = joinPath(current, segment);
            if (folders.has(exact)) {
                current = exact;
                continue;
            }
            const matches = [...folders].filter(folder => parentPath(folder) === current && foldText(baseName(folder)) === foldText(segment));
            current = matches.length === 1 ? matches[0] : exact;
        }
        let name = segments[segments.length - 1];
        const exactFile = joinPath(current, name);
        if (this.byPath.has(exactFile) || folders.has(exactFile)) return exactFile;
        const sameNameFolder = [...folders].filter(folder => parentPath(folder) === current && foldText(baseName(folder)) === foldText(name));
        if (sameNameFolder.length === 1) return sameNameFolder[0];
        const sameFolder = [...this.byPath.keys()].filter(filePath => parentPath(filePath) === current);
        const byName = sameFolder.filter(filePath => foldText(baseName(filePath)) === foldText(name));
        if (byName.length === 1) return byName[0];
        if (!hasExtension(name)) {
            const byStem = sameFolder.filter(filePath => foldText(withoutExtension(baseName(filePath))) === foldText(name));
            if (byStem.length === 1) return byStem[0];
            name = `${name}.md`;
        }
        return joinPath(current, name);
    }

    canonicalFolderPath(path) {
        const segments = path.split('/');
        const folders = this.allFolders();
        let current = '';
        for (const segment of segments) {
            const exact = joinPath(current, segment);
            if (folders.has(exact)) {
                current = exact;
                continue;
            }
            const matches = [...folders].filter(folder => parentPath(folder) === current && foldText(baseName(folder)) === foldText(segment));
            current = matches.length === 1 ? matches[0] : exact;
        }
        return current;
    }

    // ---------- diário de alterações (desfazer ao regenerar) ----------

    async captureFile(runId, id) {
        if (!runId || !this.journal) return;
        await this.journal.capture(runId, `studio:${id}`, async () => {
            const meta = this.index.files[id];
            return {
                kind: 'studio_file',
                id,
                before: meta
                    ? { exists: true, meta: { ...meta }, text: await this.loadContent(id) }
                    : { exists: false },
            };
        });
    }

    async captureFolders(runId) {
        if (!runId || !this.journal) return;
        await this.journal.capture(runId, 'studio:folders', async () => ({ kind: 'studio_folders', before: [...this.index.folders] }));
    }

    /** Volta os arquivos tocados por uma run ao estado anterior. Devolve quantos arquivos mudaram. */
    undoEntries(entries) {
        return this.run(async () => {
            const files = entries.filter(entry => entry.kind === 'studio_file');
            const now = new Date().toISOString();
            let changed = 0;
            // 1) Arquivos que a run criou vão para a lixeira.
            for (const entry of files) {
                if (entry.before.exists || !this.index.files[entry.id]) continue;
                const meta = this.index.files[entry.id];
                this.index.trash[entry.id] = { path: meta.path, size: meta.size, deletedAt: now };
                delete this.index.files[entry.id];
                changed++;
            }
            this.rebuildPathMap();
            // 2) Arquivos que já existiam voltam ao conteúdo e lugar de antes.
            for (const entry of files) {
                if (!entry.before.exists) continue;
                const meta = { ...entry.before.meta };
                const occupant = this.byPath.get(meta.path);
                if (occupant && occupant !== entry.id) {
                    const other = this.index.files[occupant];
                    this.index.trash[occupant] = { path: other.path, size: other.size, deletedAt: now };
                    delete this.index.files[occupant];
                }
                delete this.index.trash[entry.id];
                this.index.files[entry.id] = meta;
                await this.storeContent(entry.id, entry.before.text);
                this.rebuildPathMap();
                changed++;
            }
            const folders = entries.find(entry => entry.kind === 'studio_folders');
            if (folders) this.index.folders = [...folders.before];
            await this.saveIndex();
            this.emit({ type: 'undo' });
            return changed;
        });
    }

    /** Estado atual das mesmas coisas que as entradas descrevem (para refazer ao voltar numa swipe). */
    snapshotEntries(entries) {
        return this.run(async () => {
            const result = [];
            for (const entry of entries) {
                if (entry.kind === 'studio_file') {
                    const meta = this.index.files[entry.id];
                    result.push({
                        key: entry.key,
                        kind: 'studio_file',
                        id: entry.id,
                        before: meta ? { exists: true, meta: { ...meta }, text: await this.loadContent(entry.id) } : { exists: false },
                    });
                } else if (entry.kind === 'studio_folders') {
                    result.push({ key: entry.key, kind: 'studio_folders', before: [...this.index.folders] });
                }
            }
            return result;
        });
    }

    // ---------- operações usadas pelas ferramentas e pelo painel ----------

    list({ path = '', recursive = true, limit = 300 } = {}) {
        return this.run(() => {
            let folder = normalizePath(path, { allowRoot: true });
            if (folder) {
                const resolved = this.resolveExisting(folder, 'folder');
                if (!resolved) {
                    if (this.resolveExisting(folder, 'file')) {
                        throw new Error(`"${folder}" is a file, not a folder. Use studio_read to read it.`);
                    }
                    throw new Error(`Folder not found: "${folder}". Use studio_list without a path to see the whole studio.`);
                }
                folder = resolved.path;
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
            const { path: filePath, id } = this.requireFile(path);
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

    write({ path, content, mode = 'replace', runId } = {}) {
        return this.run(async () => {
            const filePath = this.canonicalWritePath(normalizePath(path));
            const body = typeof content === 'string' ? content : (content === undefined || content === null ? null : String(content));
            if (body === null) throw new Error('content is required (the text of the file).');
            const writeMode = mode === 'append' ? 'append' : 'replace';
            if (this.folderExists(filePath) && !this.byPath.has(filePath)) {
                throw new Error(`"${filePath}" is a folder. Choose a file path inside it, e.g. "${filePath}/notes.md".`);
            }
            this.assertNoFileAncestor(filePath);

            const existingId = this.byPath.get(filePath);
            const id = existingId ?? generateId('f');
            await this.captureFile(runId, id);

            let text = body;
            if (writeMode === 'append' && existingId) {
                const current = await this.loadContent(existingId);
                text = current && !current.endsWith('\n') && !body.startsWith('\n') ? `${current}\n${body}` : current + body;
            }
            if (text.length > MAX_FILE_CHARS) {
                throw new Error(`File too large (${text.length} chars). The limit is ${MAX_FILE_CHARS}; split it into several files.`);
            }

            const now = new Date().toISOString();
            await this.storeContent(id, text);
            if (existingId) {
                const meta = this.index.files[id];
                meta.size = text.length;
                meta.updated = now;
            } else {
                this.index.files[id] = { path: filePath, size: text.length, created: now, updated: now };
                this.byPath.set(filePath, id);
            }
            await this.saveIndex();
            this.emit({ type: 'write', path: filePath, id });
            return { path: filePath, created: !existingId, size: text.length, lines: countLines(text) };
        });
    }

    edit({ path, oldString, newString, replaceAll = false, runId } = {}) {
        return this.run(async () => {
            if (typeof oldString !== 'string' || oldString.length === 0) {
                throw new Error('old_string must be a non-empty string. To rewrite the whole file use studio_write.');
            }
            const replacement = typeof newString === 'string' ? newString.normalize('NFC') : (newString === undefined || newString === null ? '' : String(newString));
            const { path: filePath, id } = this.requireFile(path);
            const original = await this.loadContent(id);
            const { text, needle, count } = locateFlexible(original, oldString);
            if (count === 0) {
                throw new Error(`old_string was not found in "${filePath}". Read the file again (studio_read) and copy the exact text.`);
            }
            if (count > 1 && !replaceAll) {
                throw new Error(`old_string matches ${count} places in "${filePath}". Include more surrounding text to make it unique, or set replace_all to true.`);
            }
            const updated = replaceAll ? text.split(needle).join(replacement) : text.replace(needle, () => replacement);
            if (updated.length > MAX_FILE_CHARS) throw new Error(`File would exceed ${MAX_FILE_CHARS} chars.`);

            await this.captureFile(runId, id);
            await this.storeContent(id, updated);
            const meta = this.index.files[id];
            meta.size = updated.length;
            meta.updated = new Date().toISOString();
            await this.saveIndex();
            this.emit({ type: 'write', path: filePath, id });
            return { path: filePath, replacements: replaceAll ? count : 1, size: updated.length };
        });
    }

    makeFolder({ path, runId } = {}) {
        return this.run(async () => {
            const folder = this.canonicalFolderPath(normalizePath(path));
            if (this.byPath.has(folder)) throw new Error(`"${folder}" already exists as a file.`);
            this.assertNoFileAncestor(folder);
            if (this.folderExists(folder)) return { path: folder, created: false };
            await this.captureFolders(runId);
            this.index.folders.push(folder);
            await this.saveIndex();
            this.emit({ type: 'folder', path: folder });
            return { path: folder, created: true };
        });
    }

    move({ from, to, runId } = {}) {
        return this.run(async () => {
            const sourceInput = normalizePath(from);
            const resolved = this.resolveExisting(sourceInput, 'any');
            if (!resolved) throw new Error(`Not found: "${sourceInput}". Use studio_list to see what exists.`);
            const source = resolved.path;
            const fileId = resolved.type === 'file' ? this.byPath.get(source) : null;

            // '' (raiz) é aceito como destino: o item vai para a raiz com o mesmo nome.
            let target = normalizePath(to, { allowRoot: true });
            const targetFolder = target ? this.resolveExisting(target, 'folder') : { path: '' };
            if (targetFolder && targetFolder.path !== source) {
                target = joinPath(targetFolder.path, baseName(source));
            } else if (target) {
                const canonical = fileId ? this.canonicalWritePath(target) : this.canonicalFolderPath(target);
                // Se o "parecido" achado é o próprio item, é uma renomeação de maiúsculas/acentos: usa o pedido.
                target = canonical === source ? target : canonical;
            }
            if (target === source) return { from: source, to: target, moved: false };
            if (this.byPath.has(target) || this.folderExists(target)) {
                throw new Error(`Cannot move to "${target}": something already exists there.`);
            }
            this.assertNoFileAncestor(target);
            if (!fileId && isInside(target, source)) throw new Error('A folder cannot be moved inside itself.');

            await this.captureFolders(runId);
            if (fileId) {
                await this.captureFile(runId, fileId);
                this.keepFolder(parentPath(source));
                this.index.files[fileId].path = target;
                this.byPath.delete(source);
                this.byPath.set(target, fileId);
                await this.saveIndex();
                this.emit({ type: 'move', from: source, to: target });
                return { from: source, to: target, type: 'file', moved: true };
            }

            const rebase = path => target + path.slice(source.length);
            let filesMoved = 0;
            for (const [id, meta] of Object.entries(this.index.files)) {
                if (isInside(meta.path, source)) {
                    await this.captureFile(runId, id);
                    meta.path = rebase(meta.path);
                    filesMoved++;
                }
            }
            this.keepFolder(parentPath(source));
            this.index.folders = this.index.folders.map(folder => (isInside(folder, source) ? rebase(folder) : folder));
            if (!this.index.folders.includes(target)) this.index.folders.push(target);
            this.rebuildPathMap();
            await this.saveIndex();
            this.emit({ type: 'move', from: source, to: target });
            return { from: source, to: target, type: 'folder', files_moved: filesMoved, moved: true };
        });
    }

    delete({ path, runId } = {}) {
        return this.run(async () => {
            const input = normalizePath(path);
            const resolved = this.resolveExisting(input, 'any');
            if (!resolved) throw new Error(`Not found: "${input}". Use studio_list to see what exists.`);
            const target = resolved.path;
            const now = new Date().toISOString();
            const trashFile = id => {
                const meta = this.index.files[id];
                this.index.trash[id] = { path: meta.path, size: meta.size, deletedAt: now };
                delete this.index.files[id];
            };

            await this.captureFolders(runId);
            this.keepFolder(parentPath(target));
            if (resolved.type === 'file') {
                const fileId = this.byPath.get(target);
                await this.captureFile(runId, fileId);
                trashFile(fileId);
                this.rebuildPathMap();
                await this.saveIndex();
                this.emit({ type: 'delete', path: target });
                return { deleted: target, type: 'file', files: 1, note: 'Moved to the Studio trash; the user can restore it.' };
            }

            let count = 0;
            for (const [id, meta] of Object.entries(this.index.files)) {
                if (isInside(meta.path, target)) {
                    await this.captureFile(runId, id);
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
            const raw = typeof query === 'string' ? query.normalize('NFC').trim() : String(query ?? '').trim();
            if (!raw) throw new Error('query is required.');
            let folder = normalizePath(path, { allowRoot: true });
            if (folder) folder = this.resolveExisting(folder, 'folder')?.path ?? folder;
            const max = clampInt(limit, { min: 1, max: 100, fallback: 20 });
            // Sem diferenciar maiúsculas, a busca também ignora acentos ("acao" acha "ação").
            const find = (text, needle) => (caseSensitive ? text.normalize('NFC').indexOf(needle) : foldedIndexOf(text, needle));

            const results = [];
            let truncated = false;
            const files = Object.entries(this.index.files)
                .filter(([, meta]) => isInside(meta.path, folder))
                .sort(([, a], [, b]) => a.path.localeCompare(b.path));

            outer:
            for (const [id, meta] of files) {
                if (find(meta.path, raw) !== -1) {
                    results.push({ path: meta.path, line: null, snippet: '(file name matches)' });
                    if (results.length >= max) { truncated = true; break; }
                }
                const lines = (await this.loadContent(id)).split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].normalize('NFC');
                    const position = find(line, raw);
                    if (position === -1) continue;
                    results.push({ path: meta.path, line: i + 1, snippet: snippetAround(line, position, raw.length) });
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
