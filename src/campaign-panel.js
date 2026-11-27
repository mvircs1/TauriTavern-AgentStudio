// Aba "Campanha" do Agent Studio: relógio do jogo, combate (ordem de iniciativa e turnos) e missões do chat.

import { formatClock, QUEST_STATUS } from './campaign.js';
import { confirmDialog } from './ui.js';
import { errorMessage, escapeHtml, LOG_PREFIX } from './util.js';

const STATUS_ICONS = { active: 'fa-scroll', done: 'fa-circle-check', failed: 'fa-circle-xmark' };

export class CampaignView {
    constructor({ campaign, system, activity, container }) {
        this.campaign = campaign;
        this.system = system;
        this.activity = activity;
        this.container = container;
        this.editingQuest = null; // id, 'new' ou null
        this.editingClock = false;
        this.showFinished = false;
        this.pendingRefresh = false;
    }

    mount() {
        this.container.innerHTML = '<div class="agst-sys-scroll agst-campaign" data-role="campaign-body"></div>';
        this.body = this.container.querySelector('[data-role="campaign-body"]');
        this.container.addEventListener('click', event => this.onClick(event));
        this.container.addEventListener('change', event => this.onChange(event));
        this.container.addEventListener('focusout', () => {
            if (!this.pendingRefresh) return;
            setTimeout(() => {
                if (!this.isBusy()) this.refresh();
            }, 0);
        });
    }

    fail(error) {
        console.error(LOG_PREFIX, error);
        toastr.error(errorMessage(error), 'Agent Studio');
    }

