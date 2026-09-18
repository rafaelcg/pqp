Dá pra migrar a estrutura do seu servidor do Discord pro pqp em poucos minutos: você cola o link de um Discord Guild Template ao criar uma comunidade, e o pqp recria as categorias, os canais e os cargos automaticamente. Não é um login no Discord nem um bot instalado lá, é uma cópia de layout de uma direção só.

Esse guia mostra exatamente o que é copiado, o que fica pra trás, e o passo a passo dos dois lados.

## O que é um Guild Template, rapidinho

Um Guild Template é um recurso do próprio Discord: um servidor pode gerar um link público (algo como `discord.new/AbCdEf`) que descreve a estrutura dele, sem dados de membro nenhum. É pensado pra alguém criar um servidor novo parecido com o seu. O pqp lê esse mesmo link.

## O que é copiado de verdade

- Nome do servidor
- Categorias, canais de texto e canais de voz, na mesma ordem da barra lateral
- Nomes dos canais exatamente como estão no Discord, emoji e espaço incluídos
- Tópicos dos canais, cortados em 200 caracteres
- Cargos: nome, cor, se aparece destacado na lista, se é mencionável, e as permissões mapeadas pro equivalente do pqp (nunca a permissão de Administrador total)
- Overwrites de privacidade por canal e por categoria (um canal marcado como privado no Discord continua privado no pqp)
- O ícone do servidor, quando o template tiver um e o armazenamento de arquivos estiver ligado na instância

## O que fica pra trás

Não está no template do Discord, então não tem como copiar:

- Membros, mensagens, anexos, emoji customizado, webhooks, bans e convites do Discord

O pqp também simplifica algumas coisas que não têm equivalente direto:

- NSFW, slow mode, bitrate de voz, tags de fórum, threads e canais de diretório não são copiados
- Cargos com nome que não dá pra sanitizar pro padrão do pqp (letras, números, underscore) ficam de fora
- Cargos chamados `everyone`, `here`, `Owner`, `Admin`, `Manager` ou `Moderator` não são recriados, porque esses nomes já existem por padrão no pqp
- Canais de anúncio, fórum e mídia viram canais de texto; canais de palco viram canais de voz

## Passo a passo

**No Discord:**

1. Vá em Configurações do servidor → Modelos (Templates).
2. Crie um modelo, se ainda não tiver um.
3. Copie o link gerado (começa com `discord.new/`).

**No pqp:**

1. Clique em criar uma comunidade.
2. Escolha **Copiar um layout do Discord**.
3. Cole o link do template.
4. Confira a prévia: a árvore de categorias e canais, o que é privado, e o que vai ficar de fora.
5. Confirme. O pqp cria a comunidade inteira numa transação só, e mostra um link de convite pra você mandar pra sua galera.

O servidor original no Discord não muda em nada durante esse processo. Nada é apagado, alterado ou acessado lá.

## Depois de migrar o layout

A estrutura chega pronta, mas a comunidade começa vazia de gente: convide os membros mandando o link gerado no último passo. Se a sua comunidade também tem presença na Twitch ou YouTube, veja [chat de voz para comunidade de streamer](/blog/chat-de-voz-para-comunidade-de-streamer) pra pensar em como organizar os canais pra isso, e compare o que muda de verdade indo do Discord pro pqp em [pqp vs Discord em 2026](/blog/pqp-vs-discord-2026).

## Perguntas frequentes

**Isso é um login no Discord ou um bot no meu servidor?**
Nenhum dos dois. Você cola um link público de template (discord.new/…), o pqp lê a estrutura dele e cria uma comunidade nova. Não entra na sua conta do Discord, não vira bot, e o Discord original não muda em nada.

**O que é copiado de verdade?**
Nome do servidor, categorias, canais de texto e voz na mesma ordem, os nomes dos canais com emoji e espaço incluídos, tópicos, cargos com cor e permissões básicas mapeadas, overwrites de privacidade e o ícone do servidor quando disponível.

**O que fica pra trás?**
Membros, mensagens, anexos, emoji customizado, webhooks, bans e convites do Discord: nada disso está no template, então nada disso é copiado. Canais de fórum, anúncio e palco viram texto ou voz, o que for mais parecido.

**Como eu pego o link do template?**
No Discord: Configurações do servidor → Modelos → cria e copia o link (começa com discord.new/). No pqp: criar comunidade → Copiar um layout do Discord → cola o link → confere a prévia → confirma.

## Comece a migração

Se o seu servidor do Discord já tem um Guild Template, o processo inteiro leva menos tempo do que recriar a estrutura na mão. [Crie sua comunidade no pqp](/garanta) e cole o link quando pedir o layout.
