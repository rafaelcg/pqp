# Primeiros passos

Tu vai fazer o **Tiny Eco**, um primo menor do [Eco](/examples/eco), o app de teste que o pqp entrega: um contador que todo mundo na sessão mexe junto, um botão de ping e a lista de quem tá ali. Ele passa pelas quatro coisas que todo app faz: conectar, ler o estado, escrever o estado e ouvir os outros. Reserva uns 20 minutos.

::: info Por que tu começa de um clone do repositório
Hoje os apps são construídos dentro do repositório do pqp. O packager, o servidor de dev e o jeito que o pqp carrega um app moram lá, e a pasta do app é um pacote do workspace ao lado dos outros. Publicar o `@pqp/app-sdk` no npm tá preparado mas não foi feito, e o envio de apps de terceiros ainda não existe. A página [Publicar](/publishing/) (em inglês) explica o que isso quer dizer pra ti.
:::

## Antes de começar

Tu precisa de Node 22, pnpm 10, git e Docker (pro banco local). Depois:

```sh
git clone https://github.com/rafaelcg/pqp.git
cd pqp
pnpm install
pnpm --filter @pqp/shared build
```

O segundo comando builda o `@pqp/shared`, o pacote que tem o validador do manifest. O packager importa o resultado dele, então o `pnpm apps:build` dá erro de módulo não encontrado até esse build rodar uma vez. Os comandos daqui pra baixo rodam na raiz do repositório.

## 1. Monta a pasta do app

Um app é uma pasta dentro de `apps/`: um manifest, uma página e um script. Cria `apps/tiny-eco/` com estes arquivos.

O `apps/tiny-eco/package.json` depende do SDK pelo workspace:

<<< ../../snippets/tiny-eco/package.json

O `apps/tiny-eco/tsconfig.json` é TypeScript estrito normal, pro navegador:

<<< ../../snippets/tiny-eco/tsconfig.json

O `apps/tiny-eco/index.html` é a página que o pqp abre na janelinha. Duas regras vêm da sandbox: nada de `<script>` inline, nada de `<style>` inline, nada de atributo `style=` (a [política de segurança](/concepts/sandbox) da janelinha recusa tudo isso, e o packager derruba o build se achar), e todo caminho é relativo:

<<< ../../snippets/tiny-eco/index.html

O `apps/tiny-eco/src/style.css` usa os tokens do pqp, com um valor de reserva pro instante antes deles chegarem:

<<< ../../snippets/tiny-eco/src/style.css

Agora liga o pacote novo no workspace:

```sh
pnpm install
```

Isso põe o teu app no `pnpm-lock.yaml`. Se tu só tá testando o tutorial, `git checkout pnpm-lock.yaml` desfaz quando terminar.

## 2. O manifest

O `apps/tiny-eco/manifest.source.json` é o manifest que tu escreve. É o único lugar que diz o que o app é e o que ele pede pro pqp.

<<< ../../snippets/tiny-eco/manifest.source.json

Os campos que valem a leitura na primeira vez (a [tabela completa](/sdk/manifest) tem o resto):

- **`id`** é permanente e único no mundo todo. **`version`** é SemVer, e um `(id, version)` publicado nunca muda os bytes.
- **`publisher: "pqp"`.** Hoje o `pqp` é o único publisher que existe, e é o que um checkout local libera pra ti (passo 5). Publishers de terceiros chegam com o envio de apps.
- **`platformApi: 1`** é a versão da API de mensagens que o SDK fala. Tem que bater com o teu SDK.
- **`name`, `description`, `presence.*`** não são texto, são chaves do `i18n`. Os três, `pt-BR`, `en` e `es`, são obrigatórios, porque o launcher e a linha de presença ("Raf tá no Tiny Eco") são desenhados na língua de quem tá olhando. O `presence.phrase` tem exatamente um `{name}`.
- **`players`** e **`state`**: até 8 jogadores, quem passar vira espectador, e o estado compartilhado pode ter 1 KB. Pede o que tu precisa: um limite menor é mais fácil de revisar e mais barato de mandar.
- **`capabilities`** é o que o app pede pra plataforma. O Tiny Eco não pede nada além de nome e avatar. Os [capabilities](/concepts/manifest) (em inglês) explicam o resto.
- **`license`** diz uma licença open source e a URL do código. Todo app do pqp é open source.

## 3. O script

`apps/tiny-eco/src/main.ts`:

<<< ../../snippets/tiny-eco/src/main.ts

Lê em quatro partes.

**`connect()`** faz o handshake com a página do pqp e resolve com o objeto do app quando o pqp disse oi. Ele rejeita quando a página não tá dentro de uma janelinha do pqp, e é assim que aparece "Open Tiny Eco inside pqp" se tu abrir o arquivo num navegador sozinho.

