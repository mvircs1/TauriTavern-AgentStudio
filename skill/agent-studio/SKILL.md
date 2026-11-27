---
name: agent-studio
description: Guia das ferramentas do Agent Studio. Cobre o estúdio de arquivos persistente (studio_*), os lorebooks/World Info (lorebook_*) e o sistema de RPG com fichas, Vida/Mana, Defesa, perícias com treinamento, habilidades, itens/equipamento e testes de dados, condições (system_*, sheet_*, ability_use), combate, missões e tempo (combat, quest, game_time), e o mapa do mundo em três níveis com a posição do jogador (map_*). Leia no começo de qualquer run em que o usuário fale de lore, notas, organizar informações, lorebook, ficha, atributos, perícias, habilidades, magias, itens, equipamento, dano, cura, combate, iniciativa, condição, missão, tempo, teste de dado, lugares, viagem ou mapa.
version: 0.8.0
author: mvircs1
tags: [agent-studio, rpg, lorebook, world-info, map]
---

# Agent Studio: como usar as ferramentas

Você tem ferramentas extras deste plugin. Elas estão na sua lista de ferramentas com os nomes abaixo. O nome pode vir com um sufixo como `__2` se houver conflito.

**Chame as ferramentas de verdade.** Não descreva o que faria e não invente valores de ficha, resultados de dado ou conteúdo de lorebook: consulte e altere pelas ferramentas.

Se uma ferramenta desta lista não aparecer para você, diga isso ao usuário. Ele precisa ativar o Profile **Agent Studio Writer** (segurar o botão Agent → *Active Profile*) ou liberar as ferramentas no Profile atual, em Extensões → Agent Studio.

Depois de usar as ferramentas, escreva a resposta da história normalmente no seu arquivo de saída e faça o commit, como sempre. As ferramentas não substituem a resposta.

## Mapa rápido

| Quero… | Ferramenta |
|---|---|
| Ver as regras do RPG (atributos, perícias, recursos, estatísticas) | `system_info` |
| Ver as fichas da cena, Vida/Mana e Defesa de todos | `sheet_list` |
| Ver uma ficha completa (com habilidades) | `sheet_read` |
| Rolar um teste ou um ataque contra a Defesa de alguém | `system_roll` |
| Envenenar, atordoar, abençoar (condições) | `sheet_condition` |
| Começar um combate, passar o turno, encerrar | `combat` |
| Missões e objetivos | `quest` |
| Passar o tempo, mudar o clima | `game_time` |
| Usar uma habilidade (gasta custo, rola teste e efeito) | `ability_use` |
| Dar, editar ou tirar uma habilidade de um personagem | `sheet_ability` |
| Dar, equipar, guardar, consumir ou tirar itens | `sheet_item` |
| Causar dano, curar ou gastar mana | `sheet_resource` |
| Criar um NPC com ficha | `sheet_create` |
| Mudar atributos, perícias, bônus de Defesa, notas ou vincular a lorebook | `sheet_update` |
| Apagar a ficha de um NPC | `sheet_delete` |
| Ver onde o jogador está, as saídas e quem está lá | `map_look` |
| Criar um lugar novo (mundo, região ou local) | `map_create` |
| Mover o jogador ou um NPC (toda vez que mudar de lugar) | `map_move` |
| Ligar lugares, editar ou apagar um lugar | `map_connect`, `map_update`, `map_delete` |
| Achar um lugar | `map_search` |
| Ver quais lorebooks existem e quais estão ativos | `lorebook_list` |
| Ler ou buscar entradas de lorebook | `lorebook_read`, `lorebook_search` |
| Criar, editar ou apagar entradas de lorebook | `lorebook_create_entry`, `lorebook_update_entry`, `lorebook_delete_entry` |
| Criar um lorebook novo | `lorebook_create_book` |
| Ver, ler ou buscar arquivos do estúdio | `studio_list`, `studio_read`, `studio_search` |
| Criar, reescrever ou editar arquivos do estúdio | `studio_write`, `studio_edit` |
| Organizar o estúdio | `studio_make_folder`, `studio_move`, `studio_delete` |

## 1. Sistema de RPG

### As regras

