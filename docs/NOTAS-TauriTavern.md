# TauriTavern: notas para escrever extensões

Pesquisa feita em 26/11/2026 com base no repositório oficial e na documentação. Se algo mudar, conferir as fontes no fim.

## O que é
- Repositório: github.com/Darkatse/TauriTavern. Licença AGPL-3.0. Versão mais recente: v2.4.0 (22/10/2026).
- O frontend é o do SillyTavern, sincronizado com a 1.19.0 segundo o README. O site de docs ainda diz 1.18.0, ou seja, está desatualizado.
- O backend foi reescrito em Rust sobre Tauri v2 (workspace em `src-tauri/`).
- Plataformas: Windows, macOS, Linux, Android (APK), iOS (TestFlight) e HarmonyOS (beta).

## Como o frontend fala com o backend
- **Não existe servidor HTTP local.** Os `fetch` e `$.ajax` same-origin para `/api/*` são interceptados em `src/tauri/main/interceptors.js`. Daí passam por `routes/*`, depois `safeInvoke`, e chegam aos comandos Tauri em Rust.
- Uma rota `/api/*` que não foi implementada responde 404 `{ error: "Unsupported endpoint: ..." }` e não cai em lugar nenhum.
- Os nomes dos comandos Rust são internos. Não devem ser chamados direto.

## Extensões ("plugins")
- **Só extensões de frontend (UI)**, no mesmo formato do SillyTavern: `manifest.json`, `index.js` e `style.css`.
- **Server plugins (Node) não são suportados.** Tudo precisa rodar em JS no navegador ou usar a API do TT.
- Instalação pela UI, a partir de uma **URL Git anônima http(s)**, usando gitoxide no Rust. Limitações:
  - não tem ZIP;
  - não tem SSH nem repositório privado;
  - não tem submodules nem LFS.
  - Copiar a pasta manualmente não está documentado.
- Pastas, relativas à raiz de dados:
  - local: `data/default-user/extensions/<pasta>`;
  - global: `data/extensions/third-party/<pasta>`;
  - se houver as duas, a local ganha.
- URL dos arquivos: `/scripts/extensions/third-party/<pasta>/<arquivo>`. O JS entra como `<script type="module">`. Arquivos acima de 32 MiB dão 413 no mobile, e não tem Range.
- Extensões third-party carregam **depois do APP_READY**, e o `EXTENSION_SETTINGS_LOADED` espera elas.
- `minimum_client_version` é comparado com `SillyTavern:<versão>:TauriTavern`.

## API padrão do SillyTavern (continua valendo)
- `SillyTavern.getContext()`, que dá acesso a:
  - `chat`, `characters`, `characterId`, `chatMetadata`;
  - `extensionSettings` com `saveSettingsDebounced()`;
  - `eventSource` com `event_types`;
  - `generateQuietPrompt`, `generateRaw`;
  - `renderExtensionTemplateAsync`, `Popup`, `loader`;
  - `registerFunctionTool`, `macros.register`;
  - `messageFormatter`.
- Para salvar o chat depois de editar mensagens, usar `await getContext().saveChat()`. Não importar de `script.js`.
- A UI de configurações vai em `#extensions_settings2`, com o padrão `inline-drawer`.
- `generate_interceptor` no manifest aponta para uma função global `(chat, contextSize, abort, type)`.
- Slash commands: `SlashCommandParser.addCommandObject(SlashCommand.fromProps({...}))`.

## Extras exclusivos do TauriTavern
- Esperar: `await (window.__TAURITAVERN__?.ready ?? window.__TAURITAVERN_MAIN_READY__)`.
- Para detectar se está no TT: `if (window.__TAURITAVERN__)`. Assim a mesma extensão roda nos dois.
- `window.__TAURITAVERN_HOST__` = `{ platform: 'android'|..., kind: 'mobile'|'desktop' }`.
- `window.__TAURITAVERN__.api` (abiVersion 2):
  - `extension.store`: KV global com `getJson` / `setJson` / `updateJson` / `listKeys` / `deleteJson`, e blobs com `getBlob` / `setBlob` / `getBlobStream`. Recebe `{ namespace, key, value?, table? }` e os nomes aceitam só `[A-Za-z0-9_.-]`.
  - `chat`: `current.handle()`. O handle oferece:
    - `locate.findLastMessage`;
    - `searchMessages`;
    - `store.*` (por chat);
    - `metadata.setExtension`;
    - `history.tail` / `before` / `beforePages`.
  - `worldInfo`: `getLastActivation`, `subscribeActivations`, `openEntry`.
  - `agent.tools.register` (ferramentas para o Agent), `layout`, `chatSurface` (experimental) e `dev` (logs).

## Mobile (Android)
- O app já cuida de barra de sistema, notch e teclado. **Não é preciso compensar safe-area nem teclado** no CSS.
- `--tt-ime-bottom` foi removido.
- Evitar:
  - `transform` em ancestrais de elementos fixed;
  - `calc-size()`;
  - trabalho pesado a cada resize.
- Dar foco em input só a partir de ação do usuário.
- `window.open` abre o navegador do sistema e retorna `null`.
- O WebView pode ser antigo, por isso existem polyfills para `at`, `findLast`, `toSorted` e `Object.hasOwn`.

## Ainda sem resposta clara
- O caminho absoluto da raiz de dados no Android. Escolher a pasta de dados só é possível no desktop.
- Se dá para instalar copiando a pasta manualmente, sem Git.
- Como fica CORS em `fetch` para URLs externas a partir de uma extensão.

## Fontes
- https://github.com/Darkatse/TauriTavern (README.en.md, docs/FrontendHostContract.md, docs/CurrentState/ThirdPartyExtensions.md, docs/API/*.md, docs/CurrentState/MobileStyleAdaptation.md)
- https://tauritavern.github.io/en/
- https://docs.sillytavern.app/for-contributors/writing-extensions/
