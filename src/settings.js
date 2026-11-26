// Configurações do plugin (extensionSettings.agentStudio) e a seção na aba de extensões.

import { isSkillApiAvailable, skillStatus, syncSkill } from './skill.js';
import { STUDIO_PROFILE_ID } from './tools.js';
import { errorMessage, escapeHtml, LOG_PREFIX } from './util.js';

export const SETTINGS_KEY = 'agentStudio';

export const DEFAULT_SETTINGS = Object.freeze({
    studioTools: true,
    loreReadTools: true,
    loreWriteTools: true,
    systemTools: true,
    mapTools: true,
    mapPrompt: true,
    mapLore: true,
    undoOnRegenerate: true,
    backupsPerBook: 20,
});

export function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[SETTINGS_KEY] || typeof extensionSettings[SETTINGS_KEY] !== 'object') {
        extensionSettings[SETTINGS_KEY] = structuredClone(DEFAULT_SETTINGS);
    }
    const settings = extensionSettings[SETTINGS_KEY];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(settings, key)) settings[key] = value;
    }
    return settings;
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

/**
 * @param {{ bridge: import('./tools.js').AgentToolBridge, panel: { open: () => void }, storageKind: string }} deps
 */
export function renderSettingsDrawer({ bridge, panel, storageKind }) {
    const container = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!container) {
        console.warn(LOG_PREFIX, 'Container de configurações de extensões não encontrado.');
        return;
    }

    const root = document.createElement('div');
    root.className = 'agent-studio-settings';
    root.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b><i class="fa-solid fa-folder-tree"></i> Agent Studio</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="agst-settings-status" data-role="status"></div>
                <div class="agst-settings-row">
                    <div class="menu_button menu_button_icon" data-action="open">
                        <i class="fa-solid fa-folder-open"></i><span>Abrir o estúdio</span>
                    </div>
                </div>

                <h4>Ferramentas do Agent</h4>
                <label class="checkbox_label">
                    <input type="checkbox" data-setting="studioTools">
                    <span>Estúdio: listar, ler, criar, editar, mover e excluir arquivos</span>
                </label>
                <label class="checkbox_label">
                    <input type="checkbox" data-setting="loreReadTools">
                    <span>Lorebooks: listar, ler e buscar</span>
                </label>
                <label class="checkbox_label">
                    <input type="checkbox" data-setting="loreWriteTools">
                    <span>Lorebooks: criar, editar e excluir entradas; criar lorebooks</span>
                </label>
                <label class="checkbox_label">
                    <input type="checkbox" data-setting="systemTools">
                    <span>Sistema: ler e editar fichas, Vida/Mana e testes de d20</span>
                </label>
                <label class="checkbox_label" title="Ao regenerar uma resposta ou gerar uma nova swipe, o que o Agent mudou naquela resposta (arquivos, lorebooks, fichas) volta ao estado anterior. Também desfaz runs que falham ou são canceladas.">
                    <input type="checkbox" data-setting="undoOnRegenerate">
                    <span>Desfazer as alterações do Agent ao regenerar / gerar nova swipe</span>
                </label>

                <h4>Mapa</h4>
                <label class="checkbox_label">
                    <input type="checkbox" data-setting="mapTools">
                    <span>Ferramentas de mapa (o Agent cria lugares, conexões e move personagens)</span>
                </label>
                <label class="checkbox_label" title="Um bloco curto com o local atual, as saídas e quem está lá vai para o prompt (modo normal e Agent).">
                    <input type="checkbox" data-setting="mapPrompt">
                    <span>Colocar o local atual no prompt</span>
                </label>
                <label class="checkbox_label" title="Entradas de lorebook vinculadas ao local atual (e aos NPCs com ficha que estão nele) são ativadas sem precisar de palavra-chave. Deixe essas entradas sem chave para que só apareçam no lugar certo.">
                    <input type="checkbox" data-setting="mapLore">
                    <span>Ativar as entradas de lorebook do local atual</span>
                </label>
                <div class="agst-settings-row">
                    <label for="agst_backups_per_book">Backups guardados por lorebook</label>
                    <input id="agst_backups_per_book" type="number" min="1" max="500" class="text_pole agst-number" data-setting="backupsPerBook">
                </div>

                <h4>Profile do Agent</h4>
                <small class="agst-settings-hint">
                    O modelo só enxerga as ferramentas liberadas no Profile ativo. O <code>default-writer</code> não pode ser editado:
                    crie o <b>Agent Studio Writer</b> (uma cópia dele com as ferramentas) ou libere num Profile seu.
                    Depois, escolha esse Profile como <i>Active Profile</i> no painel do Agent (segure o botão Agent).
                </small>
                <div class="agst-settings-row">
                    <select class="text_pole" data-role="profile-select"></select>
                    <div class="menu_button menu_button_icon" data-action="grant">
                        <i class="fa-solid fa-unlock"></i><span>Liberar ferramentas</span>
                    </div>
                    <div class="menu_button menu_button_icon" data-action="refresh-profiles" title="Atualizar lista">
                        <i class="fa-solid fa-rotate"></i>
                    </div>
                </div>

                <h4>Skill do Agent</h4>
                <small class="agst-settings-hint">
                    A Skill <code>agent-studio</code> ensina o Agent a usar as ferramentas (quando rolar dados, como atualizar Vida/Mana,
                    como organizar o estúdio e os lorebooks). Ela é instalada sozinha; use o botão se precisar reinstalar.
                </small>
                <div class="agst-settings-row">
                    <div class="menu_button menu_button_icon" data-action="install-skill">
                        <i class="fa-solid fa-graduation-cap"></i><span>Instalar / atualizar Skill</span>
                    </div>
                </div>

                <h4>Diagnóstico</h4>
                <div class="agst-settings-status" data-role="diagnostics"></div>
                <div class="agst-settings-row">
                    <div class="menu_button menu_button_icon" data-action="diagnose">
                        <i class="fa-solid fa-stethoscope"></i><span>Verificar de novo</span>
                    </div>
                </div>
            </div>
        </div>`;
    container.append(root);

    const settings = getSettings();
    const statusEl = root.querySelector('[data-role="status"]');
    const selectEl = root.querySelector('[data-role="profile-select"]');
    const diagnosticsEl = root.querySelector('[data-role="diagnostics"]');

    for (const input of root.querySelectorAll('[data-setting]')) {
        const key = input.dataset.setting;
        if (input.type === 'checkbox') {
            input.checked = settings[key] !== false;
            input.addEventListener('change', async () => {
                settings[key] = input.checked;
                saveSettings();
                await bridge.applyEnabledState();
            });
        } else {
            input.value = String(settings[key]);
            input.addEventListener('change', () => {
                const value = Math.min(500, Math.max(1, Math.trunc(Number(input.value)) || DEFAULT_SETTINGS[key]));
                settings[key] = value;
                input.value = String(value);
                saveSettings();
            });
        }
    }

    root.querySelector('[data-action="open"]').addEventListener('click', () => panel.open());

    const renderStatus = () => {
        const lines = [];
        if (!globalThis.__TAURITAVERN__) {
            lines.push('<span class="agst-warn"><i class="fa-solid fa-triangle-exclamation"></i> TauriTavern não detectado. O estúdio funciona, mas as ferramentas do Agent só existem no TauriTavern.</span>');
        } else if (!bridge.isAvailable()) {
            lines.push('<span class="agst-warn"><i class="fa-solid fa-triangle-exclamation"></i> Esta versão do TauriTavern não permite que extensões registrem ferramentas do Agent (precisa da 2.4.0 ou mais nova).</span>');
        } else {
            const count = bridge.registeredIds().length;
            lines.push(`<span class="agst-ok"><i class="fa-solid fa-circle-check"></i> ${count} de ${bridge.definitions.length} ferramentas registradas no Agent.</span>`);
            for (const error of bridge.errors) {
                lines.push(`<span class="agst-warn">${escapeHtml(error.name)}: ${escapeHtml(error.message)}</span>`);
            }
        }
        lines.push(`<span class="agst-muted">Armazenamento: ${storageKind === 'tauritavern' ? 'pasta de dados do TauriTavern' : 'navegador (IndexedDB)'}</span>`);
        statusEl.innerHTML = lines.join('<br>');
        renderDiagnostics().catch(error => console.warn(LOG_PREFIX, 'Falha no diagnóstico', error));
    };

    const ok = text => `<span class="agst-ok"><i class="fa-solid fa-circle-check"></i> ${text}</span>`;
    const warn = text => `<span class="agst-warn"><i class="fa-solid fa-triangle-exclamation"></i> ${text}</span>`;

    /** Mostra o que falta para o Agent enxergar as ferramentas. */
    const renderDiagnostics = async () => {
        const lines = [];
        if (!bridge.isAvailable()) {
            lines.push(warn('Sem TauriTavern 2.4.0+, não há ferramentas do Agent.'));
        } else {
            const coverage = await bridge.profileCoverage(STUDIO_PROFILE_ID);
            if (!coverage?.exists) {
                lines.push(warn('O Profile <b>Agent Studio Writer</b> ainda não existe. Toque em <b>Liberar ferramentas</b> acima.'));
            } else if (coverage.granted < coverage.total) {
                lines.push(warn(`Agent Studio Writer: só ${coverage.granted} de ${coverage.total} ferramentas liberadas. Toque em <b>Liberar ferramentas</b>.`));
            } else {
                lines.push(ok(`Agent Studio Writer: ${coverage.granted} de ${coverage.total} ferramentas liberadas.`));
            }
            if (coverage?.disabled) {
                lines.push(warn(`${coverage.disabled} ferramenta(s) desligada(s) pelos interruptores acima.`));
            }
        }
        if (isSkillApiAvailable()) {
            const skill = await skillStatus().catch(() => ({ installed: false }));
            lines.push(skill.installed
                ? ok(`Skill <code>agent-studio</code> instalada${skill.version ? ` (v${escapeHtml(skill.version)})` : ''}.`)
                : warn('Skill <code>agent-studio</code> não instalada. Toque em <b>Instalar / atualizar Skill</b>.'));
        }
        lines.push(`<span class="agst-muted">Se a IA ainda não usar as ferramentas, confira:
            (1) o modo Agent está ligado (botão Agent perto do campo de mensagem);
            (2) o <i>Active Profile</i> é o Agent Studio Writer (segure o botão Agent);
            (3) a conexão é Chat Completion (o modo Agent não funciona com Text Completion);
            (4) na timeline da run aparecem chamadas como <code>sheet_list</code>. Se não aparece nenhuma, as ferramentas não chegaram ao modelo.</span>`);
        diagnosticsEl.innerHTML = lines.join('<br>');
    };

    root.querySelector('[data-action="diagnose"]').addEventListener('click', () => {
        renderDiagnostics().catch(error => toastr.error(errorMessage(error), 'Agent Studio'));
    });
    root.querySelector('[data-action="install-skill"]').addEventListener('click', async () => {
        if (!isSkillApiAvailable()) {
            toastr.warning('Esta versão do TauriTavern não tem a API de Skills.');
            return;
        }
        try {
            const result = await syncSkill();
            const label = { 'up-to-date': 'já estava atualizada', installed: 'instalada', replaced: 'atualizada' }[result.status] ?? result.status;
            toastr.success(`Skill agent-studio ${label}.`, 'Agent Studio');
            await renderDiagnostics();
        } catch (error) {
            console.error(LOG_PREFIX, error);
            toastr.error(errorMessage(error), 'Agent Studio: falha ao instalar a Skill');
        }
    });

    const loadProfiles = async () => {
        selectEl.innerHTML = '';
        const createOption = document.createElement('option');
        createOption.value = STUDIO_PROFILE_ID;
        createOption.textContent = 'Agent Studio Writer (cópia do default-writer)';
        selectEl.append(createOption);
        if (!bridge.isAvailable()) {
            selectEl.disabled = true;
            return;
        }
        try {
            const profiles = await bridge.listProfiles();
            for (const profile of profiles) {
                if (profile.id === STUDIO_PROFILE_ID || profile.id === 'default-writer') continue;
                const option = document.createElement('option');
                option.value = profile.id;
                option.textContent = profile.displayName ? `${profile.displayName} (${profile.id})` : profile.id;
                selectEl.append(option);
            }
        } catch (error) {
            console.warn(LOG_PREFIX, 'Não consegui listar os Profiles', error);
        }
    };

    root.querySelector('[data-action="refresh-profiles"]').addEventListener('click', () => loadProfiles());
    root.querySelector('[data-action="grant"]').addEventListener('click', async () => {
        if (!bridge.isAvailable()) {
            toastr.warning('As ferramentas do Agent precisam do TauriTavern 2.4.0 ou mais novo.');
            return;
        }
        try {
            const result = await bridge.grantToProfile(selectEl.value);
            const what = result.created ? `Profile "${result.displayName}" criado` : `Profile "${result.displayName}" atualizado`;
            toastr.success(`${what}: ${result.added} ferramenta(s) liberada(s). Escolha-o como Active Profile no painel do Agent.`, 'Agent Studio');
            await loadProfiles();
            selectEl.value = result.profileId;
            await renderDiagnostics();
        } catch (error) {
            console.error(LOG_PREFIX, error);
            toastr.error(errorMessage(error), 'Agent Studio: falha ao liberar ferramentas');
        }
    });

    renderStatus();
    loadProfiles();
    return { renderStatus, loadProfiles };
}