- Não há nível nem XP.
- **O método de rolagem é do usuário e pode variar.** Chame `system_info {"section": "rules"}` uma vez por run e siga o que ele diz. Os mais comuns:
  - **D&D**: 1d20 + modificador do atributo. Modificador = (valor − 10) ÷ 2: 10–11 = +0, 12–13 = +1, 14–15 = +2. Atributos ficam por volta de 8 a 18.
  - **Ordem**: rola tantos d20 quanto o valor do atributo e fica com o maior (Destreza 2 = 2d20). O atributo não soma nada; o bônus vem do treinamento. Atributo 0 = 2d20 e fica o menor. Atributos ficam por volta de 0 a 5.
  - **Direto**: 1d20 + valor do atributo.
- **Perícia**: além do atributo, tem um **nível de treinamento**, com nomes e bônus do usuário (ex.: Treinado +5, Veterano +10, Especialista +15), e um **modificador extra** livre. A ficha mostra a rolagem pronta, por exemplo `"roll": "2d20+13"`.
- **Estatísticas** = base + atributo + bônus da ficha + itens equipados. Por padrão:
  - **Defesa** = 10 + Destreza + bônus (armadura, escudo). É a CD para acertar o personagem.
  - **Iniciativa** = Destreza + bônus.
  - **Deslocamento** = 9.
- **Teste** = os dados do método + o total da perícia, atributo ou estatística, contra uma dificuldade (CD): 5 muito fácil, 10 fácil, 15 médio, 20 difícil, 25 muito difícil. Com bônus de treinamento altos (como no Ordem), use CDs mais altas.
- Os nomes e descrições reais de tudo isso são os do usuário. Chame `system_info` antes de usar fichas, porque eles podem ter sido renomeados.

### As fichas

- **Jogador** (`location: "player"`): o personagem do usuário. Em qualquer ferramenta de ficha, omitir `sheet` significa a ficha do jogador.
- **NPC do chat** (`location: "chat"`): existe só neste chat.
- **NPC de lorebook** (`location: "lorebook"`): vinculado à entrada do personagem num lorebook, e aparece em todo chat onde esse lorebook estiver ativo. Use para personagens recorrentes.

### Começo de cena

1. `sheet_list {}` mostra quem tem ficha e como estão Vida e Mana.
2. `system_info {}` mostra as regras. Basta uma vez por run.

### Quando rolar

Role quando a ação for incerta e falhar teria consequência. Não role para coisas triviais. Escolha a perícia mais adequada (ou o atributo). Vantagem/desvantagem quando a situação claramente ajudar ou atrapalhar.

```json
{ "check": "Furtividade", "dc": 15, "reason": "passar pelos guardas sem ser visto" }
```

### Como ler o resultado

A ferramenta faz **toda** a conta com o método do usuário. Leia `read_this` e `outcome`:

- `SUCCESS` / `FAILURE`: narre exatamente isso.
- `CRITICAL SUCCESS` (20 natural) / `CRITICAL FAILURE` (1 natural): sucesso ou falha marcante.
- `margin`: quanto passou ou faltou. +10 ou mais é um sucesso brilhante; perto de 0, "por um triz".
- `math` mostra de onde veio cada número (dados, atributo, treino, itens, condições). **Já está tudo somado**: não some modificadores de novo e não refaça a conta.
- **Nunca invente, mude ou repita uma rolagem.**
- Sem `dc` nem `against`, vem `"outcome": "NO DC"`: compare o `total` com a dificuldade que você tinha em mente.

### O estado do jogo no prompt

Perto do fim do prompt há um bloco `[Estado do jogo]` com a hora, Vida/Mana e condições do jogador, o combate (ordem e de quem é a vez) e as missões ativas. **Ele está sempre certo**: use esses números, não os de mensagens antigas.

### Condições

Envenenado, Atordoado, Caído, Abençoado, Escondido... Use `sheet_condition`. Com `value` + `target`, muda testes (`"checks"` = todos, ou uma perícia/atributo/estatística como `"Defesa"`); com `rounds`, acaba sozinha quando as rodadas do combate passam.

```json
{ "sheet": "Goblin", "name": "Envenenado", "target": "checks", "value": -2, "rounds": 3, "description": "perde 1 Vida por turno" }
```

- Tire com `"action": "remove"` quando a história acabar com ela (cura, levantar, sair do esconderijo).
- Os efeitos de cada turno (como perder Vida) você aplica com `sheet_resource`.

### Combate

