// Aba "Sistema" do Agent Studio: fichas (jogador e NPCs) e regras (atributos, perícias, recursos).

import { abbreviation, formatModifier, KINDS } from './system.js';
import { confirmDialog, promptText } from './ui.js';
import { errorMessage, escapeHtml, LOG_PREFIX } from './util.js';

const KIND_LABELS = {
    attributes: { title: 'Atributos', single: 'atributo' },
    skills: { title: 'Perícias', single: 'perícia' },
    resources: { title: 'Recursos', single: 'recurso' },
    stats: { title: 'Estatísticas', single: 'estatística' },
    abilityFields: { title: 'Campos de habilidade', single: 'campo de habilidade' },
};
const KIND_HINTS = {
    stats: 'Valores derivados: base + modificador do atributo + bônus da ficha. A marcada como Defesa é a CD dos ataques contra o personagem.',
    abilityFields: 'Campos extras que toda habilidade tem, além de custo, teste e efeito (ex.: Alcance, Duração, Recarga).',
};
const LOCATION_LABELS = { player: 'Jogador', chat: 'NPC deste chat', lorebook: 'NPC de lorebook' };
const RESOURCE_COLORS = ['#d9534f', '#4a90d9', '#e0a35d', '#6fbf73', '#a77bd9'];
const FOCUS_KEYS = ['sheetField', 'id', 'res', 'form', 'role'];

export class SystemView {
    constructor({ system, lore, activity, container }) {
        this.system = system;
        this.lore = lore;
        this.activity = activity;
        this.container = container;
        this.sub = 'sheets';
        this.selectedId = null;
        /** { kind, id } do item de regra em edição; id 'new' para um item novo. */
        this.editing = null;
        /** id da habilidade em edição na ficha aberta ('new' para uma nova). */
        this.editingAbility = null;
        this.data = null;
        this.pendingRefresh = false;
    }

    mount() {
        this.container.innerHTML = `
            <div class="agst-subtabs">
                <button type="button" class="agst-subtab" data-sys-tab="sheets"><i class="fa-solid fa-id-card"></i><span>Fichas</span></button>
                <button type="button" class="agst-subtab" data-sys-tab="rules"><i class="fa-solid fa-scroll"></i><span>Regras</span></button>
            </div>
            <div class="agst-sys-body" data-role="sys-body"></div>`;
        this.body = this.container.querySelector('[data-role="sys-body"]');
        this.container.addEventListener('click', event => this.onClick(event));
        this.container.addEventListener('change', event => this.onChange(event));
        this.container.addEventListener('focusout', () => {
            if (!this.pendingRefresh) return;
            setTimeout(() => {
                if (!this.isTyping()) this.refresh();
            }, 0);
        });
    }

    fail(error) {
        console.error(LOG_PREFIX, error);
        toastr.error(errorMessage(error), 'Agent Studio');
    }

