# Contribuindo com o pqp

> [English version](./CONTRIBUTING.md)

Valeu por querer ajudar. O pqp é feito nas horas vagas, então um bom relato de
bug vale tanto quanto um patch, e falar que alguma coisa tá confusa vale mais
que os dois.

Pode abrir issue e PR em português. A gente responde nos dois idiomas. O resto do
repositório tá em inglês só porque o código tá.

## Antes de escrever código

**Coisa pequena e óbvia?** Manda o PR direto. Um typo, um link quebrado, um bug
claro com uma correção clara. Não precisa perguntar antes.

**Maior que isso?** Abre uma issue e fala com a gente primeiro. Não é burocracia:
o projeto tem opiniões que não dá pra adivinhar de fora, e a gente prefere
discordar de você antes de você gastar um fim de semana do que depois. Uma
funcionalidade que funciona bem mas puxa o produto pra um lugar onde a gente não
quer ir é o pior resultado possível, e a culpa é nossa se deixamos você
construir.

**Relatar em vez de consertar também é contribuição.** Se você usou o pqp com os
seus amigos e alguma coisa incomodou, fala. A gente tem muito pouco desse tipo de
retorno e é a coisa mais difícil de conseguir.

**Dá uma olhada [nas issues abertas](https://github.com/rafaelcg/pqp/issues)
primeiro.** Elas são a versão ranqueada do que a gente quer de verdade, tiradas
do [`docs/DISCORD_GAPS.md`](./docs/DISCORD_GAPS.md), que compara o pqp com o
Discord funcionalidade por funcionalidade. Qualquer uma marcada com
`good first issue` é pequena, isolada e difícil de errar. Pegar uma de lá
significa que você já tem um sim antes de começar.

## Rodando local

```bash
pnpm install
cp .env.example .env
cp .env.example client/.env
docker compose up -d postgres
pnpm dev
```

Cliente em http://localhost:5173, servidor em http://localhost:3001.

Você não precisa de chave do Clerk pra mexer na maior parte das coisas. Coloca
`DEV_AUTH_BYPASS=true` no `.env` da raiz e `VITE_DEV_AUTH_BYPASS=true` no
`client/.env`, e reinicia o servidor. O bypass é ignorado quando
`NODE_ENV=production`.

Pra anexos ou pra suíte e2e você também precisa do MinIO:

```bash
docker compose --profile storage up -d postgres minio minio-init
```

## Quatro coisas que vão te fazer perder tempo se ninguém avisar

Não são preferências de estilo. Cada uma dessas já custou uma hora de alguém.

**1. Builda o `@pqp/shared` antes de rodar os testes.**

```bash
pnpm --filter @pqp/shared build
```

Um build velho do pacote shared gera falhas de teste no client que não têm nada a
ver com a sua mudança. Se der erro em arquivo que você nem encostou, roda isso
antes e tenta de novo, antes de sair debugando.

**2. A suíte e2e precisa do MinIO rodando.** Sem ele você recebe falhas que
parecem bug da aplicação e não são.

**3. O texto fica em dois catálogos, e não tem travessão.**
`client/src/locales/en/translation.json` e `client/src/locales/pt-BR/translation.json`
precisam ter todas as chaves, os dois. Tem um teste que quebra o build se
aparecer travessão em qualquer um dos dois. Isso é de propósito: não é a voz em
que o produto é escrito. Usa vírgula, ponto, ou reescreve a frase. Detalhes em
[`docs/I18N.md`](./docs/I18N.md).

Parte do texto de marketing tá duplicada em `client/src/lib/marketing-meta.ts`,
porque o middleware do Cloudflare Pages que injeta as tags de SEO não consegue
ler o catálogo do i18n. Um teste prende as duas cópias, então se você editar o
texto num lugar só e o CI reclamar, é por isso.

**4. Mexer em `packages/` reinicia a API de produção e derruba todas as calls que
estiverem acontecendo.** O servidor compila o `@pqp/shared` dentro dele, então
mudança lá é mudança de servidor mesmo quando a funcionalidade é 100% client.
Isso não é motivo pra evitar, só avisa no PR pra dar pra mergear numa hora
decente. Detalhes em [`docs/DEPLOY.md`](./docs/DEPLOY.md).

## Antes de abrir o PR

```bash
pnpm --filter @pqp/shared build
pnpm -r typecheck
pnpm --filter @pqp/client test
pnpm --filter @pqp/client i18n:check
pnpm lint
```

Tem uns warnings antigos de `react-hooks/exhaustive-deps` sobre o `t`. Não são
seus, deixa quietos.

## Sobre testes

Escreve um quando a coisa que você consertou pode voltar. Não escreve um só pra
aumentar o número.

O erro que vale nomear: teste que verifica uma propriedade em vez do
comportamento. Vídeo é o caso clássico. Um `<video>` ligado a uma track remota
morta continua reportando `readyState: 4`, continua tendo `srcObject`, continua
visível, e mostra um retângulo preto. Um teste que verifica qualquer uma dessas
passa numa call quebrada. O `client/e2e/screen-reshare.spec.ts` mede frames
decodificados, e o comentário no topo explica por quê. Esse é o padrão.

A suíte unitária do client roda em Node sem DOM, então interação de componente
não dá pra testar direto. Extrai a decisão pra uma função pura e testa ela, do
jeito que o `screen-fullscreen.ts` e o `video-quality.ts` fazem.

## Nunca commita

Valor de segredo de verdade, em código, teste, doc ou mensagem de commit. Nem
expirado, nem como exemplo. Usa só o nome da variável. O `.env` tá no gitignore e
é pra continuar assim.

## Licença, e sendo direto com você sobre dinheiro

O pqp é **AGPL-3.0-only**. A sua contribuição entra sob essa mesma licença, e o
copyright do que você escreveu continua sendo seu. Assina os teus commits pra
dizer que você tem o direito de contribuir aquilo:

```bash
git commit -s -m "sua mensagem"
```

Isso adiciona uma linha `Signed-off-by`, que é o
[Developer Certificate of Origin](https://developercertificate.org/). É uma
declaração de que o trabalho é seu pra dar. **Não** transfere nada pra gente.

**A parte que você merece saber logo de cara:** o pqp.gg é um serviço hospedado e
pode cobrar dinheiro em algum momento, por hospedagem, limites maiores ou
suporte. A AGPL não impede isso, e significa que contribuição pra esse
repositório pode acabar num serviço que gera receita. Isso é normal em código
aberto e a gente prefere falar na lata do que você descobrir depois.

O que isso também significa no outro sentido: qualquer pessoa pode rodar o pqp
por conta própria, de graça, pra sempre, com todas as funcionalidades. Se alguém
rodar uma versão modificada como serviço, a AGPL obriga a publicar as mudanças.
Essa proteção vale pras suas contribuições exatamente como vale pras nossas.

Se algum dia o pqp precisar ser licenciado em outros termos pra alguém, isso
exige permissão de todo mundo que tem copyright nele, incluindo você. A gente não
tá pedindo essa permissão adiantado.

## Review, e a parte honesta sobre o "não"

**Todo PR é revisado e mergeado por um mantenedor.** Nada entra na `main`
sozinho, incluindo o nosso próprio trabalho. Isso aqui é projeto paralelo, então
espera dias em vez de horas, e cutuca a gente se ficar quieto. Isso não é falta
de educação, ajuda.

**Alguns PRs vão ser recusados, e vale dizer o porquê adiantado.** Quase nunca
porque o código tá ruim. Geralmente porque a funcionalidade puxa o pqp pra um
lugar onde a gente não quer ir de propósito, ou porque tá certa mas não agora. As
duas coisas são decisão sobre o produto, não julgamento sobre você nem sobre o
seu trabalho.

A gente prefere falar isso antes de você construir do que depois, que é o motivo
inteiro da regra de "fala com a gente primeiro" lá em cima e de manter a lista de
issues pública. Se você pergunta e a gente diz não, você perdeu cinco minutos. Se
você constrói um fim de semana e a gente diz não, os dois perderam, e essa é
culpa nossa por não ter respondido antes.

Então: pergunta cedo, pergunta qualquer coisa, e trata resposta demorada como
resposta demorada em vez de indireta. Se um PR for recusado a gente fala o motivo
com todas as letras, e isso não quer dizer que o próximo vai ser.