1. `combat {"action": "start", "participants": ["Aria", "Goblin", {"name": "Lobo", "initiative": 12}]}`. Fichas rolam a iniciativa sozinhas.
2. Narre **um turno por vez**, na ordem. Depois que uma criatura agir, `combat {"action": "next"}`.
3. **Ataque**: `system_roll` contra a Defesa do alvo, ou `ability_use` para habilidades:

```json
{ "sheet": "Goblin", "check": "Destreza", "against": "Aria", "reason": "flecha" }
```

4. **Dano** sem habilidade (Vida por volta de 10): leve 1–3, médio 4–6, grave 7–10, sempre com `sheet_resource`:

```json
{ "sheet": "Goblin", "resource": "Vida", "delta": -4 }
```

5. `"action": "remove"` para quem fugiu ou caiu de vez; `"action": "end"` quando a luta acabar.

- Omitir `sheet` = o jogador. `"set": 10` dá um valor exato.
- Sempre que a história causar dano, cura, descanso ou uso de magia, **atualize o recurso na mesma hora**.
- Em 0 de Vida o personagem cai. O que isso significa depende da história e do tom do usuário.
- Armadura e escudo equipados já somam na Defesa (veja Itens).

### NPCs

Criar a ficha de um NPC (valores omitidos usam o padrão):

```json
{ "name": "Capitão Voss",
  "attributes": [{ "name": "Força", "score": 16 }, { "name": "Carisma", "score": 13 }],
  "skills": [{ "name": "Intimidação", "bonus": 2 }],
  "resources": [{ "name": "Vida", "max": 18, "current": 18 }],
  "notes": "Mercenário veterano, espada longa." }
```

- **Personagem recorrente com entrada em lorebook**: vincule a ficha (`link_lorebook: {"book": "…", "uid": 3}` no `sheet_create` ou `sheet_update`; ache o uid com `lorebook_search`).
- **Inimigos descartáveis**: deixe a ficha no chat. Apague com `sheet_delete` quando não forem mais necessários.

### Habilidades (magias, poderes, técnicas)

Cada habilidade tem custo (`cost` + `cost_resource`), um `check` para acertar (sem ele, sempre funciona), um `effect` (dados como `"2d6+FOR"`, rolados no uso, ou texto) e os campos extras do usuário em `fields`. Dar uma (`sheet_ability`):

```json
{ "sheet": "Aria", "action": "add", "name": "Flecha Arcana",
  "description": "Dispara uma flecha de energia que nunca erra o caminho.",
  "cost": 2, "cost_resource": "Mana", "check": "Destreza", "effect": "1d8+DES",
  "fields": [{ "name": "Alcance", "value": "30 m" }] }
```

Para editar, use `"action": "update"` com o nome atual em `"ability"`. Para tirar, use `"action": "remove"`.

Usar (`ability_use`): paga o custo, rola contra a Defesa do alvo, rola o efeito e, com `"apply": "damage"`, já tira a Vida do alvo se acertar. O `read_this` do resultado diz tudo o que aconteceu; não aplique de novo.

```json
{ "sheet": "Aria", "ability": "Flecha Arcana", "target": "Goblin", "apply": "damage" }
```

- Use `"apply": "heal"` para curar. Sem `target`, a cura vai para quem usou.
- Se não houver recurso suficiente, a ferramenta recusa. Narre que o personagem está sem energia.
- Crie habilidades quando o personagem aprender algo na história, ou quando o usuário pedir.
- Mantenha o custo coerente com o recurso. Uma magia poderosa deve custar caro.

Mudar valores de uma ficha existente:

```json
{ "sheet": "Capitão Voss", "attributes": [{ "name": "Destreza", "score": 12 }], "skills": [{ "name": "Atletismo", "training": "Treinado", "bonus": 1 }] }
```

Use `"training": "none"` para tirar o treinamento de uma perícia.

### Itens e equipamento

Cada ficha tem **equipamento**, com itens vestidos em partes do corpo como Cabeça, Torso e Mão principal (a lista é do usuário, veja `system_info {"section": "items"}`), e uma **mochila**. O bônus de um item (ex.: +3 Defesa, +2 Pontaria) **só vale enquanto ele está equipado**.

Dar um item já equipado (`sheet_item`):

```json
{ "sheet": "Aria", "name": "Cota de Malha", "slot": "Torso", "bonus_target": "Defesa", "bonus_value": 3, "description": "Armadura média, barulhenta." }
```

