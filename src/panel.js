// Painel visual do Agent Studio: explorador + editor de arquivos, backups dos lorebooks,
// registro de atividade do Agent e lixeira.

import {
    ancestorsOf,
    baseName,
    countLines,
    errorMessage,
    escapeHtml,
    formatDateTime,
    joinPath,
    LOG_PREFIX,
    normalizePath,
    parentPath,
} from './util.js';
import { SystemView } from './system-panel.js';
import { confirmDialog, downloadText, promptText, renderMarkdown } from './ui.js';

const REASON_LABELS = {
    create_entry: 'antes de o Agent criar uma entrada',
    update_entry: 'antes de o Agent editar uma entrada',
    delete_entry: 'antes de o Agent excluir uma entrada',
    before_restore: 'antes de uma restauração',
    manual: 'backup manual',
};

const TOOL_LABELS = {
    studio_list: 'Listar', studio_read: 'Ler', studio_write: 'Escrever', studio_edit: 'Editar',
    studio_search: 'Buscar', studio_make_folder: 'Nova pasta', studio_move: 'Mover', studio_delete: 'Excluir',
    lorebook_list: 'Lorebooks', lorebook_read: 'Ler lorebook', lorebook_search: 'Buscar em lorebooks',
    lorebook_create_entry: 'Criar entrada', lorebook_update_entry: 'Editar entrada',
    lorebook_delete_entry: 'Excluir entrada', lorebook_create_book: 'Criar lorebook',
    system_info: 'Ver sistema', system_roll: 'Teste', sheet_list: 'Fichas', sheet_read: 'Ler ficha',
    sheet_create: 'Criar ficha', sheet_update: 'Editar ficha', sheet_resource: 'Recurso', sheet_delete: 'Excluir ficha',
    ui_roll: 'Teste (você)',
};

export class StudioPanel {
    constructor({ fs, lore, activity, system }) {
        this.fs = fs;
        this.lore = lore;
        this.activity = activity;
        this.system = system;
        this.systemView = null;
        this.root = null;
        this.tab = 'files';
        this.data = { files: [], folders: [], trashCount: 0 };
        this.expanded = new Set();
        /** @type {{ kind: 'file'|'folder', path: string, id?: string } | null} */
        this.selected = null;
        /** @type {{ id: string, path: string, updated: string|null, deleted?: boolean } | null} */
        this.current = null;
        this.dirty = false;
        this.saving = false;
        this.preview = false;
        this.filter = '';
        this.refreshTimer = null;
        this.onKeyDown = this.onKeyDown.bind(this);
    }

    // ---------- abrir / fechar ----------

    open() {
        if (!this.root) this.build();
        this.root.hidden = false;
        document.addEventListener('keydown', this.onKeyDown);
        this.switchTab(this.tab);
    }

    async close() {
        if (this.dirty) {
            if (!(await confirmDialog('Descartar alterações?', 'O arquivo aberto tem alterações não salvas.'))) return;
            this.closeEditor();
        }
        this.root.hidden = true;
        document.removeEventListener('keydown', this.onKeyDown);
    }

    isOpen() {
        return Boolean(this.root && !this.root.hidden);
    }

    onKeyDown(event) {
        if (!this.isOpen()) return;
        if (event.key === 'Escape' && !document.querySelector('dialog[open]')) {
            event.preventDefault();
            this.close();
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && this.tab === 'files' && this.current) {
            event.preventDefault();
            this.save();
        }
    }

    // ---------- estrutura ----------

