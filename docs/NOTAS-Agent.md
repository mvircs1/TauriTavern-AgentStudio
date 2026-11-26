# TauriTavern: modo Agent

Pesquisa feita em 26/11/2026. Fontes: as páginas `tauritavern.github.io/en/agent/*` e `/en/api/agent*.html`, mais o `docs/API/Agent.md` do repositório, que está em chinês e é mais novo que o site.

## O que é
- É um caminho de geração alternativo e opcional. Com o Agent desligado, tudo funciona como no SillyTavern normal.
- Em vez de gerar o texto direto, o modelo trabalha num **workspace de arquivos** usando ferramentas: busca no chat, lê o World Info, escreve rascunhos, aplica patches e, no fim, **commita um arquivo** (por padrão `output/main.md`) como a mensagem do chat.
- Requisitos e limitações:
  - só funciona com **Chat Completion**;
  - não suporta chat em grupo;
  - não tem streaming;
  - o snapshot não pode ter `tools`/`tool_calls` externos, e por isso não convive com o ToolManager legado.
- Quando falha, ele falha de forma explícita. Não volta para a geração normal sozinho.

## Como usar
- Tem um botão Agent perto do input. Um toque liga e desliga. Segurando o botão, abre o painel com Profiles, SKILLS e Active Profile.
- O Agent entra em ação quando você:
  - envia uma mensagem;
  - regenera;
  - faz overswipe gerando um candidato novo;
  - usa `/trigger`, só em chat 1:1.
- Trocar para um swipe que já existe não dispara uma run.

## Fluxo de uma run
1. O Legacy Generate roda em **dryRun**. Isso monta o prompt e faz o scan do World Info, mas sem chamar o modelo.
2. Com isso ele captura um `promptSnapshot`, que tem o payload do Chat Completion e a ativação do World Info.
3. Resolve o Profile, cria o workspace da run e o journal (`events.jsonl`).
4. Entra no loop: modelo → tool calls → modelo. O loop é limitado por `tools.maxRounds` e `maxCallsPerRun`.
5. `workspace.commit` dispara `chat_commit_requested`. O frontend então chama `saveReply()` e grava `extra.tauritavern.agent` na mensagem.
6. `workspace.finish` encerra a run. No modo foreground, é obrigatório ter feito pelo menos um commit antes.

Sobre erros: um erro de ferramenta volta para o modelo com `is_error = true`. Um erro de host (journal, checkpoint, save) derruba a run.

## Workspace
- Raízes:
  - `output/`: o corpo final da mensagem;
  - `scratch/`: rascunhos;
  - `plan/`: reservado;
  - `summaries/`;
  - `persist/`: memória que dura entre runs do mesmo chat, e só é promovida depois de um `workspace.finish` bem-sucedido.
- Arquivos que o modelo não vê: `input/`, `tool-args/`, `tool-results/`, `model-responses/`, `checkpoints/`, `events.jsonl`.
- Cada chat tem um `stableChatId` e um `workspaceId`, e cada run tem um `runId`.

## Ferramentas nativas
Os nomes canônicos usam ponto. O nome que o modelo vê troca o ponto por `_`.
- `chat.search`: aceita `query`, `limit` (no máximo 50), `role`, `start_message`, `end_message` e `scan_limit`.
- `chat.read_messages`: até 20 mensagens por chamada, 8000 caracteres por mensagem e 20000 no total.
- `worldinfo.read_activated`: lê só o que foi ativado nesta run.
- `skill.list`, `skill.search`, `skill.read`.
- `workspace.list_files`, `search_files`, `read_file`, `write_file` (modo replace ou append), `apply_patch` (`old_string`/`new_string` exatos), `commit` (replace ou append) e `finish`.
- `agent.list`, `agent.delegate`, `agent.await`, para SubAgents, e `task.return`, que só existe dentro do filho.
- `dice.roll`: precisa ser liberado explicitamente.
- Não existe: MCP, shell, `agent.handoff`.

