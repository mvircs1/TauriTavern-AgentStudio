# Agent Studio

Add-on para o **modo Agent do [TauriTavern](https://github.com/Darkatse/TauriTavern)**, que é o SillyTavern compilado em Rust e roda no Android.

O Agent Studio adiciona três coisas:

1. **Um estúdio de arquivos próprio.** É um espaço global, compartilhado entre todos os chats e personagens, onde o Agent organiza, cria e edita arquivos: bíblias de mundo, fichas de personagem, rascunhos de lore, planos de arco, linhas do tempo. Você também pode abrir, editar e organizar tudo por um painel visual.
2. **Edição dos lorebooks (World Info) do SillyTavern/TT.** O Agent pode listar, ler e buscar entradas, além de criar, editar e excluir entradas e criar lorebooks novos. **Antes de cada alteração, o plugin guarda um backup** do lorebook, que você pode restaurar pelo painel.
3. **Um sistema de RPG simples, sem nível nem XP.** Tem atributos, perícias e recursos como Vida e Mana, todos editáveis. Há fichas para o jogador e para NPCs, e testes de d20 com modificador no estilo D&D.

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

Para receber uma versão nova, use o botão de **atualizar** da extensão em Extensões e recarregue a página.

## Configuração (uma vez)

1. Em **Extensões**, abra a seção **Agent Studio**. O status deve mostrar "23 de 23 ferramentas registradas no Agent".
2. Em **Profile do Agent**, deixe selecionado **Agent Studio Writer (cópia do default-writer)** e toque em **Liberar ferramentas**.
   - O modelo só enxerga as ferramentas que estão liberadas no Profile ativo. O `default-writer` não pode ser editado, por isso o plugin cria uma cópia dele já com as ferramentas.
   - Se você já tem um Profile próprio, escolha ele na lista e libere as ferramentas nele.
   - Quando uma atualização traz ferramentas novas, o **Agent Studio Writer** recebe elas sozinho. Um Profile seu precisa ser liberado de novo.
3. **Segure o botão Agent**, perto do campo de mensagem, e escolha **Agent Studio Writer** em *Active Profile*.
4. Ative o modo Agent e converse normalmente. Alguns pedidos que funcionam:
   - "organize o que sabemos sobre o reino no estúdio"
   - "crie uma entrada no lorebook da Lyra sobre a capital"
   - "faça um teste de Furtividade para mim"

## Como abrir o estúdio

Há três caminhos:

- o menu de extensões (ícone da varinha) → **Agent Studio**;
- o comando `/studio`;
- o botão **Abrir o estúdio** nas configurações da extensão.

O painel tem cinco abas:

- **Arquivos**: árvore de pastas e editor, com visualização em Markdown. Para salvar, use **Ctrl+S** ou o botão. Se o Agent mudar o arquivo que você está editando, o painel avisa.
- **Sistema**: fichas e regras do RPG, explicadas na próxima seção.
- **Backups**: cópias dos lorebooks feitas antes de cada alteração do Agent, no máximo uma por lorebook a cada run. Daqui você restaura, exporta em JSON ou faz um backup manual.
- **Atividade**: as últimas chamadas de ferramenta do Agent e o que cada uma fez, incluindo os testes de dado.
- **Lixeira**: arquivos excluídos, por você ou pelo Agent, que ainda podem ser restaurados.

## Sistema de RPG

**Regras** (sub-aba *Regras*):

- **Atributos**: vêm 5 por padrão (Força, Destreza, Constituição, Inteligência, Carisma). O ✏️ muda nome e descrição, o ➕ cria outro e a 🗑️ exclui.
- **Perícias**: vêm 8 por padrão. Cada uma fica ligada a um atributo, por exemplo Furtividade → Destreza.
- **Recursos**: vêm Vida e Mana, cada um com um máximo padrão. Dá para criar outros, como Estamina ou Sanidade.

A IA lê as descrições, então descreva cada item do jeito que você quer que ele seja usado. Há também um botão para restaurar as regras padrão.

**Contas (no estilo D&D, sem nível):**

- **Modificador** = (valor − 10) ÷ 2, arredondado para baixo. Na prática: 8–9 = −1, 10–11 = +0, 12–13 = +1, 14–15 = +2, 16–17 = +3, 18–19 = +4, 20 = +5.
- **Perícia** = modificador do atributo + bônus da perícia. Por exemplo, +2 se o personagem for treinado nela.
- **Teste** = d20 + perícia ou atributo, contra uma dificuldade (CD): 10 é fácil, 15 é médio e 20 é difícil. Com vantagem ou desvantagem, rola 2d20 e fica com o maior ou o menor.

**Fichas** (sub-aba *Fichas*):

- **Jogador**: uma ficha por personagem (card), compartilhada entre os chats dele. O nome inicial é o da sua persona.
- **NPCs**: ficam no chat em que foram criados. Viajam junto com branches e exportações do chat.
- **NPC vinculado a um lorebook**: quando um personagem recorrente tem entrada num lorebook, a ficha dele pode ser vinculada a essa entrada. Aí ela aparece em todo chat onde esse lorebook estiver ativo. Você pode vincular pela própria ficha, ou a IA pode fazer isso sozinha.
- Na ficha você edita os valores. Os botões − e + ajustam Vida e Mana, e o 🎲 rola o teste, que aparece numa notificação e na aba Atividade. A IA mexe nas mesmas fichas pelas ferramentas.

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
| `lorebook_read` | Mostra o resumo das entradas, indicando quais têm ficha, ou entradas completas |
| `lorebook_search` | Busca em títulos, chaves e conteúdo |
| `lorebook_create_entry` | Cria uma entrada, com backup antes |
| `lorebook_update_entry` | Edita campos de uma entrada ou um trecho do conteúdo, com backup antes |
| `lorebook_delete_entry` | Exclui uma entrada, com backup antes |
| `lorebook_create_book` | Cria um lorebook vazio |
| `system_info` | Mostra as regras: atributos, perícias, recursos e como funcionam |
| `sheet_list` | Lista as fichas disponíveis no chat, com Vida e Mana |
| `sheet_read` | Lê uma ficha completa, com modificadores e totais |
| `sheet_create` | Cria a ficha de um NPC, que pode já nascer vinculada a um lorebook |
| `sheet_update` | Muda valores, notas e nome, ou vincula e desvincula a ficha de um lorebook |
| `sheet_resource` | Dano, cura ou gasto de Vida, Mana etc. |
| `sheet_delete` | Exclui a ficha de um NPC |
| `system_roll` | Teste de d20 + modificador contra uma CD, com vantagem ou desvantagem |

As configurações da extensão têm quatro interruptores: estúdio, leitura de lorebooks, edição de lorebooks e sistema.

## Onde ficam os dados

- **No TauriTavern**, o estúdio, as regras, a ficha do jogador, as fichas vinculadas a lorebooks e os backups ficam na pasta de dados do app, em `_tauritavern/extension-store/agent_studio/`. Tudo isso entra no backup do próprio TT.
- **No SillyTavern pelo navegador**, os mesmos dados ficam no IndexedDB do navegador.
- **Fichas de NPC do chat** ficam dentro do próprio chat (`chat_metadata`).

Os lorebooks continuam sendo os arquivos normais do SillyTavern. O plugin só usa as funções oficiais de leitura e gravação.

## Limitações conhecidas

- Um lorebook criado pelo Agent não é vinculado automaticamente a chat nem a personagem. O vínculo é feito no painel de World Info.
- O Agent "vê" os lorebooks ativados no começo da run. Entradas que ele cria ou edita passam a valer nas próximas mensagens.
- O estúdio e as fichas não entram no prompt sozinhos: o Agent consulta pelas ferramentas quando precisa.
- Ainda não há histórico de versões dos arquivos do estúdio. Só existe a lixeira.
- A IA não edita as regras do sistema (atributos, perícias, recursos). Isso fica com você, na aba Sistema.

## Desenvolvimento

- `node --test dev/core.test.mjs dev/system.test.mjs` roda os testes da lógica: estúdio, lorebooks, backups, registro das ferramentas e sistema de RPG. Eles usam simulações do SillyTavern e da API do TauriTavern 2.4.0.
- `dev/harness.html` é uma página de teste da interface fora do app. Para usar, sirva a pasta do projeto (por exemplo `python -m http.server`) e abra `/dev/harness.html`.
- `docs/` guarda as anotações da pesquisa sobre o TauriTavern e o modo Agent.
- No console do app, `AgentStudio` expõe os serviços para depuração, por exemplo `AgentStudio.bridge.registeredIds()` e `AgentStudio.system.readSheet()`.