    build() {
        const root = document.createElement('div');
        root.className = 'agst-overlay';
        root.hidden = true;
        root.innerHTML = `
            <div class="agst-window" role="dialog" aria-label="Agent Studio">
                <header class="agst-header">
                    <div class="agst-title"><i class="fa-solid fa-folder-tree"></i><span>Agent Studio</span></div>
                    <nav class="agst-tabs">
                        <button type="button" class="agst-tab" data-tab="files"><i class="fa-solid fa-folder"></i><span>Arquivos</span></button>
                        <button type="button" class="agst-tab" data-tab="system"><i class="fa-solid fa-dice-d20"></i><span>Sistema</span></button>
                        <button type="button" class="agst-tab" data-tab="backups"><i class="fa-solid fa-clock-rotate-left"></i><span>Backups</span></button>
                        <button type="button" class="agst-tab" data-tab="activity"><i class="fa-solid fa-list-check"></i><span>Atividade</span></button>
                        <button type="button" class="agst-tab" data-tab="trash"><i class="fa-solid fa-trash-can"></i><span>Lixeira</span></button>
                    </nav>
                    <button type="button" class="agst-icon-button" data-action="close" title="Fechar"><i class="fa-solid fa-xmark"></i></button>
                </header>

                <section class="agst-panel agst-files" data-panel="files">
                    <aside class="agst-sidebar">
                        <div class="agst-toolbar">
                            <button type="button" class="agst-icon-button" data-action="new-file" title="Novo arquivo"><i class="fa-solid fa-file-circle-plus"></i></button>
                            <button type="button" class="agst-icon-button" data-action="new-folder" title="Nova pasta"><i class="fa-solid fa-folder-plus"></i></button>
                            <button type="button" class="agst-icon-button" data-action="rename" title="Renomear / mover o item selecionado"><i class="fa-solid fa-i-cursor"></i></button>
                            <button type="button" class="agst-icon-button" data-action="delete" title="Excluir o item selecionado"><i class="fa-solid fa-trash-can"></i></button>
                            <span class="agst-spacer"></span>
                            <button type="button" class="agst-icon-button" data-action="collapse" title="Recolher pastas"><i class="fa-solid fa-angles-up"></i></button>
                            <button type="button" class="agst-icon-button" data-action="refresh" title="Atualizar"><i class="fa-solid fa-rotate"></i></button>
                        </div>
                        <input type="search" class="text_pole agst-filter" placeholder="Filtrar por nome…" data-role="filter">
                        <div class="agst-tree" data-role="tree"></div>
                        <div class="agst-footer agst-muted" data-role="stats"></div>
                    </aside>
                    <div class="agst-editor">
                        <div class="agst-empty" data-role="editor-empty">
                            <i class="fa-solid fa-feather-pointed"></i>
                            <p>Selecione um arquivo ou crie um novo.</p>
                            <p class="agst-muted">Tudo aqui é compartilhado entre todos os chats. O Agent também lê e organiza estes arquivos.</p>
                        </div>
                        <div class="agst-editor-main" data-role="editor" hidden>
                            <div class="agst-editor-bar">
                                <button type="button" class="agst-icon-button agst-back" data-action="back" title="Voltar"><i class="fa-solid fa-arrow-left"></i></button>
                                <span class="agst-path" data-role="path"></span>
                                <span class="agst-dirty" data-role="dirty" hidden>●</span>
                                <span class="agst-spacer"></span>
                                <button type="button" class="agst-icon-button" data-action="toggle-preview" title="Visualizar / editar"><i class="fa-solid fa-eye"></i></button>
                                <button type="button" class="menu_button menu_button_icon agst-save" data-action="save" title="Salvar (Ctrl+S)"><i class="fa-solid fa-floppy-disk"></i><span>Salvar</span></button>
                            </div>
                            <div class="agst-banner" data-role="banner" hidden></div>
                            <textarea class="text_pole agst-textarea" data-role="textarea" spellcheck="false"></textarea>
                            <div class="agst-preview" data-role="preview" hidden></div>
                            <div class="agst-footer agst-muted" data-role="editor-info"></div>
                        </div>
                    </div>
                </section>

                <section class="agst-panel agst-system" data-panel="system" hidden></section>

                <section class="agst-panel agst-list-panel" data-panel="backups" hidden>
                    <div class="agst-list-toolbar">
                        <select class="text_pole" data-role="backup-book"></select>
                        <button type="button" class="menu_button menu_button_icon" data-action="backup-now"><i class="fa-solid fa-camera"></i><span>Fazer backup agora</span></button>
                    </div>
                    <p class="agst-muted agst-note">Antes de cada alteração do Agent num lorebook, uma cópia é guardada aqui (uma por lorebook a cada run).</p>
                    <div class="agst-list" data-role="backup-list"></div>
                </section>

                <section class="agst-panel agst-list-panel" data-panel="activity" hidden>
                    <div class="agst-list-toolbar">
                        <span class="agst-muted">Últimas chamadas de ferramenta feitas pelo Agent.</span>
                        <span class="agst-spacer"></span>
                        <button type="button" class="menu_button menu_button_icon" data-action="clear-activity"><i class="fa-solid fa-broom"></i><span>Limpar</span></button>
                    </div>
                    <div class="agst-list" data-role="activity-list"></div>
                </section>

                <section class="agst-panel agst-list-panel" data-panel="trash" hidden>
                    <div class="agst-list-toolbar">
                        <span class="agst-muted">Arquivos excluídos (por você ou pelo Agent).</span>
                        <span class="agst-spacer"></span>
                        <button type="button" class="menu_button menu_button_icon" data-action="empty-trash"><i class="fa-solid fa-dumpster"></i><span>Esvaziar</span></button>
                    </div>
                    <div class="agst-list" data-role="trash-list"></div>
                </section>
            </div>`;
        document.body.append(root);
        this.root = root;

        root.addEventListener('click', event => this.onClick(event));
        root.addEventListener('pointerdown', event => {
            if (event.target === root) this.close();
        });
        this.$('filter').addEventListener('input', event => {
            this.filter = event.target.value.trim();
            this.renderTree();
        });
        this.$('textarea').addEventListener('input', () => this.setDirty(true));

        this.systemView = new SystemView({
            system: this.system,
            lore: this.lore,
            activity: this.activity,
            container: root.querySelector('[data-panel="system"]'),
        });
        this.systemView.mount();
        this.system.onChange(() => {
            if (this.isOpen() && this.tab === 'system') this.systemView.refresh();
        });

        this.fs.onChange(() => this.scheduleRefresh());
        this.lore.onChange(change => {
            if (change.type === 'backup' && this.isOpen() && this.tab === 'backups') this.renderBackups();
        });
        this.activity.onChange(() => {
            if (this.isOpen() && this.tab === 'activity') this.renderActivity();
        });
    }

