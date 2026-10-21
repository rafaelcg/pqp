# Como um app funciona

Esta página é o desenho inteiro num lugar só. As outras páginas de Conceitos dão zoom em cada pedaço.

## Três partes

```text
 ┌─────────────────────────┐          ┌──────────────────────────┐          ┌────────────────────────┐
 │  Teu app                │          │  A página do pqp         │          │  O servidor do pqp     │
 │  um iframe, sandbox     │◄────────►│  "o host"                │◄────────►│  Postgres, WebSocket   │
 │  na origem dos apps     │ Message  │  pqp.gg, no navegador    │  frames  │  assentos, estado,     │
 │  NÃO CONFIÁVEL          │  Port    │  confere toda mensagem   │  do /ws  │  eventos. Confere tudo │
 └─────────────────────────┘          └──────────────────────────┘          └────────────────────────┘
```

- **Teu app** é um bundle estático (HTML, JS, CSS) servido de um site separado, a *origem dos apps*, e mostrado num `<iframe>`. O pqp trata ele como código não confiável, porque foi outra pessoa que escreveu.
- **A página do pqp** é o client web que a pessoa já tem aberto. No protocolo ela se chama **o host**. É dona do iframe, é a única que fala com ele e fala com o servidor por ele.
- **O servidor do pqp** é a fonte da verdade: quem tá na sessão, qual é o estado compartilhado, em que ordem as escritas aconteceram.

O teu código só fala com a do meio. Ele nunca faz uma requisição de rede, e nunca descobre quem alguém é além de um nome e um avatar.

::: tip Dois sentidos de "host"
No protocolo da ponte, **o host** é a página do pqp. Numa sessão, **quem começou a sessão** é a pessoa que iniciou (`isHost` num participante, `app.hello.self.isHost`). Estas páginas dizem "a página" e "quem começou a sessão" pra não misturar.
:::

## Uma sessão, do começo ao fim

1. **Alguém começa.** No campo de mensagem, o launcher de apps lista o que pode rodar neste canal. Começar um manda `POST /api/channels/:id/app-sessions`. O servidor confere se a pessoa pode (a permissão `USE_APPS`, e se o app tá [disponível](/publishing/review) ali), cria a sessão, fixa a **versão** do app que é a atual nesse instante e põe um card na conversa. Quem começou é o host da sessão.
2. **Os outros entram.** Tocar no card manda um frame de entrada. O servidor dá pra cada pessoa um **assento**: um id aleatório que é dela nessa sessão, um papel (`player`, ou `spectator` depois do limite de jogadores) e um lugar na lista.
3. **A página monta o teu app.** Ela cria `<iframe sandbox="allow-scripts">` apontando pra `<origem dos apps>/<id>/<versão>/index.html`. A janelinha tá em outro site, então não alcança a página, e a página só é alcançada por ela por um canal.
4. **Teu app conecta.** O `connect()` manda um hello pro pai. A página responde com uma ponta de um `MessageChannel` e confere que o hello veio *daquele* iframe. Daí pra frente tudo viaja na porta. A primeira mensagem da página nela é o `hello`: teu assento, o idioma, o tema.
5. **Teu app lê e escuta.** `participants.get()`, `state.get()` e listeners pro que mudar.
6. **Teu app escreve.** `state.patch({ count: 6 }, { baseRev: 5 })` vai pra página. Ela confere contra o **teu manifest** (a pessoa pode escrever, o resultado cabe em `state.maxBytes`, tá dentro do limite de ritmo) e manda pro servidor como um frame. O servidor aplica o merge patch com um lock, sobe a revisão e transmite o valor novo inteiro pra todos os assentos. A página de cada pessoa empurra isso pro app dela.
7. **Termina.** Quem começou encerra, ou um moderador, ou ela expira por inatividade, ou todo mundo sai. O estado compartilhado é **apagado**; o que tu quer deixar na conversa, deixa em `state.result` antes de acabar. O card vira um registro discreto.

```text
 clica +1 no teu app
   → state.patch({count:6}, {baseRev:5})      porta ── a página: manifest, ritmo, tamanho
   → frame app-state-patch                     /ws ── o servidor: lock, merge, rev 6, tamanho
   ← app-state {rev:6, value:{count:6}}        /ws ── pra todos os assentos
   ← push de state                             porta ── dentro do app de cada pessoa
```

## Por que cada parte confere

A página e o servidor aplicam o manifest os dois, e a página ainda lê toda mensagem com um schema estrito. Parece redundante. É de propósito: teu app não é confiável, então a página não repassa o que ele manda; e a própria página roda no navegador da pessoa, então o servidor não confia na página. Um app malicioso pode mentir pra página e recebe `invalid` ou `not-allowed`. Um client modificado pode mentir pro servidor e não recebe nada.

## Onde cada peça fica no repositório

| Peça | Onde |
|---|---|
| O SDK que o teu app importa | `packages/app-sdk/` |
| O schema e o validador do manifest | `packages/shared/src/apps/manifest.ts` |
| O protocolo de mensagens (a ponte) | `packages/shared/src/apps/bridge.ts` |
| O lado da página: iframe, host da ponte, tema | `client/src/lib/apps/`, `client/src/components/apps/` |
| O lado do servidor: sessões, assentos, estado | `server/src/apps/`, `server/src/ws/apps.ts` |
| O packager e o servidor de dev | `tools/apps-build/` |
| A referência interna de onde este site saiu | `docs/APPS.md` |

Próximo, em inglês: [a sandbox](/concepts/sandbox) e depois [a ponte](/concepts/bridge).
