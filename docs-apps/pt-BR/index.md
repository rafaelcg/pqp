---
layout: home
title: Faz um app de call numa tarde
titleTemplate: apps do pqp
hero:
  name: apps do pqp
  text: Faz um app de call numa tarde.
  tagline: Uma enquete, um joguinho, um contador, uma jukebox. Um app é uma páginazinha web que o pqp abre dentro de um canal de texto ou de voz. O SDK tem 6 KB e nenhuma dependência.
  image:
    src: /hero-pixel.svg
    alt: Um balão de chat do pqp ligado a uma janelinha de app
  actions:
    - theme: brand
      text: Faz um em 20 minutos
      link: /pt-BR/guide/getting-started
    - theme: alt
      text: Como funciona
      link: /pt-BR/concepts/how-it-works
    - theme: alt
      text: Referência do SDK (em inglês)
      link: /sdk/
features:
  - title: Uma página, um import
    details: Teu app é uma página web normal. Importa o @pqp/app-sdk, chama connect() e tu já tá numa sessão com quem tá no canal.
  - title: Estado compartilhado sem servidor
    details: Todo mundo na sessão vê o mesmo JSON. Tu escreve com um merge patch, o pqp guarda, ordena as escritas e manda pra todos. Tu nunca roda um backend.
  - title: Sandbox desde o começo
    details: Sem rede, sem storage, sem cookie, sem acesso à página em volta. Tu não consegue quebrar o pqp, e quem usa não precisa confiar em ti.
  - title: Com a cara do pqp
    details: O pqp manda os tokens de design, claro ou escuro, como variáveis CSS. Usa eles e teu app acompanha o tema que a pessoa escolheu, sem trabalho nenhum.
  - title: Pessoas, não contas
    details: Tu vê um nome, um avatar e um id de assento aleatório. Nunca um id de usuário, um e-mail, um servidor ou um canal. A privacidade tá no protocolo, não numa promessa.
  - title: Código aberto
    details: O SDK, a sandbox, o packager e os apps que o pqp entrega estão todos no mesmo repositório. Lê como funciona antes de escrever uma linha.
---

## O que é um app do pqp

Alguém num canal de texto ou de voz abre o launcher de apps ao lado da caixa de mensagem e começa um app. Um card aparece na conversa, os outros tocam em **Entrar** e o app roda numa janelinha dentro do pqp. Quando acaba, o card vira um registro discreto do que rolou.

O pqp cuida de tudo em volta do app: o launcher, o card, a linha "Raf tá no Eco" embaixo do nome, quem pode começar, moderação. **Tu escreve o que tem dentro da janelinha.**

Aqui tá um contador compartilhado completo, e essa é a ideia toda:

```ts
import { applyTheme, connect, PqpAppError } from "@pqp/app-sdk";

const app = await connect(); // o handshake com a página do pqp
applyTheme(app.hello.theme); // as cores do pqp como variáveis CSS

const label = document.querySelector("#count")!;
const show = ({ value }: { value: unknown }) => {
  label.textContent = String((value as { count?: number } | null)?.count ?? 0);
};
app.state.on(show); // primeiro os listeners...
show(await app.state.get()); // ...depois o valor de antes deles

document.querySelector("#plus")!.addEventListener("click", async () => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { rev, value } = await app.state.get();
    const count = (value as { count?: number } | null)?.count ?? 0;
    try {
      await app.state.patch({ count: count + 1 }, { baseRev: rev }); // um merge patch, escrito contra a revisão que lemos
      return;
    } catch (error) {
      if (!(error instanceof PqpAppError) || error.code !== "stale-rev") throw error; // alguém foi mais rápido: lê de novo
    }
  }
  console.warn("muita escrita ao mesmo tempo, esse clique não foi aplicado"); // all four attempts lost a race: say so, never drop it silently
});
```

Começa num canal com duas pessoas e o número mexe pros dois. É a mesma engrenagem que uma enquete, um quadro de desenho ou um jogo de cartas usa.

## O que tu ganha

- **Um SDK tipado.** `connect()`, um objeto `PqpApp` com `participants`, `state`, `events`, `assets`, `files`, `ui`, `share`, e o `PqpAppError` com um código que tu consegue tratar. [Referência](/sdk/) (em inglês).
- **Um manifest no lugar de uma página de configuração.** Um JSON diz quantas pessoas, quais tipos de canal, o tamanho do estado compartilhado e o que o app pede pra plataforma. O pqp mostra isso pras pessoas e confere de novo do lado dele.
- **Um packager e um servidor de dev.** `pnpm apps:build` te dá um bundle com hash de integridade e os headers de segurança exatos com que ele vai ser servido. `pnpm apps:dev` serve local e rebuilda quando tu salva.

## Onde isso tá hoje

::: info Status sem enfeite
A plataforma é real e roda atrás de uma flag, servidor por servidor. Os apps que existem hoje foram escritos pelo time do pqp e moram no repositório do pqp: Eco (o app de teste que este site constrói passo a passo), Enquete (uma enquete ao vivo) e Locadora (um emulador retrô, em revisão). **Envio de apps de terceiros e a appstore estão planejados, não construídos.** Hoje, pra fazer e rodar um app teu, tu trabalha num clone do repositório, e o [Primeiros passos](/pt-BR/guide/getting-started) te leva por isso. O pacote npm `@pqp/app-sdk` tá preparado mas ainda não foi publicado.
:::

A [página da appstore](/publishing/appstore) (em inglês) diz o que já tá decidido e o que não.