**`app.hello`** é o que o pqp te contou no começo: o teu assento na sessão (`self`), o idioma, o tema, o id e a versão do app. O `applyTheme` escreve o tema na página como variáveis CSS, e o `app.on("theme", ...)` mantém tudo em dia quando a pessoa troca de tema.

**Listeners primeiro, depois o `get`.** Um push que chega antes do listener existir não é reenviado. Por isso o script registra `state.on`, `participants.on` e `events.on` logo depois do `connect()`, e só então lê o valor atual com `state.get()` e `participants.get()`. A checagem de `rev` impede que um snapshot velho passe por cima de um novo.

**Escrevendo estado.** O estado compartilhado é um JSON só, e o `state.patch` é um JSON Merge Patch: `{ count: 5 }` muda uma chave e deixa o resto, `null` apaga uma chave. O "+1" é ler, somar, escrever, então duas pessoas clicando juntas podiam se atropelar. Passar o `baseRev` faz a escrita depender da revisão que tu leu, e a página responde `stale-rev` quando alguém foi mais rápido. O laço lê de novo e tenta outra vez. Os eventos (`app.events.send`) são outra coisa: efêmeros, nunca guardados, entregues pros outros na sessão.

## 4. Builda e confere

```sh
pnpm apps:build
```

O packager builda **todos** os apps de `apps/`, então tu recebe uma linha pra cada um:

```text
apps: built pqp-eco@1.0.0 (3 files, manifestSha256 501caa5b6b83)
apps: built pqp-enquete@1.0.0 (3 files, manifestSha256 ff28778e33af)
apps: built tiny-eco@1.0.0 (3 files, manifestSha256 04d23496efb5)
apps: wrote server/src/apps/catalog.json and dist-apps/
```

Isso escreveu três coisas. O `dist-apps/tiny-eco/1.0.0/` tem `index.html`, `index.js` e `index.css`. O `dist-apps/_headers` tem a política de segurança com que esse bundle vai ser servido. O `server/src/apps/catalog.json` ganhou uma entrada pro teu app, e é esse arquivo que o servidor do pqp carrega quando sobe. (O `pnpm apps:check` rebuilda numa pasta temporária e falha se o catálogo commitado tá velho, que é o que o CI roda.)

::: tip Confere o bundle contra a sandbox
Abre o `dist-apps/tiny-eco/1.0.0/index.html`. Todo `<script>` e `<link>` leva um `integrity="sha384-..."` e `crossorigin`. Quem pôs foi o packager. Se a tua página tivesse um script inline, o build tinha parado e dito qual.
:::

O `pnpm apps:build` mexeu num arquivo versionado, o `server/src/apps/catalog.json`. Pra um app que tu só tá testando, volta ele com `git checkout server/src/apps/catalog.json` quando terminar.

## 5. Roda no pqp, local

Sobe o banco e avisa o servidor local que existem apps.

```sh
cp .env.example .env
cp .env.example client/.env
docker compose up -d postgres
```

O `.env.example` já liga o bypass de autenticação de dev (`DEV_AUTH_BYPASS=true`, e `VITE_DEV_AUTH_BYPASS=true` na cópia do client). Isso loga todo navegador como um "Dev User" compartilhado, então tu não precisa de chave do Clerk, e faz o servidor liberar os apps do publisher `pqp` no servidor **Sandbox** quando sobe. Sobram duas linhas no `.env`. Acha o `# APPS=false` comentado e deixa assim:

```sh
APPS=true
```

e acha o `APPS_ORIGIN=` vazio e preenche:

```sh
APPS_ORIGIN=http://localhost:5175
```

Edita as linhas que já existem. Um segundo `APPS_ORIGIN=` colocado no fim do arquivo é ignorado, porque o primeiro ganha. O `APPS=true` liga a plataforma de apps, e o `APPS_ORIGIN` é de onde os bundles são servidos, que é o próximo comando.

Dois terminais:

```sh
# terminal 1: serve o dist-apps em http://localhost:5175 e rebuilda quando tu salva
pnpm apps:dev

# terminal 2: o client do pqp (5173) e o servidor (3001)
pnpm dev
```

Deixa o client na **porta 5173**. Os headers de um bundle só deixam `http://localhost:5173` (e os sites do próprio pqp) colocarem ele numa janelinha, então um client que o Vite empurrou pra outra porta porque a 5173 tava ocupada não consegue mostrar o teu app.

Dá pra conferir que o bundle tá sendo servido do jeito que vai ser em produção:

```sh
curl -sI http://localhost:5175/tiny-eco/1.0.0/index.html
```