    $(role) {
        return this.root.querySelector(`[data-role="${role}"]`);
    }

    switchTab(tab) {
        this.tab = tab;
        for (const button of this.root.querySelectorAll('.agst-tab')) {
            button.classList.toggle('is-active', button.dataset.tab === tab);
        }
        for (const panel of this.root.querySelectorAll('[data-panel]')) {
            panel.hidden = panel.dataset.panel !== tab;
        }
        const render = {
            files: () => this.refreshFiles(),
            system: () => this.systemView.render(),
            backups: () => this.renderBackups(),
            activity: () => this.renderActivity(),
            trash: () => this.renderTrash(),
        }[tab];
        render?.().catch?.(error => this.fail(error));
    }

    fail(error, title = 'Agent Studio') {
        console.error(LOG_PREFIX, error);
        toastr.error(errorMessage(error), title);
    }

    async onClick(event) {
        const tabButton = event.target.closest('.agst-tab');
        if (tabButton) {
            this.switchTab(tabButton.dataset.tab);
            return;
        }
        const row = event.target.closest('.agst-row');
        if (row && this.root.contains(row)) {
            this.onRowClick(row);
            return;
        }
        const actionEl = event.target.closest('[data-action]');
        if (!actionEl) return;
        const { action } = actionEl.dataset;
        try {
            switch (action) {
                case 'close': await this.close(); break;
                case 'new-file': await this.createFile(); break;
                case 'new-folder': await this.createFolder(); break;
                case 'rename': await this.renameSelected(); break;
                case 'delete': await this.deleteSelected(); break;
                case 'collapse': this.expanded.clear(); this.renderTree(); break;
                case 'refresh': await this.refreshFiles(); break;
                case 'back': this.root.querySelector('.agst-files').classList.remove('agst-show-editor'); break;
                case 'save': await this.save(); break;
                case 'toggle-preview': this.togglePreview(); break;
                case 'reload-file': await this.reloadCurrent(); break;
                case 'close-file': this.closeEditor(); break;
                case 'backup-now': await this.backupNow(); break;
                case 'restore-backup': await this.restoreBackup(actionEl.dataset.id); break;
                case 'export-backup': await this.exportBackup(actionEl.dataset.id); break;
                case 'delete-backup': await this.deleteBackup(actionEl.dataset.id); break;
                case 'clear-activity': this.activity.clear(); break;
                case 'restore-trash': await this.restoreTrash(actionEl.dataset.id); break;
                case 'purge-trash': await this.purgeTrash(actionEl.dataset.id); break;
                case 'empty-trash': await this.emptyTrash(); break;
                default: break;
            }
        } catch (error) {
            this.fail(error);
        }
    }

