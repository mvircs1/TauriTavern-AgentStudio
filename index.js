// Agent Studio: add-on do modo Agent do TauriTavern.
// 1) Um estúdio global de arquivos que o Agent (e você) organiza, cria e edita.
// 2) Ferramentas para o Agent ler e editar os lorebooks (World Info), com backup automático.
// 3) Um sistema de RPG simples (atributos, perícias, Vida/Mana, testes de d20) com fichas.

import { ActivityLog } from './src/activity.js';
import { LorebookService } from './src/lorebook.js';
import { StudioPanel } from './src/panel.js';
import { getSettings, renderSettingsDrawer } from './src/settings.js';
import { createStorage } from './src/storage.js';
import { StudioFS } from './src/studio-fs.js';
import { SystemService } from './src/system.js';
import { syncSkill } from './src/skill.js';
import { AgentToolBridge, buildToolDefinitions } from './src/tools.js';
import { LOG_PREFIX } from './src/util.js';

async function waitForHost() {
    const ready = globalThis.__TAURITAVERN__?.ready ?? globalThis.__TAURITAVERN_MAIN_READY__;
    if (!ready) return;
    try {
        await ready;
    } catch (error) {
        console.warn(LOG_PREFIX, 'O host do TauriTavern sinalizou erro na inicialização', error);
    }
}

function addMenuButton(panel) {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('agent_studio_menu_button')) return;
    const button = document.createElement('div');
    button.id = 'agent_studio_menu_button';
    button.className = 'list-group-item flex-container flexGap5 interactable';
    button.tabIndex = 0;
    button.innerHTML = '<div class="fa-solid fa-folder-tree extensionsMenuExtensionButton"></div><span>Agent Studio</span>';
    button.addEventListener('click', () => panel.open());
    menu.append(button);
}

function registerSlashCommand(panel) {
    const context = SillyTavern.getContext();
    const callback = () => {
        panel.open();
        return '';
    };
    try {
        if (context.SlashCommandParser?.addCommandObject && context.SlashCommand?.fromProps) {
            context.SlashCommandParser.addCommandObject(context.SlashCommand.fromProps({
                name: 'studio',
                aliases: ['agentstudio'],
                callback,
                helpString: 'Abre o Agent Studio (estúdio de arquivos do Agent e backups dos lorebooks).',
            }));
        } else if (typeof context.registerSlashCommand === 'function') {
            context.registerSlashCommand('studio', callback, ['agentstudio'], 'Abre o Agent Studio.');
        }
    } catch (error) {
        console.warn(LOG_PREFIX, 'Não consegui registrar o comando /studio', error);
    }
}

async function init() {
    await waitForHost();
    getSettings();

    const storage = createStorage();
    const fs = new StudioFS(storage);
    const lore = new LorebookService(storage, getSettings);
    const activity = new ActivityLog(storage);
    await activity.load();
    const system = new SystemService(storage, lore);
    await system.run(() => undefined);

    const bridge = new AgentToolBridge({
        definitions: buildToolDefinitions({ fs, lore, system }),
        activity,
        getSettings,
    });
    const panel = new StudioPanel({ fs, lore, activity, system });

    const drawer = renderSettingsDrawer({ bridge, panel, storageKind: storage.kind });
    addMenuButton(panel);
    registerSlashCommand(panel);

    // Trocar de chat muda quais fichas estão visíveis.
    const { eventSource, eventTypes, event_types: legacyEventTypes } = SillyTavern.getContext();
    const chatChanged = (eventTypes ?? legacyEventTypes)?.CHAT_CHANGED;
    if (eventSource && chatChanged) eventSource.on(chatChanged, () => system.emit({ type: 'chat' }));

    if (bridge.isAvailable()) {
        await bridge.registerAll();
        try {
            const synced = await bridge.syncStudioProfile();
            if (synced?.added) console.info(LOG_PREFIX, `${synced.added} ferramenta(s) nova(s) liberada(s) no Profile ${synced.displayName}.`);
        } catch (error) {
            console.warn(LOG_PREFIX, 'Não consegui atualizar o Profile Agent Studio Writer', error);
        }
    }

    // A Skill ensina o Agent a usar as ferramentas; instala ou atualiza sozinha.
    try {
        const skill = await syncSkill();
        if (skill.status !== 'unavailable' && skill.status !== 'up-to-date') {
            console.info(LOG_PREFIX, `Skill agent-studio: ${skill.status}.`);
        }
    } catch (error) {
        console.warn(LOG_PREFIX, 'Não consegui instalar a Skill agent-studio', error);
    }
    drawer?.renderStatus();

    // Atalho para depuração pelo console: AgentStudio.fs.list(), AgentStudio.bridge.registeredIds() etc.
    globalThis.AgentStudio = { fs, lore, activity, system, bridge, panel, storage };
    console.info(LOG_PREFIX, `Pronto. ${bridge.registeredIds().length} ferramenta(s) registrada(s); armazenamento: ${storage.kind}.`);
}

init().catch(error => {
    console.error(LOG_PREFIX, 'Falha ao iniciar', error);
    globalThis.toastr?.error?.(String(error?.message ?? error), 'Agent Studio não iniciou');
});