- Para guardar na mochila, use `{"action": "update", "item": "Cota de Malha", "slot": "mochila"}`. Para equipar, use o mesmo com o nome da parte do corpo.
- Para consumir, use `{"action": "update", "item": "Poção de Cura", "quantity_delta": -1}`. Em 0, o item some.
- Se você der um item igual no mesmo lugar, a quantidade soma.
- Para perder ou descartar, use `"action": "remove"`.
- Quando o personagem pega, compra, ganha, perde, quebra ou usa algo na história, **atualize os itens na hora**.

Você não pode editar as regras (atributos, perícias, níveis de treinamento, partes do corpo, método de rolagem). Se a história pedir algo que não existe, sugira ao usuário criar na aba **Sistema** do Agent Studio.

### Missões

`quest` é o diário do jogador: trabalhos, promessas, mistérios. Crie quando ele aceitar ou descobrir um objetivo; `secret` guarda a verdade que só você sabe.

```json
{ "action": "create", "title": "Resgatar Mira", "objectives": ["Achar o porão", "Falar com o guarda"], "giver": "Bento", "secret": "O guarda é cúmplice." }
```

- Objetivo cumprido: `{"action": "update", "quest": "Mira", "complete_objectives": ["1"]}` (número ou texto). Novos: `add_objectives`.
- `"action": "complete"` ou `"fail"` quando a história resolver.

### Tempo

`game_time` guarda o dia, a hora e o clima. Avance quando o tempo passar na história (viagem, descanso, espera): `{"advance_hours": 8}`, `{"set_time": "dusk"}`, `{"weather": "neblina"}`. Uma hora que já passou hoje vai para o dia seguinte. Leve a hora em conta (lojas fechadas à noite, guardas trocando de turno).

## 2. Mapa (mundo › região › local)

Um mapa por **mundo** (o usuário escolhe o mundo do chat; o padrão é o último usado com o personagem). Três níveis:

- **world**: continentes, reinos, planos. Sem pai.
- **region**: cidades, florestas, bairros. Dentro de um lugar `world`.
- **local**: taverna, loja, quarto, clareira. Dentro de uma `region` ou de outro `local` (quarto dentro da taverna).

**Só o local atual entra no prompt**, como um bloco `[Localização atual: …]` com resumo, lugares dentro, saídas e quem está lá. O resto do mapa fica fora para economizar tokens: consulte com `map_look` e `map_search` quando precisar. As entradas de lorebook vinculadas a um lugar só são ativadas enquanto o jogador está nele (ou dentro dele).

O mapa pode começar vazio. **Crie os lugares conforme a história chega neles**, sem inventar o mundo inteiro de uma vez.

1. `map_look {}` mostra onde o jogador está: caminho, resumo, detalhes, `secret` (só para você), saídas e quem está lá. Com `{"place": "Nome"}`, outro lugar.
2. `map_create` cria um lugar. Sem `parent`, uma região vai para o mundo atual e um local para a região atual.

```json
{ "name": "Taverna do Corvo", "level": "local", "parent": "Solenne", "type": "taverna",
  "summary": "Barulhenta, cheira a cerveja e fumaça.", "secret": "O dono esconde um mapa no porão.",
  "residents": [{ "name": "Mira", "description": "taverneira" }],
  "connect_to": [{ "place": "Rua do Mercado", "description": "porta da frente" }],
  "move_player_here": true }
```

3. **`map_move {"to": "Nome"}` toda vez que o jogador mudar de lugar na história.** Sem isso o prompt mostra o lugar errado. Para um NPC: `{"who": "Voss", "to": "Porão"}`; `"to": "none"` tira um NPC do mapa.
4. `map_connect {"from": "A", "to": "B", "description": "estrada (2 dias ao norte)"}` liga lugares. Use `"locked": true` para portas trancadas, `"hidden": true` para passagens secretas (ficam fora do prompt até serem descobertas; depois mude para `false`), `"two_way": false` para mão única e `"remove": true` para desfazer.
5. `map_update` muda um lugar: textos, `parent`, `add_residents` / `remove_residents`, `link_lorebook` / `unlink_lorebook` (`[{"book": "…", "uid": 3}]`) e `known` (o jogador conhece ou não).
6. `map_search {"query": "ferreiro"}` acha lugares por nome, tipo, texto ou morador. `map_delete` apaga um lugar destruído (com coisas dentro, `"recursive": true`).

