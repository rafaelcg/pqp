import { Link } from "react-router-dom";
import type { LegalDocument } from "./document";

/**
 * Aviso de cookies em português do Brasil. Tradução de `cookies.en.tsx`; veja
 * as notas de registro e de terminologia em `terms.pt-BR.tsx`.
 *
 * Os nomes das chaves de armazenamento (`pqp-theme`, `pqp-appearance`,
 * `pqp-accent-hue`, `pqp-contrast`, `pqp:locale`…) e os
 * domínios são identificadores técnicos e ficam idênticos ao inglês — traduzir
 * um deles tornaria a lista inútil para quem for conferir no navegador.
 */
export const cookiesPtBr: LegalDocument = {
  locale: "pt-BR",
  path: "/cookies",
  title: "Aviso de cookies — pqp",
  description:
    "Exatamente quais cookies, chaves de armazenamento local e caches o pqp.gg coloca no seu dispositivo, e quais terceiros o seu navegador contata.",
  heading: "Aviso de cookies",
  updated: "25 de agosto de 2026",
  sections: [
    {
      id: "intro",
      sourceRev: "8837c08b",
      body: (
        <p>
          Este aviso lista tudo o que o <strong>pqp.gg</strong> guarda no seu
          dispositivo e todo terceiro que o seu navegador contata enquanto você
          usa o serviço. É uma lista completa, não um resumo por categoria.
          Instâncias self-hosted podem ser diferentes, dependendo de como foram
          configuradas.
        </p>
      ),
    },
    {
      id: "cookies",
      sourceRev: "5f3ec581",
      heading: "Cookies",
      body: (
        <>
          <p>
            <strong>O app do pqp não define nenhum cookie.</strong> Os únicos
            cookies no pqp.gg vêm do{" "}
            <a href="https://clerk.com" target="_blank" rel="noreferrer">
              Clerk
            </a>
            , o serviço que faz o seu login. O Clerk usa cookies de sessão (e o
            armazenamento próprio dele no navegador) para manter você logado e
            para proteger contra sequestro de sessão. Eles são{" "}
            <strong>estritamente necessários</strong>: bloqueie e você não
            consegue entrar. O Clerk documenta o nome e o prazo de cada cookie
            no site dele.
          </p>
          <p>
            A gente não define cookie de publicidade, cookie de analytics nem
            cookie de rastreamento entre sites de tipo nenhum — nem no app, nem
            nas páginas institucionais.
          </p>
        </>
      ),
    },
    {
      id: "local-storage",
      sourceRev: "6fa647e0",
      heading: "Armazenamento local",
      body: (
        <>
          <p>
            Estes ficam guardados pelo seu navegador sob a origem pqp.gg. Ficam
            no seu dispositivo, nunca são usados para publicidade e só podem ser
            lidos pelo pqp.gg.
          </p>
          <ul>
            <li>
              <code>pqp-theme</code> — claro, escuro ou seguir o sistema.
            </li>
            <li>
              <code>pqp-appearance</code> — Sinal, Harmonia, Lareira ou Noite.
              O visual escolhido, separado do claro e do escuro.
            </li>
            <li>
              <code>pqp-accent-hue</code> — uma cor de destaque escolhida, ou
              a do visual.
            </li>
            <li>
              <code>pqp-contrast</code> — padrão, alto, ou seguir o contraste
              do sistema.
            </li>
            <li>
              <code>pqp:locale</code> — o idioma que você escolheu (inglês ou
              português), quando você escolheu algum.
            </li>
            <li>
              <code>pqp-local-settings</code> — entrar com o microfone mudo,
              lista de participantes compacta, qual microfone e qual saída de
              áudio você escolheu, volume de entrada e de saída, e se as prévias
              de link aparecem.
            </li>
            <li>
              <code>pqp-notifications</code> — se você permitiu notificações no
              desktop, e os seus níveis de notificação por servidor e por canal.
            </li>
            <li>
              <code>pqp:collapsed-categories</code> — quais categorias de canal
              você deixou recolhidas na barra lateral.
            </li>
            <li>
              <code>pqp:acquisition</code>: se o link que trouxe você aqui
              veio com parâmetros de campanha (<code>utm_source</code>,{" "}
              <code>utm_medium</code>, <code>utm_campaign</code>,{" "}
              <code>gclid</code> ou <code>ref</code>), esses valores e a página
              em que você chegou, para a gente saber de qual link veio um
              cadastro. Não guarda identificador de tipo nenhum, nunca é lido
              por terceiro, expira em 30 dias, é gravado uma vez só (um link
              de campanha posterior não substitui) e é apagado do seu
              dispositivo na primeira vez que o app carrega depois do seu
              login, quando é enviado uma única vez para a sua conta. Se você
              nunca se cadastrar, ele simplesmente expira.
            </li>
          </ul>
          <p>
            A maior parte dessas configurações também é salva na sua conta no
            nosso servidor, para acompanhar você em outro dispositivo — veja a{" "}
            <Link to="/privacy">Política de Privacidade</Link>. O Clerk também
            guarda entradas próprias aqui, para a sessão.
          </p>
          <p>
            <strong>Rascunho de mensagem não é guardado.</strong> O que estiver
            meio digitado na caixa de mensagem vive na memória da página e some
            quando você fecha a aba.
          </p>
        </>
      ),
    },
    {
      id: "offline-cache",
      sourceRev: "1815d920",
      heading: "Cache offline",
      body: (
        <p>
          O pqp.gg instala um service worker para o app abrir quando você está
          offline ou com uma conexão ruim. Ele guarda os arquivos estáticos do
          próprio app — JavaScript, CSS, HTML e fontes — no Cache Storage do seu
          navegador. <strong>Ele não guarda as suas mensagens.</strong>
        </p>
      ),
    },
    {
      id: "third-parties",
      sourceRev: "aeadd58b",
      heading: "Terceiros que o seu navegador contata",
      body: (
        <>
          <p>
            Não são cookies que a gente define, mas são requisições que o seu
            navegador faz para outras empresas, e cada uma delas revela o seu
            endereço IP para elas. A gente lista aqui para o quadro ficar
            completo:
          </p>
          <ul>
            <li>
              <strong>Clerk</strong> — login e as fotos de perfil servidas de{" "}
              <code>img.clerk.com</code>.
            </li>
            <li>
              <strong>Google Fonts</strong> — as fontes do site carregam de{" "}
              <code>fonts.googleapis.com</code> e{" "}
              <code>fonts.gstatic.com</code> em toda página, inclusive nestas
              páginas legais.
            </li>
            <li>
              <strong>GIPHY e Tenor</strong> — quando um GIF aparece em um canal
              ou no seletor de GIF, a imagem carrega direto dos servidores
              deles.
            </li>
            <li>
              <strong>DiceBear</strong> — as imagens de avatar prontas que
              aparecem em <span lang="en">Settings</span>.
            </li>
            <li>
              <strong>Servidores STUN e TURN</strong> — contatados quando você
              entra em um canal de voz, para negociar a conexão. Inclui
              servidores STUN públicos do Google e da Cloudflare.
            </li>
            <li>
              <strong>O nosso provedor de armazenamento de objetos</strong> —
              quando os anexos de arquivo estão ligados, o seu navegador envia e
              baixa esses arquivos direto do armazenamento.
            </li>
          </ul>
          <p>
            As imagens de prévia de link são a exceção: a gente passa essas pelo
            nosso próprio servidor de propósito, para que abrir um canal não
            conte ao site linkado que você olhou para ele.
          </p>
        </>
      ),
    },
    {
      id: "not-used",
      sourceRev: "16b2487b",
      heading: "O que a gente não usa",
      body: (
        <>
          <p>
            Nenhum pixel de publicidade ou de retargeting, nenhuma gravação de
            sessão, nenhum SDK de relatório de erro, nenhuma impressão digital
            de dispositivo e nenhum serviço de push. As notificações no desktop
            são disparadas localmente pelo seu próprio navegador e não passam
            por mais ninguém.
          </p>
          <p>
            A gente usa o <strong>Cloudflare Web Analytics</strong> para contar
            visitas e medir a velocidade das páginas. Ele está listado aqui, e
            não lá em cima, porque não define cookie e não guarda absolutamente
            nada no seu dispositivo — que é também o motivo de a frase acima, de
            que a gente não define cookie de analytics, continuar verdadeira.
            Ele não usa identificador persistente, então não consegue reconhecer
            você entre visitas nem entre sites. O aviso de privacidade descreve
            exatamente o que ele registra.
          </p>
        </>
      ),
    },
    {
      id: "managing",
      sourceRev: "bedb07ab",
      heading: "Como controlar isso",
      body: (
        <p>
          Você pode limpar cookies, armazenamento local e dados em cache do
          pqp.gg nas configurações do seu navegador, e bloquear requisições a
          terceiros com uma extensão, se preferir. Bloquear os cookies do Clerk
          impede o login. Limpar o armazenamento local reseta o tema, o idioma e
          as preferências de notificação naquele dispositivo, mas não mexe na
          sua conta.
        </p>
      ),
    },
    {
      id: "more",
      sourceRev: "d39ea3d9",
      heading: "Mais",
      body: (
        <p>
          Veja a <Link to="/privacy">Política de Privacidade</Link> para saber
          como a gente lida com dados pessoais, e os{" "}
          <Link to="/terms">Termos de Uso</Link> para o uso do produto
          hospedado.
        </p>
      ),
    },
    {
      id: "contact",
      sourceRev: "8bfc576d",
      heading: "Contato",
      body: (
        <p>
          Dúvida sobre qualquer coisa desta página vai para{" "}
          <strong>contato@pqp.gg</strong> — o endereço único do pqp.gg, lido
          pela única pessoa que toca o projeto.
        </p>
      ),
    },
  ],
};