    isTyping() {
        const element = document.activeElement;
        return Boolean(element && this.container.contains(element) && /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName));
    }

    /** Atualização vinda de fora (ex.: a IA mudou a Vida). Não atrapalha quem está digitando. */
    refresh() {
        if (this.isTyping() || this.editing || this.editingAbility) {
            this.pendingRefresh = true;
            return;
        }
        this.pendingRefresh = false;
        this.render().catch(error => this.fail(error));
    }

    async render() {
        for (const button of this.container.querySelectorAll('.agst-subtab')) {
            button.classList.toggle('is-active', button.dataset.sysTab === this.sub);
        }
        const focus = this.captureFocus();
        this.data = await this.system.snapshot();
        if (this.sub === 'rules') this.renderRules();
        else await this.renderSheets();
        this.restoreFocus(focus);
    }

    captureFocus() {
        const element = document.activeElement;
        if (!element || !this.container.contains(element)) return null;
        const keys = FOCUS_KEYS.filter(key => element.dataset[key] !== undefined);
        if (!keys.length) return null;
        return { tag: element.tagName, keys: keys.map(key => [key, element.dataset[key]]) };
    }

    restoreFocus(focus) {
        if (!focus) return;
        const selector = focus.keys
            .map(([key, value]) => `[data-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}="${CSS.escape(value)}"]`)
            .join('');
        const element = this.body.querySelector(`${focus.tag.toLowerCase()}${selector}`);
        element?.focus();
    }

    // ---------- regras ----------

    renderRules() {
        const definition = this.data.definition;
        const attributeName = id => definition.attributes.find(attribute => attribute.id === id)?.name ?? null;

        const itemHtml = (kind, item) => {
            let badge = '';
            if (kind === KINDS.skills) badge = `<span class="agst-badge">${escapeHtml(attributeName(item.attribute) ?? 'sem atributo')}</span>`;
            if (kind === KINDS.resources) badge = `<span class="agst-badge">máx. padrão ${item.defaultMax}</span>`;
            if (kind === KINDS.stats) {
                const formula = [String(item.base), attributeName(item.attribute)].filter(Boolean).join(' + ');
                badge = `<span class="agst-badge">${escapeHtml(formula)} + bônus</span>${item.defense ? ' <span class="agst-badge agst-badge-accent">Defesa</span>' : ''}`;
            }
            return `
                <div class="agst-sys-item">
                    <div class="agst-sys-item-main">
                        <div><b>${escapeHtml(item.name)}</b> ${badge}</div>
                        ${item.description ? `<div class="agst-muted">${escapeHtml(item.description)}</div>` : ''}
                    </div>
                    <div class="agst-card-actions">
                        <button type="button" class="agst-icon-button" data-sys-action="edit-item" data-kind="${kind}" data-item="${escapeHtml(item.id)}" title="Editar"><i class="fa-solid fa-pen"></i></button>
                        <button type="button" class="agst-icon-button" data-sys-action="delete-item" data-kind="${kind}" data-item="${escapeHtml(item.id)}" title="Excluir"><i class="fa-solid fa-trash-can"></i></button>
                    </div>
                </div>`;
        };

        const formHtml = (kind, item) => {
            const withAttribute = kind === KINDS.skills || kind === KINDS.stats;
            const attributeSelect = withAttribute
                ? `<label class="agst-sys-inline">${kind === KINDS.stats ? '+ modificador de' : 'Atributo'}
                    <select class="text_pole" data-form="attribute">
                        <option value="">(nenhum)</option>
                        ${definition.attributes.map((attribute, index) => {
                            const selected = item ? item.attribute === attribute.id : (kind === KINDS.skills && index === 0);
                            return `<option value="${escapeHtml(attribute.id)}"${selected ? ' selected' : ''}>${escapeHtml(attribute.name)}</option>`;
                        }).join('')}
                    </select></label>`
                : '';
            const maxInput = kind === KINDS.resources
                ? `<label class="agst-sys-inline">Máximo padrão <input type="number" class="text_pole agst-number" data-form="defaultMax" min="0" value="${item?.defaultMax ?? 10}"></label>`
                : '';
            const statInputs = kind === KINDS.stats
                ? `<label class="agst-sys-inline">Valor base <input type="number" class="text_pole agst-number" data-form="base" value="${item?.base ?? 0}"></label>
                   <label class="checkbox_label"><input type="checkbox" data-form="defense"${item?.defense ? ' checked' : ''}> <span>É a Defesa (CD dos ataques contra o personagem)</span></label>`
                : '';
            return `
                <div class="agst-sys-form" data-kind="${kind}" data-item="${escapeHtml(item?.id ?? 'new')}">
                    <input type="text" class="text_pole" data-form="name" maxlength="60" placeholder="Nome" value="${escapeHtml(item?.name ?? '')}">
                    ${kind === KINDS.stats ? statInputs : ''}${attributeSelect}${maxInput}
                    <textarea class="text_pole" data-form="description" rows="3" placeholder="Descrição: a IA lê isto para saber quando usar">${escapeHtml(item?.description ?? '')}</textarea>
                    <div class="agst-sys-form-actions">
                        <button type="button" class="menu_button menu_button_icon" data-sys-action="save-item"><i class="fa-solid fa-check"></i><span>Salvar</span></button>
                        <button type="button" class="menu_button" data-sys-action="cancel-edit">Cancelar</button>
                    </div>
                </div>`;
        };

        const section = kind => {
            const { title, single } = KIND_LABELS[kind];
            const items = definition[kind];
            const isEditing = id => this.editing?.kind === kind && this.editing.id === id;
            const rows = items.map(item => (isEditing(item.id) ? formHtml(kind, item) : itemHtml(kind, item))).join('');
            return `
                <div class="agst-sys-section">
                    <div class="agst-sys-section-head">
                        <h4>${title}</h4>
                        <span class="agst-muted">${items.length}</span>
                        <span class="agst-spacer"></span>
                        <button type="button" class="agst-icon-button" data-sys-action="new-item" data-kind="${kind}" title="Novo ${single}"><i class="fa-solid fa-plus"></i></button>
                    </div>
                    ${KIND_HINTS[kind] ? `<div class="agst-muted agst-sys-hint">${KIND_HINTS[kind]}</div>` : ''}
                    ${isEditing('new') ? formHtml(kind, null) : ''}
                    <div class="agst-sys-items">${rows || '<div class="agst-muted agst-list-empty">Nenhum ainda.</div>'}</div>
                </div>`;
        };

        this.body.innerHTML = `
            <div class="agst-sys-scroll">
                ${section(KINDS.attributes)}
                ${section(KINDS.skills)}
                ${section(KINDS.resources)}
                ${section(KINDS.stats)}
                ${section(KINDS.abilityFields)}
                <div class="agst-sys-note agst-muted">
                    <b>Como funciona:</b> modificador = (valor − 10) ÷ 2, arredondado para baixo
                    (8–9 = −1, 10–11 = +0, 12–13 = +1, 14–15 = +2…). Perícia = modificador do atributo + bônus da perícia.
                    Estatística = base + modificador do atributo + bônus da ficha (ex.: Defesa = 10 + Destreza + armadura).
                    Teste = d20 + perícia, atributo ou estatística contra a dificuldade (CD 10 fácil, 15 médio, 20 difícil),
                    ou contra a Defesa do alvo, num ataque. Sem nível nem XP.
                </div>
                <div class="agst-sys-form-actions">
                    <button type="button" class="menu_button menu_button_icon" data-sys-action="reset-rules"><i class="fa-solid fa-rotate-left"></i><span>Restaurar o padrão</span></button>
                </div>
            </div>`;
        this.body.querySelector('.agst-sys-form [data-form="name"]')?.focus();
    }

    async saveItem(form) {
        const kind = form.dataset.kind;
        const id = form.dataset.item;
        const value = field => form.querySelector(`[data-form="${field}"]`)?.value;
        await this.system.saveItem(kind, {
            id: id === 'new' ? undefined : id,
            name: value('name'),
            description: value('description'),
            attribute: value('attribute') || null,
            defaultMax: value('defaultMax'),
            base: value('base'),
            defense: form.querySelector('[data-form="defense"]')?.checked === true,
        });
        this.editing = null;
        await this.render();
    }

    // ---------- fichas ----------

    async renderSheets() {
        const { scope, sheets, definition } = this.data;
        if (!sheets.length) {
            this.body.innerHTML = `
                <div class="agst-empty">
                    <i class="fa-solid fa-dice-d20"></i>
                    <p>Abra um chat com um personagem para ver as fichas.</p>
                    <p class="agst-muted">A ficha do jogador é uma por personagem; as de NPC ficam no chat (ou num lorebook, se vinculadas).</p>
                </div>`;
            return;
        }
        const selected = sheets.find(sheet => sheet.id === this.selectedId) ?? sheets[0];
        this.selectedId = selected.id;

        const groups = [['player', 'Jogador'], ['chat', 'NPCs deste chat'], ['lorebook', 'NPCs de lorebooks']];
        const options = groups.map(([location, label]) => {
            const items = sheets.filter(sheet => sheet.location === location);
            if (!items.length) return '';
            return `<optgroup label="${label}">${items.map(sheet => `<option value="${escapeHtml(sheet.id)}"${sheet.id === selected.id ? ' selected' : ''}>${escapeHtml(sheet.name)}</option>`).join('')}</optgroup>`;
        }).join('');

        const describe = (kind, id) => definition[kind].find(item => item.id === id)?.description ?? '';

        const resources = selected.resources.map((resource, index) => {
            const percent = resource.max > 0 ? Math.round((resource.current / resource.max) * 100) : 0;
            return `
                <div class="agst-res" style="--agst-res-color:${RESOURCE_COLORS[index % RESOURCE_COLORS.length]}" title="${escapeHtml(describe(KINDS.resources, resource.id))}">
                    <div class="agst-res-top">
                        <span class="agst-res-name">${escapeHtml(resource.name)}</span>
                        <div class="agst-res-controls">
                            <button type="button" class="agst-icon-button" data-sys-action="res-delta" data-res="${escapeHtml(resource.id)}" data-delta="-1" title="−1"><i class="fa-solid fa-minus"></i></button>
                            <input type="number" class="text_pole agst-res-input" data-sheet-field="res-current" data-res="${escapeHtml(resource.id)}" value="${resource.current}" min="0" aria-label="${escapeHtml(resource.name)} atual">
                            <span class="agst-muted">/</span>
                            <input type="number" class="text_pole agst-res-input" data-sheet-field="res-max" data-res="${escapeHtml(resource.id)}" value="${resource.max}" min="0" aria-label="${escapeHtml(resource.name)} máximo">
                            <button type="button" class="agst-icon-button" data-sys-action="res-delta" data-res="${escapeHtml(resource.id)}" data-delta="1" title="+1"><i class="fa-solid fa-plus"></i></button>
                        </div>
                    </div>
                    <div class="agst-res-bar"><div class="agst-res-fill" style="width:${Math.max(0, Math.min(100, percent))}%"></div></div>
                </div>`;
        }).join('');

        const attributes = selected.attributes.map(attribute => `
            <div class="agst-attr" title="${escapeHtml(describe(KINDS.attributes, attribute.id))}">
                <div class="agst-attr-name">${escapeHtml(attribute.name)}</div>
                <div class="agst-mod">${formatModifier(attribute.modifier)}</div>
                <div class="agst-attr-row">
                    <input type="number" class="text_pole agst-attr-input" data-sheet-field="attr" data-id="${escapeHtml(attribute.id)}" value="${attribute.score}" min="0" max="99" aria-label="${escapeHtml(attribute.name)}">
                    <button type="button" class="agst-icon-button agst-roll" data-sys-action="roll" data-check="${escapeHtml(attribute.id)}" title="Rolar ${escapeHtml(attribute.name)}: d20 ${formatModifier(attribute.modifier)}"><i class="fa-solid fa-dice-d20"></i></button>
                </div>
            </div>`).join('');

        const skills = selected.skills.map(skill => `
            <div class="agst-skill" title="${escapeHtml(describe(KINDS.skills, skill.id))}">
                <span class="agst-skill-name">${escapeHtml(skill.name)} <span class="agst-muted">${escapeHtml(skill.attribute ? abbreviation(skill.attribute) : '—')}</span></span>
                <label class="agst-skill-bonus agst-muted">bônus
                    <input type="number" class="text_pole agst-skill-input" data-sheet-field="skill" data-id="${escapeHtml(skill.id)}" value="${skill.bonus}" aria-label="Bônus de ${escapeHtml(skill.name)}">
                </label>
                <span class="agst-mod">${formatModifier(skill.total)}</span>
                <button type="button" class="agst-icon-button agst-roll" data-sys-action="roll" data-check="${escapeHtml(skill.id)}" title="Rolar ${escapeHtml(skill.name)}: d20 ${formatModifier(skill.total)}"><i class="fa-solid fa-dice-d20"></i></button>
            </div>`).join('');

        const stats = selected.stats.map(stat => {
            const formula = [String(stat.base), stat.attribute ? `${abbreviation(stat.attribute)}` : null].filter(Boolean).join(' + ');
            return `
            <div class="agst-attr agst-stat${stat.defense ? ' is-defense' : ''}" title="${escapeHtml(describe(KINDS.stats, stat.id))}">
                <div class="agst-attr-name">${stat.defense ? '<i class="fa-solid fa-shield-halved"></i> ' : ''}${escapeHtml(stat.name)}</div>
                <div class="agst-mod">${stat.total}</div>
                <div class="agst-muted agst-stat-formula">${escapeHtml(formula)} + bônus</div>
                <div class="agst-attr-row">
                    <input type="number" class="text_pole agst-attr-input" data-sheet-field="stat" data-id="${escapeHtml(stat.id)}" value="${stat.bonus}" aria-label="Bônus de ${escapeHtml(stat.name)}" title="Bônus (armadura, itens…)">
                    ${stat.defense ? '' : `<button type="button" class="agst-icon-button agst-roll" data-sys-action="roll" data-check="${escapeHtml(stat.id)}" title="Rolar ${escapeHtml(stat.name)}: d20 ${formatModifier(stat.total)}"><i class="fa-solid fa-dice-d20"></i></button>`}
                </div>
            </div>`;
        }).join('');

        const abilities = this.abilitiesHtml(selected, definition);

        let linkSection = '';
        if (selected.location !== 'player') {
            if (selected.link) {
                linkSection = `
                    <h5>Vínculo com lorebook</h5>
                    <div class="agst-sys-link">
                        <i class="fa-solid fa-link"></i>
                        <span><b>${escapeHtml(selected.link.book)}</b> · #${selected.link.uid} ${escapeHtml(selected.link.title ?? '')}</span>
                        <span class="agst-spacer"></span>
                        <button type="button" class="menu_button" data-sys-action="unlink">Desvincular</button>
                    </div>
                    <div class="agst-muted">Esta ficha aparece em todo chat onde esse lorebook estiver ativo.</div>`;
            } else {
                const books = await this.lore.bookNames().catch(() => []);
                linkSection = `
                    <h5>Vínculo com lorebook</h5>
                    <div class="agst-sys-link-form">
                        <select class="text_pole" data-role="link-book">
                            <option value="">Lorebook…</option>
                            ${books.map(book => `<option value="${escapeHtml(book)}">${escapeHtml(book)}</option>`).join('')}
                        </select>
                        <select class="text_pole" data-role="link-entry" disabled><option value="">Entrada…</option></select>
                        <button type="button" class="menu_button" data-sys-action="link">Vincular</button>
                    </div>
                    <div class="agst-muted">Vincule à entrada do personagem para a ficha valer em outros chats.</div>`;
            }
        }

        const context = [];
        if (scope.characterName) context.push(`Personagem: <b>${escapeHtml(scope.characterName)}</b>`);
        if (!scope.hasChat) context.push('nenhum chat aberto');

        this.body.innerHTML = `
            <div class="agst-sys-scroll">
                <div class="agst-list-toolbar">
                    <select class="text_pole agst-sheet-select" data-role="sheet-select">${options}</select>
                    <button type="button" class="menu_button menu_button_icon" data-sys-action="new-npc"${scope.hasChat ? '' : ' disabled'}><i class="fa-solid fa-user-plus"></i><span>NPC</span></button>
                    ${selected.location !== 'player' ? '<button type="button" class="agst-icon-button" data-sys-action="delete-sheet" title="Excluir ficha"><i class="fa-solid fa-trash-can"></i></button>' : ''}
                </div>
                ${context.length ? `<div class="agst-muted agst-sys-context">${context.join(' · ')}</div>` : ''}
                <div class="agst-sheet">
                    <div class="agst-sheet-head">
                        <input type="text" class="text_pole agst-sheet-name" data-sheet-field="name" maxlength="60" value="${escapeHtml(selected.name)}" aria-label="Nome">
                        <span class="agst-badge">${LOCATION_LABELS[selected.location]}</span>
                    </div>
                    <h5>Recursos</h5>
                    <div class="agst-res-list">${resources || '<div class="agst-muted">Nenhum recurso nas regras.</div>'}</div>
                    ${stats ? `<h5>Estatísticas</h5><div class="agst-attr-grid">${stats}</div>` : ''}
                    <h5>Atributos</h5>
                    <div class="agst-attr-grid">${attributes || '<div class="agst-muted">Nenhum atributo nas regras.</div>'}</div>
                    <h5>Perícias</h5>
                    <div class="agst-skill-list">${skills || '<div class="agst-muted">Nenhuma perícia nas regras.</div>'}</div>
                    <div class="agst-sys-section-head">
                        <h5>Habilidades</h5>
                        <span class="agst-muted">${selected.abilities.length}</span>
                        <span class="agst-spacer"></span>
                        <button type="button" class="agst-icon-button" data-sys-action="new-ability" title="Nova habilidade"><i class="fa-solid fa-plus"></i></button>
                    </div>
                    <div class="agst-ability-list">${abilities}</div>
                    ${linkSection}
                    <h5>Notas</h5>
                    <textarea class="text_pole agst-sheet-notes" data-sheet-field="notes" rows="4" placeholder="Equipamento, condições, traços…">${escapeHtml(selected.notes)}</textarea>
                </div>
            </div>`;
    }

    /** Lista de habilidades da ficha; a que está em edição vira formulário. */
    abilitiesHtml(sheet, definition) {
        const checkOptions = current => [
            '<option value="">(sempre funciona, sem teste)</option>',
            `<optgroup label="Perícias">${sheet.skills.map(s => `<option value="${escapeHtml(s.id)}"${current === s.id ? ' selected' : ''}>${escapeHtml(s.name)} (${formatModifier(s.total)})</option>`).join('')}</optgroup>`,
            `<optgroup label="Atributos">${sheet.attributes.map(a => `<option value="${escapeHtml(a.id)}"${current === a.id ? ' selected' : ''}>${escapeHtml(a.name)} (${formatModifier(a.modifier)})</option>`).join('')}</optgroup>`,
        ].join('');
        const resourceOptions = current => sheet.resources
            .map((r, index) => `<option value="${escapeHtml(r.id)}"${(current ? current === r.id : r.id === 'mana' || (index === 1 && !sheet.resources.some(x => x.id === 'mana'))) ? ' selected' : ''}>${escapeHtml(r.name)}</option>`)
            .join('');

        const form = ability => `
            <div class="agst-sys-form agst-ability-form" data-ability="${escapeHtml(ability?.id ?? 'new')}">
                <input type="text" class="text_pole" data-ability-field="name" maxlength="60" placeholder="Nome (ex.: Bola de Fogo)" value="${escapeHtml(ability?.name ?? '')}">
                <textarea class="text_pole" data-ability-field="description" rows="2" placeholder="O que faz">${escapeHtml(ability?.description ?? '')}</textarea>
                <div class="agst-ability-grid">
                    <label>Custo
                        <span class="agst-sys-inline">
                            <input type="number" class="text_pole agst-number" data-ability-field="cost" min="0" value="${ability?.cost?.amount ?? 0}">
                            <select class="text_pole" data-ability-field="costResource">${resourceOptions(ability?.cost?.resourceId)}</select>
                        </span>
                    </label>
                    <label>Teste para acertar
                        <select class="text_pole" data-ability-field="check">${checkOptions(ability?.check ?? null)}</select>
                    </label>
                    <label>Efeito
                        <input type="text" class="text_pole" data-ability-field="effect" maxlength="300" placeholder="ex.: 2d6+FOR ou texto" value="${escapeHtml(ability?.effect ?? '')}">
                    </label>
                    ${definition.abilityFields.map(field => `
                        <label title="${escapeHtml(field.description)}">${escapeHtml(field.name)}
                            <input type="text" class="text_pole" data-ability-extra="${escapeHtml(field.id)}" maxlength="500" value="${escapeHtml(ability?.fields.find(f => f.id === field.id)?.value ?? '')}">
                        </label>`).join('')}
                </div>
                <div class="agst-sys-form-actions">
                    <button type="button" class="menu_button menu_button_icon" data-sys-action="save-ability"><i class="fa-solid fa-check"></i><span>Salvar</span></button>
                    <button type="button" class="menu_button" data-sys-action="cancel-ability">Cancelar</button>
                </div>
            </div>`;

        const card = ability => {
            const badges = [];
            if (ability.cost) badges.push(`<span class="agst-badge">${ability.cost.amount} ${escapeHtml(ability.cost.resource)}</span>`);
            if (ability.checkName) badges.push(`<span class="agst-badge">teste: ${escapeHtml(ability.checkName)}</span>`);
            if (ability.effect) badges.push(`<span class="agst-badge agst-badge-accent">${escapeHtml(ability.effect)}</span>`);
            const extras = ability.fields.filter(field => field.value)
                .map(field => `<span class="agst-ability-extra"><b>${escapeHtml(field.name)}:</b> ${escapeHtml(field.value)}</span>`).join('');
            return `
                <div class="agst-sys-item agst-ability">
                    <div class="agst-sys-item-main">
                        <div><b>${escapeHtml(ability.name)}</b> ${badges.join(' ')}</div>
                        ${ability.description ? `<div class="agst-muted">${escapeHtml(ability.description)}</div>` : ''}
                        ${extras ? `<div class="agst-ability-extras">${extras}</div>` : ''}
                    </div>
                    <div class="agst-card-actions">
                        <button type="button" class="agst-icon-button agst-roll" data-sys-action="use-ability" data-ability="${escapeHtml(ability.id)}" title="Usar (paga o custo e rola)"><i class="fa-solid fa-wand-sparkles"></i></button>
                        <button type="button" class="agst-icon-button" data-sys-action="edit-ability" data-ability="${escapeHtml(ability.id)}" title="Editar"><i class="fa-solid fa-pen"></i></button>
                        <button type="button" class="agst-icon-button" data-sys-action="delete-ability" data-ability="${escapeHtml(ability.id)}" title="Excluir"><i class="fa-solid fa-trash-can"></i></button>
                    </div>
                </div>`;
        };

        const rows = sheet.abilities.map(ability => (this.editingAbility === ability.id ? form(ability) : card(ability))).join('');
        const empty = '<div class="agst-muted agst-list-empty">Nenhuma habilidade. Toque em + para criar (magias, golpes, poderes).</div>';
        return `${this.editingAbility === 'new' ? form(null) : ''}${rows || (this.editingAbility === 'new' ? '' : empty)}`;
    }

    async saveAbility(formElement) {
        const id = formElement.dataset.ability;
        const value = field => formElement.querySelector(`[data-ability-field="${field}"]`)?.value ?? '';
        const fields = [...formElement.querySelectorAll('[data-ability-extra]')]
            .map(input => ({ id: input.dataset.abilityExtra, value: input.value }));
        const input = {
            name: value('name'),
            description: value('description'),
            cost: value('cost') || 0,
            costResource: value('costResource') || undefined,
            check: value('check') || null,
            effect: value('effect'),
            fields,
        };
        if (id === 'new') {
            await this.system.editAbility(this.selectedId, { action: 'add', ...input });
        } else {
            await this.system.editAbility(this.selectedId, { action: 'update', ability: id, ...input });
        }
        this.editingAbility = null;
        await this.render();
    }

    async loadLinkEntries(book) {
        const select = this.body.querySelector('[data-role="link-entry"]');
        if (!select) return;
        if (!book) {
            select.innerHTML = '<option value="">Entrada…</option>';
            select.disabled = true;
            return;
        }
        const result = await this.lore.read({ book, limit: 300 });
        select.innerHTML = result.entries
            .map(entry => `<option value="${entry.uid}">#${entry.uid} ${escapeHtml(entry.title || entry.keys.join(', ') || '(sem título)')}</option>`)
            .join('') || '<option value="">(lorebook vazio)</option>';
        select.disabled = !result.entries.length;
    }

    // ---------- eventos ----------

    async onClick(event) {
        const subtab = event.target.closest('[data-sys-tab]');
        if (subtab) {
            this.sub = subtab.dataset.sysTab;
            this.editing = null;
            this.editingAbility = null;
            await this.render().catch(error => this.fail(error));
            return;
        }
        const button = event.target.closest('[data-sys-action]');
        if (!button || button.disabled) return;
        const { sysAction: action, kind, item } = button.dataset;
        try {
            switch (action) {
                case 'new-item':
                    this.editing = { kind, id: 'new' };
                    await this.render();
                    break;
                case 'edit-item':
                    this.editing = { kind, id: item };
                    await this.render();
                    break;
                case 'cancel-edit':
                    this.editing = null;
                    await this.render();
                    break;
                case 'save-item':
                    await this.saveItem(button.closest('.agst-sys-form'));
                    break;
                case 'delete-item': {
                    const target = this.data.definition[kind].find(entry => entry.id === item);
                    const extra = kind === KINDS.attributes ? ' As perícias ligadas a ele ficam sem atributo.' : '';
                    if (!(await confirmDialog(`Excluir "${target?.name}"?`, `Os valores já salvos nas fichas são ignorados.${extra}`))) return;
                    await this.system.deleteItem(kind, item);
                    await this.render();
                    break;
                }
                case 'reset-rules':
                    if (!(await confirmDialog('Restaurar o padrão?', 'Os atributos, perícias e recursos voltam ao padrão. Itens criados por você serão removidos das regras.'))) return;
                    await this.system.resetDefinition();
                    await this.render();
                    break;
                case 'new-npc': {
                    const name = await promptText('Nova ficha de NPC', '', 'Nome do personagem');
                    if (!name?.trim()) return;
                    const created = await this.system.createSheet({ name });
                    this.selectedId = created.id;
                    await this.render();
                    break;
                }
                case 'delete-sheet': {
                    const current = this.data.sheets.find(sheet => sheet.id === this.selectedId);
                    if (!(await confirmDialog(`Excluir a ficha de ${current?.name}?`, 'Isto não pode ser desfeito.'))) return;
                    await this.system.deleteSheet(this.selectedId);
                    this.selectedId = null;
                    await this.render();
                    break;
                }
                case 'res-delta':
                    await this.system.adjustResource(this.selectedId, { resource: button.dataset.res, delta: Number(button.dataset.delta) });
                    await this.render();
                    break;
                case 'roll': {
                    const result = await this.system.roll(this.selectedId, { check: button.dataset.check });
                    const show = result.natural === 20 ? toastr.success : result.natural === 1 ? toastr.warning : toastr.info;
                    show(result.summary, 'Teste');
                    this.activity.add({ tool: 'ui_roll', ok: true, summary: result.summary });
                    break;
                }
                case 'link': {
                    const book = this.body.querySelector('[data-role="link-book"]')?.value;
                    const uid = this.body.querySelector('[data-role="link-entry"]')?.value;
                    if (!book || uid === undefined || uid === '') {
                        toastr.info('Escolha o lorebook e a entrada.');
                        return;
                    }
                    await this.system.updateSheet(this.selectedId, { linkLorebook: { book, uid: Number(uid) } });
                    await this.render();
                    break;
                }
                case 'unlink':
                    await this.system.updateSheet(this.selectedId, { unlinkLorebook: true });
                    await this.render();
                    break;
                case 'new-ability':
                    this.editingAbility = 'new';
                    await this.render();
                    this.body.querySelector('.agst-ability-form [data-ability-field="name"]')?.focus();
                    break;
                case 'edit-ability':
                    this.editingAbility = button.dataset.ability;
                    await this.render();
                    break;
                case 'cancel-ability':
                    this.editingAbility = null;
                    await this.render();
                    break;
                case 'save-ability':
                    await this.saveAbility(button.closest('.agst-ability-form'));
                    break;
                case 'delete-ability': {
                    const sheet = this.data.sheets.find(s => s.id === this.selectedId);
                    const ability = sheet?.abilities.find(a => a.id === button.dataset.ability);
                    if (!(await confirmDialog(`Excluir a habilidade "${ability?.name}"?`, ''))) return;
                    await this.system.editAbility(this.selectedId, { action: 'remove', ability: button.dataset.ability });
                    await this.render();
                    break;
                }
                case 'use-ability': {
                    const result = await this.system.useAbility(this.selectedId, { ability: button.dataset.ability });
                    const show = result.check?.natural === 20 ? toastr.success : result.check?.natural === 1 ? toastr.warning : toastr.info;
                    show(result.summary, 'Habilidade');
                    this.activity.add({ tool: 'ui_roll', ok: true, summary: result.summary });
                    await this.render();
                    break;
                }
                default:
                    break;
            }
        } catch (error) {
            this.fail(error);
            // Com um formulário aberto, mantém o que foi digitado para a pessoa corrigir.
            if (!this.editing && !this.editingAbility) await this.render().catch(() => undefined);
        }
    }

    async onChange(event) {
        const target = event.target;
        try {
            if (target.matches('[data-role="sheet-select"]')) {
                this.selectedId = target.value;
                this.editingAbility = null;
                await this.render();
                return;
            }
            // Campos do formulário de habilidade só valem ao tocar em Salvar.
            if (target.closest('.agst-ability-form') || target.closest('.agst-sys-form')) return;
            if (target.matches('[data-role="link-book"]')) {
                await this.loadLinkEntries(target.value);
                return;
            }
            const field = target.dataset.sheetField;
            if (!field) return;
            const { id, res } = target.dataset;
            const value = target.value;
            const changes = {
                name: { name: value },
                notes: { notes: value },
                attr: { attributes: [{ id, score: value }] },
                skill: { skills: [{ id, bonus: value }] },
                'res-current': { resources: [{ id: res, current: value }] },
                'res-max': { resources: [{ id: res, max: value }] },
                stat: { stats: [{ id, bonus: value }] },
            }[field];
            if (!changes) return;
            await this.system.updateSheet(this.selectedId, changes);
            await this.render();
        } catch (error) {
            this.fail(error);
            await this.render().catch(() => undefined);
        }
    }
}