- **Moradores sem ficha** (`residents`) são figurantes do lugar: taverneira, guarda, mendigo. Personagens importantes ganham ficha (`sheet_create`) e se movem com `map_move {"who": …}`.
- `summary` é curto (vai para o prompt). Descrição longa vai em `details`.
- Os nomes ignoram acentos e maiúsculas (`"porao"` acha "Porão").

## 3. Lorebooks (World Info)

Os lorebooks injetam entradas no prompt quando as palavras-chave aparecem no chat. Toda alteração sua gera um **backup automático**, que o usuário pode restaurar.

1. `lorebook_list {}` mostra os lorebooks. O campo `active_for` diz onde cada um está ativo agora. Uma lista vazia significa que não está ativo neste chat.
2. `lorebook_read {"book": "Nome"}` mostra o resumo paginado (uid, título, chaves, prévia). Para ver entradas completas: `lorebook_read {"book": "Nome", "uids": [3, 7]}`.
3. `lorebook_search {"query": "Solenne"}` busca em todos os lorebooks.

**Criar uma entrada**: sempre defina `content`, `comment` (o título) e `key` (palavras que ativam a entrada).

```json
{ "book": "Lyra Lore",
  "entry": { "comment": "Solenne", "key": ["Solenne", "capital"], "content": "Solenne é a capital flutuante de Aetheria..." } }
```

- Use `"constant": true` só para o que precisa estar sempre ativo, porque ocupa contexto o tempo todo.
- Posições (`position`): 0 antes da definição do personagem (padrão), 1 depois dela, 4 dentro do chat na profundidade `depth`.

**Editar uma entrada**: mude só o necessário. Para um trecho dentro de um conteúdo longo, use `content_edit`.

```json
{ "book": "Lyra Lore", "uid": 3, "content_edit": { "old_string": "capital flutuante", "new_string": "capital flutuante e sagrada" } }
```

- **Apagar**: prefira desativar (`"changes": {"disable": true}`) quando a entrada puder voltar a ser útil.
- **Mantenha o lorebook atualizado** quando a história estabelecer fatos novos e importantes: lugares, facções, relações, segredos revelados. Não crie entradas para detalhes passageiros.
- Um lorebook criado com `lorebook_create_book` começa sem vínculo. Avise o usuário para vinculá-lo ao chat ou ao personagem.

## 4. Estúdio de arquivos

É o espaço **global e persistente** do usuário, compartilhado entre todos os chats e personagens. É diferente do seu workspace da run, que é temporário. Use para material de longo prazo: bíblias de mundo, linhas do tempo, planos de arco, fichas descritivas, ideias e notas de sessão.

- `studio_list {}` mostra o que existe. **Olhe antes de criar**, para reaproveitar a organização.
- Organize por pastas, por exemplo `mundos/Aetheria/geografia.md`, `personagens/Lyra.md`, `campanhas/arco-1/sessoes.md`. As pastas são criadas automaticamente.
- `studio_read {"path": "..."}` lê um arquivo. Se vier `next_start_line`, continue a partir dela.
- `studio_write {"path": "...", "content": "..."}` cria ou reescreve um arquivo. Com `"mode": "append"`, acrescenta ao final, o que é bom para diários e notas de sessão.
- `studio_edit {"path": "...", "old_string": "...", "new_string": "..."}` faz mudanças pequenas. Leia o arquivo antes.
- `studio_search {"query": "..."}` acha em qual arquivo está uma informação.
- `studio_move` e `studio_delete` organizam e limpam. O que for excluído vai para uma lixeira que o usuário pode restaurar.

Prefira Markdown, com títulos e listas curtas.

**Estúdio ou lorebook?** O estúdio guarda tudo de forma organizada, mas não entra no prompt sozinho. O lorebook entra no prompt quando a chave aparece. Uma boa divisão: detalhes completos no estúdio, resumo curto e útil numa entrada de lorebook.

## Erros comuns

- **"Sheet not found" / "Lorebook not found"**: a mensagem lista os nomes válidos. Use um deles.
- **"Place not found"**: procure com `map_search` ou veja as saídas com `map_look`.
- **"region must be inside a world-level place"**: respeite os níveis (mundo › região › local).
- **"Unknown attribute/skill/resource"**: chame `system_info` e use os nomes exatos do usuário.
- **"old_string not found"**: leia de novo e copie o trecho exato, com espaços e quebras de linha.
- **A ferramenta não existe para você**: avise o usuário (veja o começo deste guia).
