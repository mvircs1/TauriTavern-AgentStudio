// Aba "Mapa" do Agent Studio: mundos, árvore de lugares (mundo › região › local), edição de um lugar,
// posição do jogador/NPCs e o diálogo de Auto-preencher / Refinar.

import { buildFillMessages, buildLoreContext, FILL_MODES, listConnectionProfiles, parseFillResponse, requestFill } from './map-fill.js';
import { LEVEL_LABELS } from './map.js';
import { confirmDialog, promptText } from './ui.js';
import { errorMessage, escapeHtml, foldText, LOG_PREFIX } from './util.js';

const LEVEL_ICONS = { world: 'fa-earth-americas', region: 'fa-city', local: 'fa-location-dot' };
const CHILD_LEVEL = { world: 'region', region: 'local', local: 'local' };

export class MapView {
    constructor({ map, lore, activity, container }) {
        this.map = map;
        this.lore = lore;
        this.activity = activity;
        this.container = container;
        this.data = null;
        this.selected = null; // id do lugar aberto, 'new' para um novo
        this.newParent = null;
        this.expanded = new Set();
        this.filter = '';
        this.fill = null; // estado do diálogo de preenchimento
        this.pendingRefresh = false;
    }

    mount() {
        this.container.innerHTML = '<div class="agst-map" data-role="map-body"></div>';
        this.body = this.container.querySelector('[data-role="map-body"]');
        this.container.addEventListener('click', event => this.onClick(event));
        this.container.addEventListener('change', event => this.onChange(event));
        this.container.addEventListener('focusout', () => {
            if (!this.pendingRefresh) return;
            setTimeout(() => {
                if (!this.isBusy()) this.refresh();
            }, 0);
        });
        this.container.addEventListener('input', event => {
            if (event.target.matches('[data-role="map-filter"]')) {
                this.filter = event.target.value;
                this.renderTree();
            }
        });
    }

    fail(error) {
        console.error(LOG_PREFIX, error);
        toastr.error(errorMessage(error), 'Agent Studio');
    }