A resposta traz o `content-security-policy` com `connect-src 'none'`, o `cache-control` (desligado em dev, imutável em produção), o `access-control-allow-origin: *` e o `referrer-policy: no-referrer`.

Depois abre `http://localhost:5173/app`, entra no servidor **Sandbox** e abre o `#general`. Do lado da caixa de mensagem tem um botão **Apps** (uma gradezinha). O **Tiny Eco** tá no launcher ao lado de Eco, Enquete e Música. Escolhe ele e aperta **Começar**. Um card aparece na conversa: "Dev User começou um app, Tiny Eco, Tu estás dentro", com **Sair** e **Voltar pro app**.

::: warning O que tu vê hoje, e o que vem depois
A parte que mostra o teu app **dentro do canal** (a faixa da sessão e o painel que monta a janelinha em sandbox) tá em revisão no pull request [#1412](https://github.com/rafaelcg/pqp/pull/1412) e ainda não tá no `main`. Até ele entrar, o passo 5 termina no card: a sessão começa e o assento é tomado, mas nenhuma janelinha aparece. Se tu abrir `http://localhost:5175/tiny-eco/1.0.0/index.html` direto, vem "Open Tiny Eco inside pqp.", que é o app se recusando direitinho a rodar fora de uma janelinha. Tudo antes desse passo (o manifest, o build, o catálogo, o launcher, os headers) é real e funciona no `main`, e o bundle do Tiny Eco desta página também rodou dentro de uma janelinha em sandbox de verdade, sob a política de produção, no harness de testes de frame do repositório (a ponte e o SDK de verdade, com uma sessão de mentira) enquanto esta página era escrita: ele conectou, listou duas pessoas, escreveu o contador com `baseRev` e mandou um ping. Este aviso sai quando o #1412 entrar.
:::

### Sendo duas pessoas

Quando o painel entrar, é assim que tu testa um app de duas pessoas. O bypass de dev loga todo navegador como a mesma conta, então duas janelas são uma pessoa só e uma função de duas pessoas parece quebrada. Pra ter uma segunda conta separada, roda isto no console da segunda janela **antes** de carregar o `/app`, e recarrega:

```js
localStorage.setItem("pqp:dev-user-suffix", "bob");
```

Essa janela vira o `dev_user_bob`, com assento próprio. Entra na mesma sessão pelas duas e vê o contador mexer nas duas. Duas abas normais do mesmo perfil do navegador dividem o sufixo, então põe numa aba só.

### O ciclo de edição

Salva um arquivo em `apps/tiny-eco/src/`, espera o `apps: rebuilt` no terminal 1, sai da sessão e entra de novo. Dá pra mudar o script e a página à vontade. Mudar o **manifest** é diferente: o servidor carrega o catálogo uma vez só, quando sobe, e nunca altera uma versão que já tem. Depois de editar o manifest, roda `pnpm apps:build` e reinicia o `pnpm dev`; se tu manteve a mesma `version`, apaga a linha antiga antes pra o manifest novo ser carregado:

```sh
docker compose exec postgres psql -U pqp -d pqp -c "DELETE FROM apps WHERE id = 'tiny-eco'"
```

### Se o Tiny Eco não aparece no launcher, ou não começa

Cada lugar onde um app pode rodar tem portões. Com a plataforma desligada não tem botão **Apps** nenhum; com ela ligada, um tile que não pode começar naquele canal continua na tela com o motivo escrito.

| O que tu vê, ou o motivo | O que significa localmente |
|---|---|
| Sem botão **Apps** do lado da caixa de mensagem (`flag-off`) | O `APPS=true` não tá no `.env`, ou o servidor não foi reiniciado. |
| `no-origin` | O `APPS_ORIGIN` tá vazio. Põe `http://localhost:5175`. |
| `not-live`, `global-off`, `not-allowed-here` | O app não tá liberado. Numa máquina de dev o servidor libera os apps `pqp` no servidor Sandbox quando sobe; reinicia o `pnpm dev` depois do `pnpm apps:build`, e confere que tu tá no Sandbox. |
| `channel-type` | O canal é de um tipo que o manifest não lista. |

## 6. Pra onde ir agora

- Lê [Como um app funciona](/pt-BR/concepts/how-it-works) pra ver o desenho por trás do que tu acabou de fazer.
- Abre o [Eco, passo a passo](/examples/eco) (em inglês) pro mesmo app com os detalhes que um de verdade precisa: idiomas, estado reconectando, estado encerrado e testes.
- Consulta qualquer chamada na [referência do SDK](/sdk/) (em inglês).
- Quando quiser que outras pessoas usem, lê [Publicar](/publishing/) (em inglês).