    isBusy() {
        const element = document.activeElement;
        const typing = Boolean(element && this.container.contains(element) && /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName));
        return typing || Boolean(this.editingQuest) || this.editingClock;
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
        const data = await this.campaign.snapshot();
        this.data = data;
        if (!data.hasChat) {
            this.body.innerHTML = '<div class="agst-empty"><i class="fa-solid fa-scroll"></i><p>Abra um chat para ver a campanha.</p></div>';
            return;
        }
        let sheets = [];
        try { sheets = (await this.system.listSheets()).sheets; } catch { sheets = []; }
        this.sheets = sheets;
        this.body.innerHTML = `
            ${this.clockHtml(data.clock)}
            ${this.combatHtml(data.combat, sheets)}
            ${this.questsHtml(data.quests)}
            <p class="agst-muted agst-sys-hint">A hora, o combate e as missões ativas vão para o prompt num bloco curto ("Estado do jogo"), junto com Vida/Mana e condições do jogador. A IA mexe em tudo isso pelas ferramentas; o que ela faz numa resposta é desfeito ao regenerar.</p>`;
    }

    // ---------- relógio ----------

    clockHtml(clock) {
        if (this.editingClock) {
            const hh = clock ? String(Math.floor(clock.minutes / 60)).padStart(2, '0') : '08';
            const mm = clock ? String(clock.minutes % 60).padStart(2, '0') : '00';
            return `
                <h4><i class="fa-solid fa-clock"></i> Tempo</h4>
                <div class="agst-sys-form">
                    <div class="agst-ability-grid">
                        <label>Dia<input type="number" class="text_pole" data-clock="day" min="1" value="${clock?.day ?? 1}"></label>
                        <label>Hora<input type="time" class="text_pole" data-clock="time" value="${hh}:${mm}"></label>
                        <label>Clima<input type="text" class="text_pole" data-clock="weather" maxlength="120" placeholder="ensolarado, chuva fina…" value="${escapeHtml(clock?.weather ?? '')}"></label>
                        <label>Nota<input type="text" class="text_pole" data-clock="note" maxlength="200" placeholder="lua cheia, festival…" value="${escapeHtml(clock?.note ?? '')}"></label>
                    </div>
                    <div class="agst-sys-form-actions">
                        <button type="button" class="menu_button menu_button_icon" data-camp-action="save-clock"><i class="fa-solid fa-check"></i><span>Salvar</span></button>
                        <button type="button" class="menu_button" data-camp-action="cancel-clock">Cancelar</button>
                        ${clock ? '<button type="button" class="menu_button" data-camp-action="clear-clock">Sem relógio</button>' : ''}
                    </div>
                </div>`;
        }
        return `
            <div class="agst-sys-section-head">
                <h4><i class="fa-solid fa-clock"></i> Tempo</h4>
                <span class="agst-spacer"></span>
                <button type="button" class="agst-icon-button" data-camp-action="edit-clock" title="Acertar dia, hora e clima"><i class="fa-solid fa-pen"></i></button>
            </div>
            <div class="agst-camp-clock">
                <span class="agst-camp-now">${clock ? escapeHtml(formatClock(clock)) : '<span class="agst-muted">Sem relógio. A IA começa a contar quando o tempo importar, ou acerte aqui.</span>'}</span>
                ${clock?.note ? `<span class="agst-muted">${escapeHtml(clock.note)}</span>` : ''}
            </div>
            <div class="agst-sys-form-actions">
                <button type="button" class="menu_button" data-camp-action="advance" data-minutes="10">+10 min</button>
                <button type="button" class="menu_button" data-camp-action="advance" data-minutes="60">+1 h</button>
                <button type="button" class="menu_button" data-camp-action="advance" data-minutes="480">+8 h</button>
                <button type="button" class="menu_button" data-camp-action="advance" data-minutes="1440">+1 dia</button>
            </div>`;
    }

    // ---------- combate ----------

    combatHtml(combat, sheets) {
        if (!combat) {
            const options = sheets.map(sheet => `<label class="checkbox_label"><input type="checkbox" data-combat-sheet="${escapeHtml(sheet.name)}"${sheet.kind === 'player' ? ' checked' : ''}> <span>${escapeHtml(sheet.name)}</span></label>`).join('');
            return `
                <h4><i class="fa-solid fa-khanda"></i> Combate</h4>
                <div class="agst-muted">Nenhum combate agora. Marque quem luta (fichas rolam a iniciativa) e, se quiser, outros participantes:</div>
                <div class="agst-fill-books">${options || '<span class="agst-muted">Sem fichas neste chat.</span>'}</div>
                <div class="agst-map-add">
                    <input type="text" class="text_pole" data-role="combat-extra" placeholder="Outros, separados por vírgula: Lobo 1, Lobo 2=14">
                    <button type="button" class="menu_button menu_button_icon" data-camp-action="start-combat"><i class="fa-solid fa-play"></i><span>Iniciar combate</span></button>
                </div>`;
        }
        const rows = combat.order.map((entry, index) => {
            const sheet = entry.sheetId ? sheets.find(item => item.id === entry.sheetId) : null;
            return `
                <div class="agst-camp-turn${index === combat.turn ? ' is-current' : ''}">
                    <span class="agst-camp-init">${entry.initiative}</span>
                    <span class="agst-camp-who">${index === combat.turn ? '<i class="fa-solid fa-play"></i> ' : ''}<b>${escapeHtml(entry.name)}</b>
                        ${sheet ? `<span class="agst-muted">${escapeHtml(sheet.resources)}${sheet.conditions ? ` · ${escapeHtml(sheet.conditions)}` : ''}</span>` : '<span class="agst-muted">sem ficha</span>'}</span>
                    <button type="button" class="agst-icon-button" data-camp-action="remove-fighter" data-name="${escapeHtml(entry.name)}" title="Tirar do combate"><i class="fa-solid fa-xmark"></i></button>
                </div>`;
        }).join('');
        return `
            <div class="agst-sys-section-head">
                <h4><i class="fa-solid fa-khanda"></i> Combate · rodada ${combat.round}</h4>
            </div>
            <div class="agst-camp-order">${rows}</div>
            <div class="agst-sys-form-actions">
                <button type="button" class="menu_button menu_button_icon" data-camp-action="next-turn"><i class="fa-solid fa-forward-step"></i><span>Próximo turno</span></button>
                <button type="button" class="menu_button menu_button_icon" data-camp-action="end-combat"><i class="fa-solid fa-flag-checkered"></i><span>Encerrar</span></button>
            </div>
            <div class="agst-map-add">
                <input type="text" class="text_pole" data-role="combat-add" placeholder="Entrar no combate: nome (ou nome=iniciativa)">
                <button type="button" class="menu_button" data-camp-action="add-fighter">Adicionar</button>
            </div>`;
    }

    // ---------- missões ----------

    questsHtml(quests) {
        const active = quests.filter(quest => quest.status === 'active');
        const finished = quests.filter(quest => quest.status !== 'active');
        const card = quest => {
            if (this.editingQuest === quest.id) return this.questForm(quest);
            const done = quest.objectives.filter(o => o.done).length;
            return `
                <div class="agst-quest is-${quest.status}">
                    <div class="agst-quest-head">
                        <i class="fa-solid ${STATUS_ICONS[quest.status]}"></i>
                        <b>${escapeHtml(quest.title)}</b>
                        ${quest.objectives.length ? `<span class="agst-badge">${done}/${quest.objectives.length}</span>` : ''}
                        ${quest.status !== 'active' ? `<span class="agst-badge">${QUEST_STATUS[quest.status]}</span>` : ''}
                        <span class="agst-spacer"></span>
                        ${quest.status === 'active' ? `
                            <button type="button" class="agst-icon-button" data-camp-action="quest-status" data-quest="${escapeHtml(quest.id)}" data-status="done" title="Concluir"><i class="fa-solid fa-check"></i></button>
                            <button type="button" class="agst-icon-button" data-camp-action="quest-status" data-quest="${escapeHtml(quest.id)}" data-status="failed" title="Falhou"><i class="fa-solid fa-ban"></i></button>`
                        : `<button type="button" class="agst-icon-button" data-camp-action="quest-status" data-quest="${escapeHtml(quest.id)}" data-status="active" title="Reabrir"><i class="fa-solid fa-rotate-left"></i></button>`}
                        <button type="button" class="agst-icon-button" data-camp-action="edit-quest" data-quest="${escapeHtml(quest.id)}" title="Editar"><i class="fa-solid fa-pen"></i></button>
                        <button type="button" class="agst-icon-button" data-camp-action="delete-quest" data-quest="${escapeHtml(quest.id)}" title="Excluir"><i class="fa-solid fa-trash-can"></i></button>
                    </div>
                    ${quest.description ? `<div class="agst-quest-text">${escapeHtml(quest.description)}</div>` : ''}
                    ${quest.objectives.length ? `<div class="agst-quest-objectives">${quest.objectives.map(o => `
                        <label class="checkbox_label"><input type="checkbox" data-objective="${escapeHtml(o.id)}" data-quest="${escapeHtml(quest.id)}"${o.done ? ' checked' : ''}${quest.status === 'active' ? '' : ' disabled'}> <span${o.done ? ' class="is-done"' : ''}>${escapeHtml(o.text)}</span></label>`).join('')}</div>` : ''}
                    ${quest.giver || quest.reward ? `<div class="agst-muted">${[quest.giver ? `Quem pediu: ${escapeHtml(quest.giver)}` : '', quest.reward ? `Recompensa: ${escapeHtml(quest.reward)}` : ''].filter(Boolean).join(' · ')}</div>` : ''}
                    ${quest.secret ? `<details class="agst-quest-secret"><summary>Segredo do narrador</summary>${escapeHtml(quest.secret)}</details>` : ''}
                </div>`;
        };
        return `
            <div class="agst-sys-section-head">
                <h4><i class="fa-solid fa-scroll"></i> Missões</h4>
                <span class="agst-muted">${active.length} ativa(s)</span>
                <span class="agst-spacer"></span>
                <button type="button" class="agst-icon-button" data-camp-action="new-quest" title="Nova missão"><i class="fa-solid fa-plus"></i></button>
            </div>
            ${this.editingQuest === 'new' ? this.questForm(null) : ''}
            <div class="agst-quest-list">${active.map(card).join('') || (this.editingQuest === 'new' ? '' : '<div class="agst-muted">Nenhuma missão ativa.</div>')}</div>
            ${finished.length ? `
                <button type="button" class="menu_button agst-camp-toggle" data-camp-action="toggle-finished">${this.showFinished ? 'Esconder' : 'Mostrar'} encerradas (${finished.length})</button>
                ${this.showFinished ? `<div class="agst-quest-list">${finished.slice().reverse().map(card).join('')}</div>` : ''}` : ''}`;
    }

    questForm(quest) {
        const objectives = (quest?.objectives ?? []).map(o => `${o.done ? '[x] ' : ''}${o.text}`).join('\n');
        return `
            <div class="agst-sys-form agst-place-form" data-role="quest-form" data-quest="${escapeHtml(quest?.id ?? '')}">
                <label>Título<input type="text" class="text_pole" data-quest-field="title" maxlength="120" value="${escapeHtml(quest?.title ?? '')}"></label>
                <label>Descrição<textarea class="text_pole" data-quest-field="description" rows="2">${escapeHtml(quest?.description ?? '')}</textarea></label>
                <label>Objetivos <span class="agst-muted">(um por linha; "[x] " no começo = feito)</span><textarea class="text_pole" data-quest-field="objectives" rows="3">${escapeHtml(objectives)}</textarea></label>
                <div class="agst-ability-grid">
                    <label>Quem pediu<input type="text" class="text_pole" data-quest-field="giver" maxlength="200" value="${escapeHtml(quest?.giver ?? '')}"></label>
                    <label>Recompensa<input type="text" class="text_pole" data-quest-field="reward" maxlength="200" value="${escapeHtml(quest?.reward ?? '')}"></label>
                </div>
                <label>Segredo <span class="agst-muted">(só o narrador sabe)</span><textarea class="text_pole" data-quest-field="secret" rows="2">${escapeHtml(quest?.secret ?? '')}</textarea></label>
                <div class="agst-sys-form-actions">
                    <button type="button" class="menu_button menu_button_icon" data-camp-action="save-quest"><i class="fa-solid fa-check"></i><span>Salvar</span></button>
                    <button type="button" class="menu_button" data-camp-action="cancel-quest">Cancelar</button>
                </div>
            </div>`;
    }

    // ---------- eventos ----------

    /** "Lobo 1, Lobo 2=14" -> [{ name: 'Lobo 1' }, { name: 'Lobo 2', initiative: 14 }] */
    static parseFighters(text) {
        return String(text ?? '').split(',').map(part => part.trim()).filter(Boolean).map(part => {
            const [name, initiative] = part.split('=').map(item => item.trim());
            return initiative !== undefined && initiative !== '' ? { name, initiative: Number(initiative) } : { name };
        });
    }

    async onClick(event) {
        const button = event.target.closest('[data-camp-action]');
        if (!button || button.disabled) return;
        const action = button.dataset.campAction;
        const value = selector => this.body.querySelector(selector)?.value ?? '';
        try {
            switch (action) {
                case 'edit-clock':
                    this.editingClock = true;
                    await this.render();
                    break;
                case 'cancel-clock':
                    this.editingClock = false;
                    await this.render();
                    break;
                case 'clear-clock':
                    this.editingClock = false;
                    await this.campaign.setClock(null);
                    await this.render();
                    break;
                case 'save-clock': {
                    const [hh, mm] = (value('[data-clock="time"]') || '08:00').split(':').map(Number);
                    await this.campaign.setClock({
                        day: Number(value('[data-clock="day"]')) || 1,
                        minutes: (hh || 0) * 60 + (mm || 0),
                        weather: value('[data-clock="weather"]'),
                        note: value('[data-clock="note"]'),
                    });
                    this.editingClock = false;
                    await this.render();
                    break;
                }
                case 'advance': {
                    const result = await this.campaign.time({ advanceMinutes: Number(button.dataset.minutes) });
                    this.activity.add({ tool: 'ui_time', ok: true, summary: `Tempo: ${result.now}` });
                    await this.render();
                    break;
                }
                case 'start-combat': {
                    const chosen = [...this.body.querySelectorAll('[data-combat-sheet]')].filter(input => input.checked).map(input => input.dataset.combatSheet);
                    const extra = CampaignView.parseFighters(value('[data-role="combat-extra"]'));
                    const participants = [...chosen, ...extra];
                    if (!participants.length) {
                        toastr.info('Marque ou escreva quem participa.');
                        return;
                    }
                    const result = await this.campaign.combat({ action: 'start', participants });
                    this.activity.add({ tool: 'ui_combat', ok: true, summary: `Combate iniciado: ${result.initiative_rolls.join('; ')}` });
                    await this.render();
                    break;
                }
                case 'next-turn': {
                    const result = await this.campaign.combat({ action: 'next' });
                    if (result.conditions_ended?.length) toastr.info(`Acabou: ${result.conditions_ended.join(', ')}`, 'Condições');
                    await this.render();
                    break;
                }
                case 'end-combat':
                    if (!(await confirmDialog('Encerrar o combate?', 'A ordem de iniciativa é apagada.'))) return;
                    await this.campaign.combat({ action: 'end' });
                    await this.render();
                    break;
                case 'add-fighter': {
                    const participants = CampaignView.parseFighters(value('[data-role="combat-add"]'));
                    if (!participants.length) return;
                    await this.campaign.combat({ action: 'add', participants });
                    await this.render();
                    break;
                }
                case 'remove-fighter':
                    await this.campaign.combat({ action: 'remove', participants: [button.dataset.name] });
                    await this.render();
                    break;
                case 'new-quest':
                    this.editingQuest = 'new';
                    await this.render();
                    this.body.querySelector('[data-quest-field="title"]')?.focus();
                    break;
                case 'edit-quest':
                    this.editingQuest = button.dataset.quest;
                    this.showFinished = this.showFinished || this.data.quests.find(q => q.id === button.dataset.quest)?.status !== 'active';
                    await this.render();
                    break;
                case 'cancel-quest':
                    this.editingQuest = null;
                    await this.render();
                    break;
                case 'save-quest':
                    await this.saveQuest(button.closest('[data-role="quest-form"]'));
                    break;
                case 'delete-quest': {
                    const quest = this.data.quests.find(q => q.id === button.dataset.quest);
                    if (!(await confirmDialog(`Excluir a missão "${quest?.title}"?`, 'Ela some do diário.'))) return;
                    await this.campaign.removeQuest(button.dataset.quest);
                    await this.render();
                    break;
                }
                case 'quest-status': {
                    const quest = this.data.quests.find(q => q.id === button.dataset.quest);
                    const status = button.dataset.status;
                    const objectives = status === 'done' ? quest.objectives.map(o => ({ ...o, done: true })) : quest.objectives;
                    await this.campaign.saveQuest({ ...quest, status, objectives });
                    await this.render();
                    break;
                }
                case 'toggle-finished':
                    this.showFinished = !this.showFinished;
                    await this.render();
                    break;
                default:
                    break;
            }
        } catch (error) {
            this.fail(error);
        }
    }

    async saveQuest(form) {
        const field = name => form.querySelector(`[data-quest-field="${name}"]`)?.value ?? '';
        const id = form.dataset.quest || undefined;
        const existing = id ? this.data.quests.find(q => q.id === id) : null;
        const objectives = field('objectives').split('\n').map(line => line.trim()).filter(Boolean).map(line => {
            const done = /^\[x\]\s*/i.test(line);
            const text = line.replace(/^\[[x ]?\]\s*/i, '');
            const old = existing?.objectives.find(o => o.text === text);
            return { id: old?.id, text, done };
        });
        await this.campaign.saveQuest({
            id,
            title: field('title'),
            description: field('description'),
            objectives,
            giver: field('giver'),
            reward: field('reward'),
            secret: field('secret'),
            status: existing?.status ?? 'active',
            createdAt: existing?.createdAt,
        });
        this.editingQuest = null;
        await this.render();
    }

    async onChange(event) {
        const input = event.target;
        if (!input.matches('[data-objective]')) return;
        try {
            const quest = this.data.quests.find(q => q.id === input.dataset.quest);
            if (!quest) return;
            const objectives = quest.objectives.map(o => (o.id === input.dataset.objective ? { ...o, done: input.checked } : o));
            await this.campaign.saveQuest({ ...quest, objectives });
            await this.render();
        } catch (error) {
            this.fail(error);
        }
    }
}