    isBusy() {
        const element = document.activeElement;
        const typing = Boolean(element && this.container.contains(element) && /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName));
        return typing || Boolean(this.fill) || this.selected === 'new';
    }

    refresh() {
        if (this.isBusy()) {
            this.pendingRefresh = true;
            return;
        }
        this.render().catch(error => this.fail(error));
    }

    async render() {
        this.pendingRefresh = false;
        this.data = await this.map.snapshot();
        const { data } = this;
        if (!data.hasChat) {
            this.body.innerHTML = '<div class="agst-empty"><i class="fa-solid fa-map"></i><p>Abra um chat para ver o mapa.</p></div>';
            return;
        }
        if (this.fill) {
            await this.renderFill();
            return;
        }
        const worldOptions = data.worlds.map(world => `<option value="${escapeHtml(world.id)}"${world.id === data.worldId ? ' selected' : ''}>${escapeHtml(world.name)}</option>`).join('');
        const places = data.world ? Object.values(data.world.places) : [];
        const position = data.state.position && data.world?.places[data.state.position];
        const pathOf = id => {
            const names = [];
            let current = data.world?.places[id];
            while (current) {
                names.unshift(current.name);
                current = current.parent ? data.world.places[current.parent] : null;
            }
            return names.join(' › ');
        };
        this.pathOf = pathOf;
        const positionOptions = places
            .map(place => ({ id: place.id, path: pathOf(place.id) }))
            .sort((a, b) => a.path.localeCompare(b.path))
            .map(place => `<option value="${escapeHtml(place.id)}"${place.id === data.state.position ? ' selected' : ''}>${escapeHtml(place.path)}</option>`)
            .join('');

        this.body.innerHTML = `
            <div class="agst-list-toolbar agst-map-toolbar">
                <select class="text_pole agst-map-world" data-role="map-world" title="Mundo deste chat">
                    ${data.worlds.length ? '' : '<option value="">(nenhum mundo ainda)</option>'}${worldOptions}
                </select>
                <button type="button" class="agst-icon-button" data-map-action="new-world" title="Novo mundo"><i class="fa-solid fa-plus"></i></button>
                ${data.worldId ? `
                    <button type="button" class="agst-icon-button" data-map-action="rename-world" title="Renomear mundo"><i class="fa-solid fa-pen"></i></button>
                    <button type="button" class="agst-icon-button" data-map-action="delete-world" title="Excluir mundo"><i class="fa-solid fa-trash-can"></i></button>` : ''}
                <span class="agst-spacer"></span>
                <button type="button" class="menu_button menu_button_icon" data-map-action="open-fill" data-mode="fill"><i class="fa-solid fa-wand-magic-sparkles"></i><span>Auto-preencher</span></button>
                <button type="button" class="menu_button menu_button_icon" data-map-action="open-fill" data-mode="refine"${places.length ? '' : ' disabled'}><i class="fa-solid fa-feather"></i><span>Refinar</span></button>
            </div>
            <div class="agst-map-position">
                <i class="fa-solid fa-person-walking"></i>
                <span>${position ? `Você está em <b>${escapeHtml(pathOf(position.id))}</b>` : '<span class="agst-muted">Posição do jogador ainda não definida. A IA define ao narrar, ou escolha aqui:</span>'}</span>
                ${places.length ? `<select class="text_pole" data-role="map-position"><option value="">(nenhum lugar)</option>${positionOptions}</select>` : ''}
            </div>
            <div class="agst-files agst-map-split${this.selected ? ' agst-show-editor' : ''}">
                <aside class="agst-sidebar">
                    <div class="agst-toolbar">
                        <button type="button" class="agst-icon-button" data-map-action="new-place" data-parent="" title="Novo lugar no topo (nível mundo)"><i class="fa-solid fa-plus"></i></button>
                        <span class="agst-muted agst-map-count">${places.length} lugar${places.length === 1 ? '' : 'es'}</span>
                        <span class="agst-spacer"></span>
                        <button type="button" class="agst-icon-button" data-map-action="collapse" title="Recolher"><i class="fa-solid fa-angles-up"></i></button>
                    </div>
                    <input type="search" class="text_pole agst-filter" data-role="map-filter" placeholder="Filtrar lugares…" value="${escapeHtml(this.filter)}">
                    <div class="agst-tree" data-role="map-tree"></div>
                    ${data.backups.length ? `<div class="agst-footer"><button type="button" class="menu_button menu_button_icon" data-map-action="undo-fill"><i class="fa-solid fa-rotate-left"></i><span>Desfazer "${escapeHtml(data.backups[0].label)}"</span></button></div>` : ''}
                </aside>
                <div class="agst-editor" data-role="map-editor"></div>
            </div>`;
        this.renderTree();
        await this.renderEditor();
    }

    renderTree() {
        const tree = this.body.querySelector('[data-role="map-tree"]');
        if (!tree) return;
        const { world, state } = this.data;
        const places = world ? Object.values(world.places) : [];
        if (!places.length) {
            tree.innerHTML = `<div class="agst-tree-empty agst-muted">Mapa vazio.<br>A IA cria os lugares enquanto narra (modo Agent), ou use <b>Auto-preencher</b> para gerar a partir dos lorebooks.</div>`;
            return;
        }
        const known = new Set(state.known);
        const npcCount = id => Object.values(state.npcs).filter(where => where === id).length;
        const row = (place, depth, label) => `
            <div class="agst-row agst-map-row${this.selected === place.id ? ' is-selected' : ''}${known.has(place.id) ? '' : ' is-unknown'}" data-place="${escapeHtml(place.id)}" style="--depth:${depth}"${known.has(place.id) ? '' : ' title="O jogador ainda não conhece este lugar neste chat"'}>
                <span class="agst-caret">${places.some(p => p.parent === place.id) && !this.filter ? `<i class="fa-solid ${this.expanded.has(place.id) ? 'fa-chevron-down' : 'fa-chevron-right'}" data-map-action="toggle" data-place="${escapeHtml(place.id)}"></i>` : ''}</span>
                <i class="fa-solid ${LEVEL_ICONS[place.level]} agst-row-icon" title="${LEVEL_LABELS[place.level]}"></i>
                <span class="agst-row-name">${escapeHtml(label)}</span>
                ${place.type ? `<span class="agst-muted agst-map-type">${escapeHtml(place.type)}</span>` : ''}
                ${state.position === place.id ? '<i class="fa-solid fa-person-walking agst-map-here" title="Jogador aqui"></i>' : ''}
                ${npcCount(place.id) ? `<span class="agst-badge">${npcCount(place.id)} NPC</span>` : ''}
            </div>`;
        if (this.filter) {
            const wanted = foldText(this.filter);
            const matches = places.filter(place => foldText(`${place.name} ${place.type} ${place.summary}`).includes(wanted));
            tree.innerHTML = matches.map(place => row(place, 0, this.pathOf(place.id))).join('') || '<div class="agst-tree-empty agst-muted">Nada encontrado.</div>';
            return;
        }
        // Mostra o caminho até o jogador aberto.
        if (state.position && !this.touched) {
            let current = world.places[state.position];
            while (current?.parent) {
                this.expanded.add(current.parent);
                current = world.places[current.parent];
            }
        }
        const rows = [];
        const order = { world: 0, region: 1, local: 2 };
        const walk = (parentId, depth) => {
            const children = places.filter(place => (place.parent ?? null) === parentId)
                .sort((a, b) => (order[a.level] - order[b.level]) || a.name.localeCompare(b.name));
            for (const place of children) {
                rows.push(row(place, depth, place.name));
                if (this.expanded.has(place.id)) walk(place.id, depth + 1);
            }
        };
        walk(null, 0);
        tree.innerHTML = rows.join('');
    }

    async renderEditor() {
        const editor = this.body.querySelector('[data-role="map-editor"]');
        if (!editor) return;
        const { world, state, sheets } = this.data;
        if (!this.selected || (this.selected !== 'new' && !world?.places[this.selected])) {
            this.selected = null;
            editor.innerHTML = `
                <div class="agst-empty">
                    <i class="fa-solid fa-map-location-dot"></i>
                    <p>Escolha um lugar para ver ou editar.</p>
                    <p class="agst-muted">Só o local atual vai para o prompt (com saídas e quem está lá). As entradas de lorebook vinculadas a um lugar só são ativadas quando o jogador está nele.</p>
                </div>`;
            return;
        }
        const isNew = this.selected === 'new';
        const place = isNew ? { name: '', type: '', summary: '', details: '', secret: '', residents: [], lore: [], level: this.newParent ? CHILD_LEVEL[world.places[this.newParent]?.level] ?? 'local' : 'world', parent: this.newParent } : world.places[this.selected];
        const places = world ? Object.values(world.places) : [];
        const descendants = new Set();
        if (!isNew) {
            const stack = [place.id];
            while (stack.length) {
                const id = stack.pop();
                for (const child of places.filter(p => p.parent === id)) {
                    descendants.add(child.id);
                    stack.push(child.id);
                }
            }
        }
        const parentAllowed = candidate => {
            if (candidate.id === place.id || descendants.has(candidate.id)) return false;
            if (place.level === 'world') return false;
            if (place.level === 'region') return candidate.level === 'world';
            return candidate.level !== 'world';
        };
        const parentOptions = places.filter(parentAllowed)
            .map(candidate => `<option value="${escapeHtml(candidate.id)}"${candidate.id === place.parent ? ' selected' : ''}>${escapeHtml(this.pathOf(candidate.id))}</option>`).join('');
        const residentsText = place.residents.map(r => (r.description ? `${r.name} — ${r.description}` : r.name)).join('\n');

        let connectionsHtml = '';
        let loreHtml = '';
        let npcHtml = '';
        if (!isNew) {
            const connections = world.connections.filter(c => c.from === place.id || c.to === place.id);
            connectionsHtml = `
                <h5>Conexões</h5>
                <div class="agst-map-links">
                    ${connections.map(c => {
                        const otherId = c.from === place.id ? c.to : c.from;
                        const arrow = c.twoWay ? '↔' : (c.from === place.id ? '→' : '←');
                        const flags = [c.locked ? 'trancada' : null, c.hidden ? 'escondida' : null].filter(Boolean).join(', ');
                        return `<div class="agst-map-link"><span>${arrow} <b>${escapeHtml(world.places[otherId]?.name ?? '?')}</b>${c.description ? ` — ${escapeHtml(c.description)}` : ''}${flags ? ` <span class="agst-muted">(${flags})</span>` : ''}</span>
                            <button type="button" class="agst-icon-button" data-map-action="remove-connection" data-connection="${escapeHtml(c.id)}" title="Remover"><i class="fa-solid fa-xmark"></i></button></div>`;
                    }).join('') || '<div class="agst-muted">Nenhuma conexão.</div>'}
                </div>
                <div class="agst-map-add">
                    <select class="text_pole" data-role="connect-to"><option value="">Conectar a…</option>${places.filter(p => p.id !== place.id).map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(this.pathOf(p.id))}</option>`).join('')}</select>
                    <input type="text" class="text_pole" data-role="connect-description" placeholder="Como: porta, estrada (2 dias)…">
                    <label class="checkbox_label"><input type="checkbox" data-role="connect-twoway" checked> <span>ida e volta</span></label>
                    <label class="checkbox_label"><input type="checkbox" data-role="connect-locked"> <span>trancada</span></label>
                    <label class="checkbox_label"><input type="checkbox" data-role="connect-hidden"> <span>escondida</span></label>
                    <button type="button" class="menu_button" data-map-action="add-connection">Conectar</button>
                </div>`;
            const books = await this.lore.bookNames().catch(() => []);
            loreHtml = `
                <h5>Entradas de lorebook deste lugar</h5>
                <div class="agst-muted agst-sys-hint">Ativadas só quando o jogador está aqui (ou num lugar dentro deste). Deixe-as sem palavra-chave no lorebook para não aparecerem em outros lugares.</div>
                <div class="agst-map-links">
                    ${place.lore.map((link, index) => `<div class="agst-map-link"><span><i class="fa-solid fa-book"></i> ${escapeHtml(link.book)} · #${link.uid} ${escapeHtml(link.title ?? '')}</span>
                        <button type="button" class="agst-icon-button" data-map-action="unlink-lore" data-index="${index}" title="Desvincular"><i class="fa-solid fa-xmark"></i></button></div>`).join('') || '<div class="agst-muted">Nenhuma.</div>'}
                </div>
                <div class="agst-map-add">
                    <select class="text_pole" data-role="map-link-book"><option value="">Lorebook…</option>${books.map(book => `<option value="${escapeHtml(book)}">${escapeHtml(book)}</option>`).join('')}</select>
                    <select class="text_pole" data-role="map-link-entry" disabled><option value="">Entrada…</option></select>
                    <button type="button" class="menu_button" data-map-action="link-lore">Vincular</button>
                </div>`;
            const here = sheets.filter(sheet => state.npcs[sheet.id] === place.id);
            const elsewhere = sheets.filter(sheet => state.npcs[sheet.id] !== place.id);
            npcHtml = `
                <h5>NPCs com ficha aqui <span class="agst-muted">(neste chat)</span></h5>
                <div class="agst-map-links">
                    ${here.map(sheet => `<div class="agst-map-link"><span><i class="fa-solid fa-user"></i> ${escapeHtml(sheet.name)}</span>
                        <button type="button" class="agst-icon-button" data-map-action="npc-away" data-sheet="${escapeHtml(sheet.id)}" title="Tirar daqui"><i class="fa-solid fa-xmark"></i></button></div>`).join('') || '<div class="agst-muted">Nenhum.</div>'}
                </div>
                ${elsewhere.length ? `<div class="agst-map-add">
                    <select class="text_pole" data-role="npc-here"><option value="">Trazer NPC para cá…</option>${elsewhere.map(sheet => `<option value="${escapeHtml(sheet.id)}">${escapeHtml(sheet.name)}</option>`).join('')}</select>
                </div>` : ''}`;
        }

        editor.innerHTML = `
            <div class="agst-sys-scroll agst-map-editor">
                <div class="agst-editor-bar">
                    <button type="button" class="agst-icon-button agst-back" data-map-action="close-place" title="Voltar"><i class="fa-solid fa-arrow-left"></i></button>
                    <i class="fa-solid ${LEVEL_ICONS[place.level]}"></i>
                    <span class="agst-path">${isNew ? `Novo lugar (${LEVEL_LABELS[place.level]})` : escapeHtml(this.pathOf(place.id))}</span>
                    <span class="agst-spacer"></span>
                    ${isNew ? '' : `<button type="button" class="agst-icon-button" data-map-action="new-place" data-parent="${escapeHtml(place.id)}" title="Novo lugar dentro deste"><i class="fa-solid fa-folder-plus"></i></button>
                    <button type="button" class="agst-icon-button" data-map-action="delete-place" title="Excluir lugar"><i class="fa-solid fa-trash-can"></i></button>`}
                </div>
                <div class="agst-sys-form agst-place-form">
                    <div class="agst-ability-grid">
                        <label>Nome<input type="text" class="text_pole" data-place-field="name" maxlength="80" value="${escapeHtml(place.name)}"></label>
                        <label>Tipo<input type="text" class="text_pole" data-place-field="type" maxlength="40" placeholder="taverna, cidade, floresta…" value="${escapeHtml(place.type)}"></label>
                        ${isNew ? `<label>Nível
                            <select class="text_pole" data-place-field="level">
                                ${['world', 'region', 'local'].map(level => `<option value="${level}"${level === place.level ? ' selected' : ''}>${LEVEL_LABELS[level]}</option>`).join('')}
                            </select></label>` : ''}
                        <label>Dentro de
                            <select class="text_pole" data-place-field="parent"><option value="">(nenhum)</option>${parentOptions}</select>
                        </label>
                    </div>
                    <label>Resumo <span class="agst-muted">(vai para o prompt quando o jogador está aqui)</span>
                        <textarea class="text_pole" data-place-field="summary" rows="2" maxlength="600">${escapeHtml(place.summary)}</textarea></label>
                    <label>Detalhes <span class="agst-muted">(a IA consulta quando precisa)</span>
                        <textarea class="text_pole" data-place-field="details" rows="4">${escapeHtml(place.details)}</textarea></label>
                    <label>Segredo <span class="agst-muted">(só o narrador sabe)</span>
                        <textarea class="text_pole" data-place-field="secret" rows="2">${escapeHtml(place.secret)}</textarea></label>
                    <label>Moradores sem ficha <span class="agst-muted">(um por linha: Nome — papel)</span>
                        <textarea class="text_pole" data-place-field="residents" rows="3" placeholder="Mira — taverneira">${escapeHtml(residentsText)}</textarea></label>
                    <div class="agst-sys-form-actions">
                        <button type="button" class="menu_button menu_button_icon" data-map-action="save-place"><i class="fa-solid fa-check"></i><span>Salvar</span></button>
                        ${isNew ? '<button type="button" class="menu_button" data-map-action="close-place">Cancelar</button>' : `
                        <button type="button" class="menu_button menu_button_icon" data-map-action="move-here"${state.position === place.id ? ' disabled' : ''}><i class="fa-solid fa-person-walking"></i><span>${state.position === place.id ? 'Jogador está aqui' : 'Mover jogador para cá'}</span></button>`}
                    </div>
                </div>
                ${connectionsHtml}
                ${npcHtml}
                ${loreHtml}
            </div>`;
    }

    // ---------- auto-preencher / refinar ----------

    async openFill(mode) {
        const active = await this.lore.activeBookNames().catch(() => new Set());
        const books = await this.lore.bookNames().catch(() => []);
        this.fill = {
            mode,
            books: books.map(name => ({ name, checked: active.has(name) })),
            profiles: listConnectionProfiles(),
            profileId: this.lastProfileId ?? '',
            maxTokens: this.lastMaxTokens ?? 4096,
            extra: '',
            status: 'form',
            plan: null,
            preview: null,
            error: null,
        };
        await this.render();
    }

    async renderFill() {
        const fill = this.fill;
        const mode = FILL_MODES[fill.mode];
        if (fill.status === 'loading') {
            this.body.innerHTML = `
                <div class="agst-fill agst-sys-scroll">
                    <h4><i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(mode.label)}: gerando…</h4>
                    <p class="agst-muted">A IA está montando o mapa a partir dos lorebooks. Isso pode levar um tempo com modelos maiores.</p>
                    <button type="button" class="menu_button" data-map-action="cancel-fill">Cancelar</button>
                </div>`;
            return;
        }
        if (fill.status === 'preview') {
            const { created, updated, connections, problems } = fill.preview;
            this.body.innerHTML = `
                <div class="agst-fill agst-sys-scroll">
                    <h4>${escapeHtml(mode.label)}: prévia</h4>
                    <p>${created.length || updated.length || connections.length ? `${created.length} lugar(es) novo(s), ${updated.length} atualizado(s), ${connections.length} conexão(ões).` : 'A IA não propôs nenhuma mudança. Volte e ajuste o prompt auxiliar, ou escolha outros lorebooks.'}</p>
                    ${created.length ? `<h5>Novos</h5><ul class="agst-fill-list">${created.map(p => `<li><i class="fa-solid ${LEVEL_ICONS[p.level]}"></i> <b>${escapeHtml(p.name)}</b>${p.parent ? ` <span class="agst-muted">em ${escapeHtml(p.parent)}</span>` : ''}</li>`).join('')}</ul>` : ''}
                    ${updated.length ? `<h5>Atualizados</h5><ul class="agst-fill-list">${updated.map(p => `<li><b>${escapeHtml(p.name)}</b> <span class="agst-muted">(${escapeHtml(p.fields.join(', '))})</span></li>`).join('')}</ul>` : ''}
                    ${connections.length ? `<h5>Conexões</h5><ul class="agst-fill-list">${connections.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>` : ''}
                    ${problems.length ? `<h5>Avisos</h5><ul class="agst-fill-list agst-muted">${problems.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>` : ''}
                    <div class="agst-sys-form-actions">
                        <button type="button" class="menu_button menu_button_icon" data-map-action="apply-fill"${created.length || updated.length || connections.length ? '' : ' disabled'}><i class="fa-solid fa-check"></i><span>Aplicar</span></button>
                        <button type="button" class="menu_button" data-map-action="back-fill">Voltar e ajustar</button>
                        <button type="button" class="menu_button" data-map-action="cancel-fill">Descartar</button>
                    </div>
                </div>`;
            return;
        }
        this.body.innerHTML = `
            <div class="agst-fill agst-sys-scroll">
                <h4><i class="fa-solid ${fill.mode === 'refine' ? 'fa-feather' : 'fa-wand-magic-sparkles'}"></i> ${escapeHtml(mode.label)}</h4>
                <p class="agst-muted">${fill.mode === 'refine'
                    ? 'A IA lê os lorebooks e o mapa atual e melhora o que existe (resumos, detalhes, segredos, moradores, conexões), além de completar onde está vazio.'
                    : 'A IA lê os lorebooks (sem a cena do chat) e cria os lugares que faltam no mapa, com conexões.'} Você vê uma prévia antes de aplicar.</p>
                ${fill.error ? `<div class="agst-banner">${escapeHtml(fill.error)}</div>` : ''}
                <h5>Lorebooks de contexto</h5>
                <div class="agst-fill-books">
                    ${fill.books.map((book, index) => `<label class="checkbox_label"><input type="checkbox" data-fill-book="${index}"${book.checked ? ' checked' : ''}> <span>${escapeHtml(book.name)}</span></label>`).join('') || '<span class="agst-muted">Nenhum lorebook. A IA vai inventar a partir do prompt auxiliar.</span>'}
                </div>
                <div class="agst-ability-grid">
                    <label>Modelo / conexão
                        <select class="text_pole" data-fill="profileId">
                            <option value="">Conexão atual (a do narrador)</option>
                            ${fill.profiles.map(p => `<option value="${escapeHtml(p.id)}"${p.id === fill.profileId ? ' selected' : ''}>${escapeHtml(p.name)}${p.model ? ` · ${escapeHtml(p.model)}` : ''}</option>`).join('')}
                        </select>
                    </label>
                    <label>Máximo de tokens da resposta
                        <input type="number" class="text_pole" data-fill="maxTokens" min="512" max="64000" value="${fill.maxTokens}">
                    </label>
                </div>
                ${fill.profiles.length ? '' : '<div class="agst-muted agst-sys-hint">Para usar outro modelo, crie um Perfil de Conexão (Chat Completion) no SillyTavern/TauriTavern: ele aparece aqui.</div>'}
                <label>Prompt auxiliar <span class="agst-muted">(opcional)</span>
                    <textarea class="text_pole" data-fill="extra" rows="4" placeholder="Ex.: foque na cidade de Solenne e nos bairros; crie 3 tavernas e um mercado negro escondido.">${escapeHtml(fill.extra)}</textarea>
                </label>
                <div class="agst-sys-form-actions">
                    <button type="button" class="menu_button menu_button_icon" data-map-action="run-fill"><i class="fa-solid fa-play"></i><span>Gerar</span></button>
                    <button type="button" class="menu_button" data-map-action="cancel-fill">Cancelar</button>
                </div>
            </div>`;
    }

    readFillForm() {
        const fill = this.fill;
        for (const input of this.body.querySelectorAll('[data-fill-book]')) {
            fill.books[Number(input.dataset.fillBook)].checked = input.checked;
        }
        const value = key => this.body.querySelector(`[data-fill="${key}"]`)?.value;
        fill.profileId = value('profileId') ?? '';
        fill.maxTokens = Math.max(512, Math.min(64000, Number(value('maxTokens')) || 4096));
        fill.extra = value('extra') ?? '';
        this.lastProfileId = fill.profileId;
        this.lastMaxTokens = fill.maxTokens;
    }

    async runFill() {
        this.readFillForm();
        const fill = this.fill;
        const books = fill.books.filter(book => book.checked).map(book => book.name);
        fill.status = 'loading';
        fill.error = null;
        const controller = new AbortController();
        fill.controller = controller;
        await this.renderFill();
        try {
            const lore = await buildLoreContext(books);
            const outline = await this.map.outline();
            const messages = buildFillMessages({ mode: fill.mode, lore: lore.text, outline: outline.text, worldName: outline.worldName, extraPrompt: fill.extra.trim() });
            const response = await requestFill(messages, { profileId: fill.profileId, maxTokens: fill.maxTokens, signal: controller.signal });
            if (this.fill !== fill || controller.signal.aborted) return;
            fill.plan = parseFillResponse(response);
            fill.preview = await this.map.previewPlan(fill.plan, fill.mode);
            fill.status = 'preview';
            if (lore.truncated) fill.preview.problems.unshift('O contexto dos lorebooks foi cortado (muito longo): escolha menos lorebooks se faltar algo.');
        } catch (error) {
            if (this.fill !== fill) return;
            console.error(LOG_PREFIX, error);
            fill.status = 'form';
            const cause = error?.cause ? ` (${errorMessage(error.cause)})` : '';
            fill.error = `Não deu certo: ${errorMessage(error)}${cause}`;
        }
        if (this.fill === fill) await this.renderFill();
    }

    // ---------- eventos ----------

    async onClick(event) {
        const row = event.target.closest('.agst-map-row');
        const actionEl = event.target.closest('[data-map-action]');
        try {
            if (actionEl?.dataset.mapAction === 'toggle') {
                const id = actionEl.dataset.place;
                this.touched = true;
                if (this.expanded.has(id)) this.expanded.delete(id);
                else this.expanded.add(id);
                this.renderTree();
                return;
            }
            if (row && !actionEl) {
                this.selected = row.dataset.place;
                this.expanded.add(row.dataset.place);
                await this.render();
                return;
            }
            if (!actionEl || actionEl.disabled) return;
            const action = actionEl.dataset.mapAction;
            switch (action) {
                case 'new-world': {
                    const name = await promptText('Novo mundo', this.data.characterName ? `Mundo de ${this.data.characterName}` : 'Novo mundo');
                    if (!name?.trim()) return;
                    await this.map.createWorld(name);
                    this.selected = null;
                    await this.render();
                    break;
                }
                case 'rename-world': {
                    const current = this.data.worlds.find(w => w.id === this.data.worldId);
                    const name = await promptText('Renomear mundo', current?.name ?? '');
                    if (!name?.trim()) return;
                    await this.map.renameWorld(this.data.worldId, name);
                    await this.render();
                    break;
                }
                case 'delete-world': {
                    const current = this.data.worlds.find(w => w.id === this.data.worldId);
                    if (!(await confirmDialog(`Excluir o mundo "${current?.name}"?`, 'Todos os lugares e conexões dele serão apagados, em todos os chats que o usam.'))) return;
                    await this.map.deleteWorld(this.data.worldId);
                    this.selected = null;
                    await this.render();
                    break;
                }
                case 'collapse':
                    this.expanded.clear();
                    this.touched = true;
                    this.renderTree();
                    break;
                case 'new-place':
                    this.selected = 'new';
                    this.newParent = actionEl.dataset.parent || null;
                    await this.render();
                    this.body.querySelector('[data-place-field="name"]')?.focus();
                    break;
                case 'close-place':
                    this.selected = null;
                    await this.render();
                    break;
                case 'save-place':
                    await this.savePlace();
                    break;
                case 'delete-place': {
                    const place = this.data.world.places[this.selected];
                    if (!(await confirmDialog(`Excluir "${place.name}"?`, 'Os lugares dentro dele e as conexões também serão apagados.'))) return;
                    await this.map.removePlaceUi(this.selected);
                    this.selected = null;
                    await this.render();
                    break;
                }
                case 'move-here':
                    await this.map.setPosition({ placeId: this.selected });
                    await this.render();
                    break;
                case 'add-connection': {
                    const to = this.body.querySelector('[data-role="connect-to"]').value;
                    if (!to) {
                        toastr.info('Escolha o lugar a conectar.');
                        return;
                    }
                    await this.map.saveConnection({
                        from: this.selected,
                        to,
                        description: this.body.querySelector('[data-role="connect-description"]').value,
                        twoWay: this.body.querySelector('[data-role="connect-twoway"]').checked,
                        locked: this.body.querySelector('[data-role="connect-locked"]').checked,
                        hidden: this.body.querySelector('[data-role="connect-hidden"]').checked,
                    });
                    await this.render();
                    break;
                }
                case 'remove-connection':
                    await this.map.removeConnection(actionEl.dataset.connection);
                    await this.render();
                    break;
                case 'link-lore': {
                    const book = this.body.querySelector('[data-role="map-link-book"]').value;
                    const uid = this.body.querySelector('[data-role="map-link-entry"]').value;
                    if (!book || uid === '') {
                        toastr.info('Escolha o lorebook e a entrada.');
                        return;
                    }
                    const entry = await this.lore.describeEntry(book, Number(uid));
                    const place = this.data.world.places[this.selected];
                    if (!place.lore.some(l => l.book === entry.book && l.uid === entry.uid)) {
                        await this.map.savePlace({ ...this.placeInput(place), lore: [...place.lore, entry] });
                    }
                    await this.render();
                    break;
                }
                case 'unlink-lore': {
                    const place = this.data.world.places[this.selected];
                    const lore = place.lore.filter((_, index) => index !== Number(actionEl.dataset.index));
                    await this.map.savePlace({ ...this.placeInput(place), lore });
                    await this.render();
                    break;
                }
                case 'npc-away':
                    await this.map.setPosition({ placeId: null, sheetId: actionEl.dataset.sheet });
                    await this.render();
                    break;
                case 'undo-fill': {
                    if (!(await confirmDialog('Desfazer o último preenchimento?', 'O mapa volta ao que era antes dele.'))) return;
                    const label = await this.map.undoLastFill();
                    toastr.success(`"${label}" desfeito.`);
                    this.selected = null;
                    await this.render();
                    break;
                }
                case 'open-fill':
                    await this.openFill(actionEl.dataset.mode);
                    break;
                case 'run-fill':
                    await this.runFill();
                    break;
                case 'back-fill':
                    this.fill.status = 'form';
                    await this.renderFill();
                    break;
                case 'cancel-fill':
                    this.fill?.controller?.abort();
                    this.fill = null;
                    await this.render();
                    break;
                case 'apply-fill': {
                    const fill = this.fill;
                    const result = await this.map.applyPlan(fill.plan, fill.mode, FILL_MODES[fill.mode].label);
                    this.activity.add({ tool: 'ui_map_fill', ok: true, summary: `${FILL_MODES[fill.mode].label}: ${result.created} lugar(es) novo(s), ${result.updated} atualizado(s), ${result.connections} conexão(ões)` });
                    toastr.success(`${result.created} novo(s), ${result.updated} atualizado(s), ${result.connections} conexão(ões).`, FILL_MODES[fill.mode].label);
                    this.fill = null;
                    await this.render();
                    break;
                }
                default:
                    break;
            }
        } catch (error) {
            this.fail(error);
        }
    }

    placeInput(place) {
        return {
            id: place.id,
            name: place.name,
            type: place.type,
            summary: place.summary,
            details: place.details,
            secret: place.secret,
            parent: place.parent,
            level: place.level,
            residents: place.residents,
            lore: place.lore,
        };
    }

    async savePlace() {
        const value = field => this.body.querySelector(`[data-place-field="${field}"]`)?.value;
        const isNew = this.selected === 'new';
        const existing = isNew ? null : this.data.world.places[this.selected];
        const id = await this.map.savePlace({
            id: existing?.id,
            name: value('name'),
            type: value('type'),
            level: isNew ? value('level') : existing.level,
            parent: value('parent') || null,
            summary: value('summary'),
            details: value('details'),
            secret: value('secret'),
            residents: value('residents'),
            lore: existing?.lore ?? [],
        });
        this.selected = id;
        if (value('parent')) this.expanded.add(value('parent'));
        toastr.success('Lugar salvo.', '', { timeOut: 1500 });
        await this.render();
    }

    async onChange(event) {
        const target = event.target;
        try {
            if (target.matches('[data-role="map-world"]') && target.value) {
                await this.map.selectWorld(target.value);
                this.selected = null;
                await this.render();
            } else if (target.matches('[data-role="map-position"]')) {
                await this.map.setPosition({ placeId: target.value || null });
                await this.render();
            } else if (target.matches('[data-role="npc-here"]') && target.value) {
                await this.map.setPosition({ placeId: this.selected, sheetId: target.value });
                await this.render();
            } else if (target.matches('[data-role="map-link-book"]')) {
                const select = this.body.querySelector('[data-role="map-link-entry"]');
                if (!target.value) {
                    select.innerHTML = '<option value="">Entrada…</option>';
                    select.disabled = true;
                    return;
                }
                const result = await this.lore.read({ book: target.value, limit: 300 });
                select.innerHTML = result.entries.map(entry => `<option value="${entry.uid}">#${entry.uid} ${escapeHtml(entry.title || entry.keys.join(', ') || '(sem título)')}</option>`).join('') || '<option value="">(vazio)</option>';
                select.disabled = !result.entries.length;
            }
        } catch (error) {
            this.fail(error);
        }
    }
}
