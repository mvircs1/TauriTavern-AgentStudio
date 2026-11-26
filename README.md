# Agent Studio

Add-on para o **modo Agent do [TauriTavern](https://github.com/Darkatse/TauriTavern)**, que é o SillyTavern compilado em Rust e roda no Android.

O Agent Studio adiciona duas coisas:

1. **Um estúdio de arquivos próprio.** É um espaço global, compartilhado entre todos os chats e personagens, onde o Agent organiza, cria e edita arquivos: bíblias de mundo, fichas de personagem, rascunhos de lore, planos de arco, linhas do tempo. Você também pode abrir, editar e organizar tudo por um painel visual.
2. **Edição dos lorebooks (World Info) do SillyTavern/TT.** O Agent pode listar, ler e buscar entradas, além de criar, editar e excluir entradas e criar lorebooks novos. **Antes de cada alteração, o plugin guarda um backup** do lorebook, que você pode restaurar pelo painel.

## Requisitos

- **TauriTavern 2.4.0 ou mais novo**: é a versão em que extensões passaram a poder registrar ferramentas no Agent.
- Uma API do tipo **Chat Completion**, exigida pelo próprio modo Agent.
- O painel do estúdio também abre no SillyTavern comum, com os arquivos guardados no navegador. Lá não existe modo Agent, então as ferramentas não aparecem.

## Instalação

O TauriTavern instala extensões a partir de uma **URL Git pública (https)**. Ele não aceita ZIP.

1. No TauriTavern, abra **Extensões → Instalar extensão**.
2. Cole esta URL:

   ```
   https://github.com/mvircs1/TauriTavern-AgentStudio
   ```

3. Recarregue a página, se ele pedir.

## Configuração (uma vez)

1. Em **Extensões**, abra a seção **Agent Studio**. O status deve mostrar "15 de 15 ferramentas registradas no Agent".
2. Em **Profile do Agent**, deixe selecionado **Agent Studio Writer (cópia do default-writer)** e toque em **Liberar ferramentas**.
   - O modelo só enxerga as ferramentas que estão liberadas no Profile ativo. O `default-writer` não pode ser editado, por isso o plugin cria uma cópia dele já com as ferramentas.
   - Se você já tem um Profile próprio, escolha ele na lista e libere as ferramentas nele.
3. **Segure o botão Agent**, perto do campo de mensagem, e escolha **Agent Studio Writer** em *Active Profile*.
4. Ative o modo Agent e converse normalmente. Você pode pedir coisas como "organize o que sabemos sobre o reino no estúdio" ou "crie uma entrada no lorebook da Lyra sobre a capital".

## Como abrir o estúdio

Há três caminhos:

- o menu de extensões (ícone da varinha) → **Agent Studio**;
- o comando `/studio`;
- o botão **Abrir o estúdio** nas configurações da extensão.

O painel tem quatro abas:

- **Arquivos**: árvore de pastas e editor, com visualização em Markdown. Para salvar, use **Ctrl+S** ou o botão. Se o Agent mudar o arquivo que você está editando, o painel avisa.
- **Backups**: cópias dos lorebooks feitas antes de cada alteração do Agent, no máximo uma por lorebook a cada run. Daqui você restaura, exporta em JSON ou faz um backup manual.
- **Atividade**: as últimas chamadas de ferramenta do Agent e o que cada uma fez.
- **Lixeira**: arquivos excluídos, por você ou pelo Agent, que ainda podem ser restaurados.

## Ferramentas que o Agent recebe

| Ferramenta | O que faz |
|---|---|
| `studio_list` | Lista pastas e arquivos do estúdio |
| `studio_read` | Lê um arquivo, paginando se for longo |
| `studio_write` | Cria ou reescreve um arquivo, ou acrescenta ao final dele |
| `studio_edit` | Troca um trecho exato do texto |
| `studio_search` | Busca em nomes e conteúdo |
| `studio_make_folder` | Cria uma pasta |
| `studio_move` | Move ou renomeia um arquivo ou pasta |
| `studio_delete` | Manda para a lixeira |
| `lorebook_list` | Lista os lorebooks e onde cada um está ativo (global, personagem, chat, persona) |
| `lorebook_read` | Mostra o resumo das entradas ou entradas completas |
| `lorebook_search` | Busca em títulos, chaves e conteúdo |
| `lorebook_create_entry` | Cria uma entrada, com backup antes |
| `lorebook_update_entry` | Edita campos de uma entrada ou um trecho do conteúdo, com backup antes |
| `lorebook_delete_entry` | Exclui uma entrada, com backup antes |
| `lorebook_create_book` | Cria um lorebook vazio |

As configurações da extensão têm três interruptores: estúdio, leitura de lorebooks e edição de lorebooks. Assim você pode, por exemplo, deixar o Agent só ler os lorebooks.

## Onde ficam os dados

- **No TauriTavern**, os dados ficam na pasta de dados do app, em `_tauritavern/extension-store/agent_studio/`, e entram no backup do próprio TT.
- **No SillyTavern pelo navegador**, ficam no IndexedDB do navegador.

Os lorebooks continuam sendo os arquivos normais do SillyTavern. O plugin só usa as funções oficiais de leitura e gravação.

## Limitações conhecidas

- Um lorebook criado pelo Agent não é vinculado automaticamente a chat nem a personagem. O vínculo é feito no painel de World Info.
- O Agent "vê" os lorebooks ativados no começo da run. Entradas que ele cria ou edita passam a valer nas próximas mensagens.
- O estúdio não entra no prompt sozinho: o Agent lê os arquivos quando precisa, pelas ferramentas.
- Ainda não há histórico de versões dos arquivos do estúdio. Só existe a lixeira.

## Desenvolvimento

- `node --test dev/core.test.mjs` roda os testes da lógica: estúdio, lorebooks, backups e registro das ferramentas. Eles usam simulações do SillyTavern e da API do TauriTavern 2.4.0.
- `dev/harness.html` é uma página de teste da interface fora do app. Para usar, sirva a pasta do projeto (por exemplo `python -m http.server`) e abra `/dev/harness.html`.
- `docs/` guarda as anotações da pesquisa sobre o TauriTavern e o modo Agent.
- No console do app, `AgentStudio` expõe os serviços para depuração, por exemplo `AgentStudio.bridge.registeredIds()`.
