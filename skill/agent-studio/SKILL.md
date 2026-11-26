---
name: agent-studio
description: Guia das ferramentas do Agent Studio. Cobre o estúdio de arquivos persistente (studio_*), os lorebooks/World Info (lorebook_*) e o sistema de RPG com fichas, Vida/Mana e testes de d20 (system_*, sheet_*). Leia no começo de qualquer run em que o usuário fale de lore, notas, organizar informações, lorebook, ficha, atributos, perícias, dano, cura, magia, combate ou teste de dado.
version: 0.3.0
author: mvircs1
tags: [agent-studio, rpg, lorebook, world-info]
---

# Agent Studio: como usar as ferramentas

Você tem ferramentas extras deste plugin. Elas estão na sua lista de ferramentas com os nomes abaixo. O nome pode vir com um sufixo como `__2` se houver conflito.

**Chame as ferramentas de verdade.** Não descreva o que faria e não invente valores de ficha, resultados de dado ou conteúdo de lorebook: consulte e altere pelas ferramentas.

Se uma ferramenta desta lista não aparecer para você, diga isso ao usuário. Ele precisa ativar o Profile **Agent Studio Writer** (segurar o botão Agent → *Active Profile*) ou liberar as ferramentas no Profile atual, em Extensões → Agent Studio.

Depois de usar as ferramentas, escreva a resposta da história normalmente no seu arquivo de saída e faça o commit, como sempre. As ferramentas não substituem a resposta.

## Mapa rápido

| Quero… | Ferramenta |
|---|---|
| Ver as regras do RPG (atributos, perícias, recursos) | `system_info` |
| Ver as fichas da cena e a Vida/Mana de todos | `sheet_list` |
| Ver uma ficha completa | `sheet_read` |
| Rolar um teste | `system_roll` |
| Causar dano, curar ou gastar mana | `sheet_resource` |
| Criar um NPC com ficha | `sheet_create` |
| Mudar atributos, perícias, notas ou vincular a lorebook | `sheet_update` |
| Apagar a ficha de um NPC | `sheet_delete` |
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
- **Modificador** = (valor − 10) ÷ 2, arredondado para baixo: 8–9 = −1, 10–11 = +0, 12–13 = +1, 14–15 = +2, 16–17 = +3, 18–19 = +4, 20 = +5.
- **Perícia** = modificador do atributo dela + bônus da perícia. Use bônus 0 para destreinado, 2 para treinado e 4 para especialista.
- **Teste** = d20 + perícia ou atributo, contra uma dificuldade (CD): 5 muito fácil, 10 fácil, 15 médio, 20 difícil, 25 muito difícil.
- Os nomes e descrições reais dos atributos, perícias e recursos são os do usuário. Chame `system_info` uma vez por run antes de usar fichas, porque eles podem ter sido renomeados.

### As fichas

- **Jogador** (`location: "player"`): o personagem do usuário. Em qualquer ferramenta de ficha, omitir `sheet` significa a ficha do jogador.
- **NPC do chat** (`location: "chat"`): existe só neste chat.
- **NPC de lorebook** (`location: "lorebook"`): vinculado à entrada do personagem num lorebook, e aparece em todo chat onde esse lorebook estiver ativo. Use para personagens recorrentes.

### Começo de cena

1. `sheet_list {}` mostra quem tem ficha e como estão Vida e Mana.
2. `system_info {}` mostra as regras. Basta uma vez por run.

### Quando rolar

Role quando a ação for incerta e falhar teria consequência. Não role para coisas triviais.

Escolha a perícia mais adequada, ou o atributo se nenhuma servir. Use vantagem ou desvantagem quando a situação claramente ajudar ou atrapalhar.

```json
{ "check": "Furtividade", "dc": 15, "reason": "passar pelos guardas sem ser visto" }
```

Exemplo para um NPC, com vantagem:

```json
{ "sheet": "Capitão Voss", "check": "Intimidação", "dc": 12, "mode": "advantage" }
```

- **Nunca invente, mude ou repita uma rolagem.** Narre de acordo com `success`.
- `natural: 20` merece um sucesso marcante e `natural: 1` uma falha marcante, mesmo que o total diga outra coisa.

### Combate simples (sugestão, sem matemática pesada)

- **Atacar**: o atacante rola a perícia ou atributo do ataque contra CD = 10 + modificador de Destreza do alvo.
- **Dano**, para personagens com Vida por volta de 10: leve 1–3, médio 4–6, grave 7–10. Aplique sempre com `sheet_resource`.

Dano no jogador (omitir `sheet` = jogador):

```json
{ "resource": "Vida", "delta": -4 }
```

Gasto de mana de um NPC:

```json
{ "sheet": "Lyra", "resource": "Mana", "delta": -3 }
```

Valor exato:

```json
{ "resource": "Vida", "set": 10 }
```

- Sempre que a história causar dano, cura, descanso ou uso de magia, **atualize o recurso na mesma hora**. A ficha precisa refletir a história.
- Em 0 de Vida o personagem cai. O que isso significa (inconsciente, capturado, morto) depende da história e do tom do usuário.
- Mencione as mudanças de forma natural na resposta, por exemplo "(Vida 6/10)".

### NPCs

Criar a ficha de um NPC (valores omitidos usam o padrão):

```json
{ "name": "Capitão Voss",
  "attributes": [{ "name": "Força", "score": 16 }, { "name": "Carisma", "score": 13 }],
  "skills": [{ "name": "Intimidação", "bonus": 2 }],
  "resources": [{ "name": "Vida", "max": 18, "current": 18 }],
  "notes": "Mercenário veterano, espada longa." }
```

- **Personagem recorrente com entrada em lorebook**: encontre a entrada com `lorebook_search`, depois vincule a ficha com `sheet_update {"sheet": "Capitão Voss", "link_lorebook": {"book": "Nome do Lorebook", "uid": 3}}`. Também dá para criar já vinculado, passando `link_lorebook` no `sheet_create`.
- **Inimigos descartáveis**: deixe a ficha no chat. Apague com `sheet_delete` quando não forem mais necessários.

Mudar valores de uma ficha existente:

```json
{ "sheet": "Capitão Voss", "attributes": [{ "name": "Destreza", "score": 12 }], "skills": [{ "name": "Atletismo", "bonus": 2 }] }
```

Você não pode editar as regras (criar ou renomear atributos, perícias e recursos). Se a história pedir algo que não existe nas regras, sugira ao usuário criar na aba **Sistema** do Agent Studio.

## 2. Lorebooks (World Info)

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

## 3. Estúdio de arquivos

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
- **"Unknown attribute/skill/resource"**: chame `system_info` e use os nomes exatos do usuário.
- **"old_string not found"**: leia de novo e copie o trecho exato, com espaços e quebras de linha.
- **A ferramenta não existe para você**: avise o usuário (veja o começo deste guia).