## Profiles
- O único embutido é `default-writer`, que não pode ser editado. Para mudar, copie.
- O JSON mínimo tem:
  - `schemaVersion: 1`, `kind: "tauritavern.agentProfile"`, `id`, `displayName`;
  - `preset.mode`, `model.mode`;
  - `run.presentation` (`foreground` ou `background`), `run.modelRetry`;
  - `instructions.agentSystemPrompt` (`null` usa o padrão);
  - `tools.allow` / `deny` / `maxRounds` / `maxCallsPerRun`;
  - `skills.visible` / `deny` / `maxReadCharsPerCall` / `maxReadCharsPerRun`;
  - `workspace.visibleRoots` / `writableRoots`;
  - `plan.mode: "none"`;
  - `output.artifacts`, com exatamente um item `target: "messageBody"`.
- O preset ganha dois blocos posicionáveis:
  - `Agent System Prompt`: é só uma âncora, onde entra o prompt do Profile;
  - `Agent Results`: reinjeta os resultados de runs anteriores.

## Skills
- São pacotes de conhecimento lidos sob demanda. **Não executam código.**
- Estrutura: `SKILL.md` com frontmatter YAML (`name`, `description`), e opcionalmente `references/`, `examples/`, `assets/`, `scripts/` (que não roda) e `agents/tauritavern.json`.
- Importa por `.ttskill` ou zip. Os escopos possíveis são global, preset, Profile e personagem.

## API para extensões: `window.__TAURITAVERN__.api.agent`
- `startRunFromLegacyGenerate({ generationType, profileId, options: { stream: false, presentation } })` devolve `{ runId, status, workspaceId, stableChatId }`.
- `startRunWithPromptSnapshot({...})`: o próprio site desaconselha montar o snapshot na mão.
- `subscribe(runId, handler, { afterSeq, limit, intervalMs, onError })` devolve uma função de unsubscribe. Por baixo é polling de `readEvents`.
  - Evento: `{ seq, id, runId, timestamp, level, type, payload }`.
  - Eventos terminais: `run_completed`, `run_failed`, `run_cancelled`.
- `readEvents({ runId, afterSeq?, beforeSeq?, limit? })`.
- `readWorkspaceFile({ runId, path })` e `cancel(runId)`.
- Só documentado no repositório, pode não estar na release:
  - `submitGuidance({ runId, text })`;
  - `resume({ runId, revisionGuidance })`, que é o que o `/fix` usa;
  - `subscribeLiveProjection`, `listRuns`, `readWorkspaceBytes`, `readModelTurn`;
  - `sessions.*`.
- `profiles.list()`, `load(id)`, `save(profile)`, `delete(id)`.
- Lançam erro de propósito: `approveToolCall`, `readDiff`, `rollback`. O `listRuns` aparece como reservado no site, mas funciona segundo o repositório.

### Ferramentas próprias de uma extensão (`api.agent.tools`, documentado só no repositório)
```js
await agent.tools.register({
  extensionId: 'minha-ext',
  name: 'minha_ferramenta',
  description: '...',
  inputSchema: { type: 'object', properties: {} },
  contexts: ['chat', 'session'],   // obrigatório
  enabled: true,
  // returnsImages: false
}, async (args, ctx) => {          // ordem (args, ctx) deduzida; ctx = { target, signal, attachImage }
  return { ok: true };             // precisa ser serializável em JSON
});
await agent.tools.setEnabled('extension/minha-ext:minha_ferramenta', false);
agent.tools.list({ context: 'chat' });
```
- O ID estável é `extension/<extensionId>:<name>`. Registrar duas vezes dá erro.
- O registro dura até a página recarregar, então é preciso registrar de novo a cada load. O estado de ligado/desligado é a extensão que guarda.
- O timeout é de 60 s. Passou disso, o modelo recebe "resultado desconhecido" e não há retry.
- A ferramenta **precisa estar liberada no Profile** (`tools.allow`) para o modelo poder usar. Não existe fluxo de aprovação.
- Não está claro:
  - o nome exato que o modelo enxerga;
  - se o ID entra em `tools.allow` exatamente nesse formato;
  - se funciona dentro de SubAgent.

## Códigos de erro
- `agent.phase2b_chat_completion_required`
- `agent.external_tools_unsupported_phase2b`
- `agent.presentation_invalid`
- `agent.invalid_profile`
- `tool.policy_denied`
- `workspace.path_denied`
- `workspace.required_artifact_missing`
- `model.request_failed`
- `commit.save_failed`