    // ---------- árvore de arquivos ----------

    scheduleRefresh() {
        if (!this.isOpen()) return;
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
            if (this.tab === 'files') this.refreshFiles().catch(error => this.fail(error));
            if (this.tab === 'trash') this.renderTrash().catch(error => this.fail(error));
        }, 150);
    }

    async refreshFiles() {
        this.data = await this.fs.snapshot();
        this.renderTree();
        await this.syncCurrentWithIndex();
    }

    renderTree() {
        const tree = this.$('tree');
        const { files, folders, trashCount } = this.data;
        this.$('stats').textContent = `${files.length} arquivo${files.length === 1 ? '' : 's'} · ${folders.length} pasta${folders.length === 1 ? '' : 's'}${trashCount ? ` · ${trashCount} na lixeira` : ''}`;

        if (!files.length && !folders.length) {
            tree.innerHTML = '<div class="agst-tree-empty agst-muted">O estúdio está vazio.<br>Crie um arquivo, ou peça ao Agent para organizar algo aqui.</div>';
            return;
        }

        const rows = [];
        if (this.filter) {
            const needle = this.filter.toLowerCase();
            const matches = files.filter(file => file.path.toLowerCase().includes(needle))
                .sort((a, b) => a.path.localeCompare(b.path));
            for (const file of matches) rows.push(this.fileRow(file, 0, file.path));
            if (!matches.length) rows.push('<div class="agst-tree-empty agst-muted">Nada encontrado.</div>');
        } else {
            const childFolders = new Map();
            const childFiles = new Map();
            for (const folder of folders) {
                const parent = parentPath(folder);
                if (!childFolders.has(parent)) childFolders.set(parent, []);
                childFolders.get(parent).push(folder);
            }
            for (const file of files) {
                const parent = parentPath(file.path);
                if (!childFiles.has(parent)) childFiles.set(parent, []);
                childFiles.get(parent).push(file);
            }
            const walk = (folder, depth) => {
                const subfolders = (childFolders.get(folder) ?? []).sort((a, b) => baseName(a).localeCompare(baseName(b)));
                for (const sub of subfolders) {
                    const open = this.expanded.has(sub);
                    rows.push(this.folderRow(sub, depth, open));
                    if (open) walk(sub, depth + 1);
                }
                const folderFiles = (childFiles.get(folder) ?? []).sort((a, b) => baseName(a.path).localeCompare(baseName(b.path)));
                for (const file of folderFiles) rows.push(this.fileRow(file, depth, baseName(file.path)));
            };
            walk('', 0);
        }
        tree.innerHTML = rows.join('');
    }

    folderRow(path, depth, open) {
        const selected = this.selected?.kind === 'folder' && this.selected.path === path;
        return `<div class="agst-row${selected ? ' is-selected' : ''}" data-kind="folder" data-path="${escapeHtml(path)}" style="--depth:${depth}">
            <i class="fa-solid ${open ? 'fa-chevron-down' : 'fa-chevron-right'} agst-caret"></i>
            <i class="fa-solid ${open ? 'fa-folder-open' : 'fa-folder'} agst-row-icon"></i>
            <span class="agst-row-name">${escapeHtml(baseName(path))}</span>
        </div>`;
    }

    fileRow(file, depth, label) {
        const selected = this.selected?.kind === 'file' && this.selected.id === file.id;
        const isCurrent = this.current?.id === file.id;
        return `<div class="agst-row${selected ? ' is-selected' : ''}${isCurrent ? ' is-current' : ''}" data-kind="file" data-id="${escapeHtml(file.id)}" data-path="${escapeHtml(file.path)}" style="--depth:${depth}">
            <span class="agst-caret"></span>
            <i class="fa-solid fa-file-lines agst-row-icon"></i>
            <span class="agst-row-name" title="${escapeHtml(file.path)}">${escapeHtml(label)}</span>
        </div>`;
    }

    onRowClick(row) {
        const { kind, path, id } = row.dataset;
        if (kind === 'folder') {
            this.selected = { kind, path };
            if (this.expanded.has(path)) this.expanded.delete(path);
            else this.expanded.add(path);
            this.renderTree();
            return;
        }
        this.selected = { kind: 'file', path, id };
        this.openFile(id).catch(error => this.fail(error));
    }

    /** Pasta onde criar coisas novas: a selecionada, ou a do arquivo selecionado. */
    targetFolder() {
        if (!this.selected) return '';
        return this.selected.kind === 'folder' ? this.selected.path : parentPath(this.selected.path);
    }

    async createFile() {
        const folder = this.targetFolder();
        const input = await promptText('Novo arquivo', 'novo-arquivo.md', folder ? `Dentro de: ${folder}/  (pode incluir subpastas, ex.: notas/ideias.md)` : 'Pode incluir pastas, ex.: personagens/Lyra.md');
        if (input === null) return;
        const path = joinPath(folder, normalizePath(input));
        if (this.data.files.some(file => file.path === path)) {
            toastr.warning(`Já existe um arquivo "${path}".`);
            return;
        }
        if (!(await this.confirmDiscard())) return;
        await this.fs.write({ path, content: '', mode: 'replace' });
        for (const ancestor of ancestorsOf(path)) this.expanded.add(ancestor);
        await this.refreshFiles();
        const created = this.data.files.find(file => file.path === path);
        if (created) {
            this.selected = { kind: 'file', path, id: created.id };
            await this.openFile(created.id, { skipDirtyCheck: true });
        }
    }

    async createFolder() {
        const folder = this.targetFolder();
        const input = await promptText('Nova pasta', '', folder ? `Dentro de: ${folder}/` : 'Ex.: mundos/Aetheria');
        if (input === null || !input.trim()) return;
        const path = joinPath(folder, normalizePath(input));
        await this.fs.makeFolder({ path });
        for (const ancestor of [...ancestorsOf(path), path]) this.expanded.add(ancestor);
        this.selected = { kind: 'folder', path };
        await this.refreshFiles();
    }

    async renameSelected() {
        if (!this.selected) {
            toastr.info('Selecione um arquivo ou pasta primeiro.');
            return;
        }
        const from = this.selected.path;
        const input = await promptText('Renomear / mover', from, 'Caminho completo novo. Se for uma pasta existente, o item vai para dentro dela.');
        if (input === null) return;
        const to = normalizePath(input, { allowRoot: true });
        if (to === from) return;
        const result = await this.fs.move({ from, to });
        if (this.selected.kind === 'folder') {
            this.expanded.delete(from);
            this.expanded.add(result.to);
        }
        this.selected = { ...this.selected, path: result.to };
        await this.refreshFiles();
    }

    async deleteSelected() {
        if (!this.selected) {
            toastr.info('Selecione um arquivo ou pasta primeiro.');
            return;
        }
        const { kind, path } = this.selected;
        const message = kind === 'folder'
            ? `A pasta "${path}" e tudo dentro dela vão para a lixeira.`
            : `"${path}" vai para a lixeira.`;
        if (!(await confirmDialog('Excluir?', message))) return;
        await this.fs.delete({ path });
        this.selected = null;
        if (this.current && (this.current.path === path || this.current.path.startsWith(`${path}/`))) {
            this.closeEditor();
        }
        await this.refreshFiles();
    }

    // ---------- editor ----------

    async confirmDiscard() {
        if (!this.dirty) return true;
        const ok = await confirmDialog('Descartar alterações?', `"${this.current?.path}" tem alterações não salvas.`);
        if (ok) this.setDirty(false);
        return ok;
    }

    async openFile(id, { skipDirtyCheck = false } = {}) {
        if (this.current?.id === id && !this.current.deleted) {
            this.root.querySelector('.agst-files').classList.add('agst-show-editor');
            this.renderTree();
            return;
        }
        if (!skipDirtyCheck && !(await this.confirmDiscard())) {
            this.renderTree();
            return;
        }
        const file = await this.fs.readById(id);
        this.current = { id: file.id, path: file.path, updated: file.updated };
        this.$('textarea').value = file.text;
        this.setDirty(false);
        this.hideBanner();
        this.$('editor-empty').hidden = true;
        this.$('editor').hidden = false;
        this.root.querySelector('.agst-files').classList.add('agst-show-editor');
        this.updateEditorInfo();
        if (this.preview) this.renderPreview();
        this.renderTree();
    }

    closeEditor() {
        this.current = null;
        this.setDirty(false);
        this.hideBanner();
        this.$('editor').hidden = true;
        this.$('editor-empty').hidden = false;
        this.root.querySelector('.agst-files').classList.remove('agst-show-editor');
        this.renderTree();
    }

    setDirty(dirty) {
        this.dirty = dirty;
        if (!this.root) return;
        this.$('dirty').hidden = !dirty;
        this.updateEditorInfo();
    }

    updateEditorInfo() {
        if (!this.current) return;
        const text = this.$('textarea').value;
        this.$('path').textContent = this.current.path;
        this.$('path').title = this.current.path;
        const updated = this.current.updated ? ` · salvo em ${formatDateTime(this.current.updated)}` : '';
        this.$('editor-info').textContent = `${text.length} caracteres · ${countLines(text)} linhas${updated}`;
    }

    async save() {
        if (!this.current || this.saving) return;
        if (this.current.deleted) {
            toastr.warning('Este arquivo foi excluído. Restaure-o da lixeira ou crie um novo.');
            return;
        }
        this.saving = true;
        try {
            await this.fs.write({ path: this.current.path, content: this.$('textarea').value, mode: 'replace' });
            this.data = await this.fs.snapshot();
            const meta = this.data.files.find(file => file.id === this.current.id);
            if (meta) this.current.updated = meta.updated;
            this.setDirty(false);
            this.hideBanner();
            this.renderTree();
            toastr.success('Salvo.', '', { timeOut: 1500 });
        } finally {
            this.saving = false;
        }
    }

    async reloadCurrent() {
        if (!this.current) return;
        const file = await this.fs.readById(this.current.id);
        this.current = { id: file.id, path: file.path, updated: file.updated };
        this.$('textarea').value = file.text;
        this.setDirty(false);
        this.hideBanner();
        if (this.preview) this.renderPreview();
    }

    /** Reage a mudanças feitas pelo Agent no arquivo aberto. */
    async syncCurrentWithIndex() {
        if (!this.current || this.saving) return;
        const meta = this.data.files.find(file => file.id === this.current.id);
        if (!meta) {
            if (!this.current.deleted) {
                this.current.deleted = true;
                this.showBanner('Este arquivo foi excluído (está na lixeira).', 'close-file', 'Fechar');
            }
            return;
        }
        if (this.current.deleted) {
            this.current.deleted = false;
            this.hideBanner();
        }
        if (meta.path !== this.current.path) {
            this.current.path = meta.path;
            this.updateEditorInfo();
        }
        if (meta.updated !== this.current.updated) {
            if (this.dirty) {
                this.showBanner('O Agent alterou este arquivo enquanto você editava.', 'reload-file', 'Recarregar (descarta suas alterações)');
            } else {
                await this.reloadCurrent();
                this.showBanner('Atualizado pelo Agent.', null, null, true);
            }
        }
    }

    showBanner(text, action, actionLabel, transient = false) {
        const banner = this.$('banner');
        banner.innerHTML = `<span>${escapeHtml(text)}</span>${action ? `<button type="button" class="menu_button" data-action="${action}">${escapeHtml(actionLabel)}</button>` : ''}`;
        banner.hidden = false;
        clearTimeout(this.bannerTimer);
        if (transient) this.bannerTimer = setTimeout(() => this.hideBanner(), 2500);
    }

    hideBanner() {
        if (!this.root) return;
        this.$('banner').hidden = true;
    }

    togglePreview() {
        this.preview = !this.preview;
        this.$('preview').hidden = !this.preview;
        this.$('textarea').hidden = this.preview;
        const icon = this.root.querySelector('[data-action="toggle-preview"] i');
        icon.className = `fa-solid ${this.preview ? 'fa-pen' : 'fa-eye'}`;
        if (this.preview) this.renderPreview();
    }

    renderPreview() {
        this.$('preview').innerHTML = renderMarkdown(this.$('textarea').value);
    }

    // ---------- backups ----------

    async renderBackups() {
        const select = this.$('backup-book');
        const previous = select.value;
        const names = await this.lore.bookNames({ refresh: false });
        select.innerHTML = `<option value="">Todos os lorebooks</option>${names.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')}`;
        if (names.includes(previous)) select.value = previous;
        select.onchange = () => this.renderBackups().catch(error => this.fail(error));

        const filter = select.value;
        const backups = (await this.lore.listBackups()).filter(item => !filter || item.book === filter);
        const list = this.$('backup-list');
        if (!backups.length) {
            list.innerHTML = '<div class="agst-muted agst-list-empty">Nenhum backup ainda.</div>';
            return;
        }
        list.innerHTML = backups.map(item => `
            <div class="agst-card">
                <div class="agst-card-main">
                    <div><b>${escapeHtml(item.book)}</b> <span class="agst-muted">· ${escapeHtml(formatDateTime(item.createdAt))}</span></div>
                    <div class="agst-muted">${escapeHtml(REASON_LABELS[item.reason] ?? item.reason)} · ${item.entries} entrada${item.entries === 1 ? '' : 's'}</div>
                </div>
                <div class="agst-card-actions">
                    <button type="button" class="menu_button" data-action="restore-backup" data-id="${escapeHtml(item.id)}" title="Restaurar"><i class="fa-solid fa-rotate-left"></i></button>
                    <button type="button" class="menu_button" data-action="export-backup" data-id="${escapeHtml(item.id)}" title="Exportar JSON"><i class="fa-solid fa-file-export"></i></button>
                    <button type="button" class="menu_button" data-action="delete-backup" data-id="${escapeHtml(item.id)}" title="Excluir backup"><i class="fa-solid fa-trash-can"></i></button>
                </div>
            </div>`).join('');
    }

    async backupNow() {
        const book = this.$('backup-book').value;
        if (!book) {
            toastr.info('Escolha um lorebook na lista para fazer o backup.');
            return;
        }
        await this.lore.backupNow(book);
        toastr.success(`Backup de "${book}" criado.`);
        await this.renderBackups();
    }

    async restoreBackup(id) {
        const item = (await this.lore.listBackups()).find(backup => backup.id === id);
        if (!item) return;
        const ok = await confirmDialog('Restaurar backup?', `"${item.book}" volta ao estado de ${formatDateTime(item.createdAt)}. O estado atual também é guardado como backup antes.`);
        if (!ok) return;
        await this.lore.restoreBackup(id);
        toastr.success(`"${item.book}" restaurado.`);
        await this.renderBackups();
    }

    async exportBackup(id) {
        const stored = await this.lore.getBackup(id);
        const stamp = String(stored.createdAt ?? '').replace(/[:.]/g, '-').slice(0, 19);
        downloadText(`${stored.book} - ${stamp}.json`, JSON.stringify(stored.data, null, 4));
    }

    async deleteBackup(id) {
        if (!(await confirmDialog('Excluir backup?', 'Este backup será apagado de vez.'))) return;
        await this.lore.deleteBackup(id);
        await this.renderBackups();
    }

    // ---------- atividade ----------

    async renderActivity() {
        const items = this.activity.list();
        const list = this.$('activity-list');
        if (!items.length) {
            list.innerHTML = '<div class="agst-muted agst-list-empty">Nenhuma atividade ainda. Ative o modo Agent e use um Profile com as ferramentas liberadas.</div>';
            return;
        }
        list.innerHTML = items.map(item => `
            <div class="agst-activity ${item.ok ? '' : 'is-error'}">
                <i class="fa-solid ${item.ok ? 'fa-check' : 'fa-xmark'}"></i>
                <div class="agst-activity-main">
                    <div><b>${escapeHtml(TOOL_LABELS[item.tool] ?? item.tool)}</b> <span class="agst-muted">· ${escapeHtml(formatDateTime(item.at))}</span></div>
                    <div class="${item.ok ? '' : 'agst-error-text'}">${escapeHtml(item.ok ? (item.summary ?? item.tool) : item.error)}</div>
                </div>
            </div>`).join('');
    }

    // ---------- lixeira ----------

    async renderTrash() {
        const items = await this.fs.listTrash();
        const list = this.$('trash-list');
        if (!items.length) {
            list.innerHTML = '<div class="agst-muted agst-list-empty">A lixeira está vazia.</div>';
            return;
        }
        list.innerHTML = items.map(item => `
            <div class="agst-card">
                <div class="agst-card-main">
                    <div><b>${escapeHtml(item.path)}</b></div>
                    <div class="agst-muted">excluído em ${escapeHtml(formatDateTime(item.deletedAt))} · ${item.size} caracteres</div>
                </div>
                <div class="agst-card-actions">
                    <button type="button" class="menu_button" data-action="restore-trash" data-id="${escapeHtml(item.id)}" title="Restaurar"><i class="fa-solid fa-rotate-left"></i></button>
                    <button type="button" class="menu_button" data-action="purge-trash" data-id="${escapeHtml(item.id)}" title="Excluir de vez"><i class="fa-solid fa-trash-can"></i></button>
                </div>
            </div>`).join('');
    }

    async restoreTrash(id) {
        const result = await this.fs.restoreFromTrash(id);
        toastr.success(`Restaurado em "${result.path}".`);
        await this.renderTrash();
    }

    async purgeTrash(id) {
        if (!(await confirmDialog('Excluir de vez?', 'Este arquivo não poderá ser recuperado.'))) return;
        await this.fs.purgeFromTrash(id);
        await this.renderTrash();
    }

    async emptyTrash() {
        const items = await this.fs.listTrash();
        if (!items.length) return;
        if (!(await confirmDialog('Esvaziar a lixeira?', `${items.length} arquivo(s) serão apagados de vez.`))) return;
        await this.fs.emptyTrash();
        await this.renderTrash();
    }
}
