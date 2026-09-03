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
  updated: "2 de setembro de 2026",
  sections: [
    {
      id: "intro",
      sourceRev: "7e334fe7",
      body: (
        <p>
          Este aviso lista os cookies, as chaves de armazenamento e os
          terceiros que o <strong>pqp.gg</strong> usa hoje. Se uma chave
          faltar, isso é um bug nesta página, não um segredo. Instâncias
          self-hosted podem ser diferentes, dependendo de como foram
          configuradas.
        </p>
      ),
    },
    {
      id: "cookies",
      sourceRev: "0c32195b",
      heading: "Cookies",
      body: (
        <>
          <p>
            <strong>O app do pqp não define nenhum cookie.</strong> Todo cookie
            no pqp.gg vem de um de dois terceiros. O primeiro é o{" "}
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
            O segundo é o{" "}
            <strong>rastreamento de conversão do Google Ads</strong>. O pqp.gg
            compra um pouco de publicidade, e a tag do Google carrega em toda
            página daqui para a gente saber se um anúncio produziu uma conta e
            não só um clique. Ela define cookies de origem própria no domínio
            pqp.gg, com nomes começando em <code>_gcl_</code>, que registram que
            a sua visita chegou por um anúncio e permitem ligar um cadastro
            posterior a ele. Esses <strong>não</strong> são estritamente
            necessários: bloqueie e tudo funciona exatamente igual, e o cadastro
            simplesmente não é contado. O Google documenta o nome e o prazo de
            cada um no site dele.
          </p>
          <p>
            Um evento vai para o Google, uma vez, e só quando uma conta é
            criada: que houve um cadastro. Ele não leva nome, nem e-mail, nem id
            de usuário, nem nada que você digitou. A gente não envia dados da sua
            conta para o Google, não ativou conversões aprimoradas nem nenhum
            cruzamento com dados de clientes, e não roda remarketing nem listas
            de público. Entrar de novo não envia nada.
          </p>
          <p>
            São esses. A gente não define cookie de analytics nem cookie de
            rastreamento entre sites de tipo nenhum, nem no app, nem nas páginas
            institucionais.
          </p>
          <p>
            <strong>Isso vale só para o pqp.gg.</strong> A tag do Google é
            adicionada quando o site hospedado é compilado, e só quando essa
            compilação recebe o id da nossa conta de publicidade. Uma cópia
            self-hosted do pqp não contata nenhum servidor de publicidade do
            Google e não define nenhum cookie do Google.
          </p>
        </>
      ),
    },
    {
      id: "local-storage",
      sourceRev: "8f68d18c",
      heading: "Armazenamento local",
      body: (
        <>
          <p>
            Estes ficam guardados pelo seu navegador sob a origem pqp.gg. Ficam
            no seu dispositivo e só podem ser lidos pelo pqp.gg. Nenhum deles é
            enviado a um anunciante, inclusive o último da lista, que existe
            justamente para impedir que algo seja enviado.
          </p>
          <ul>
            <li>
              <code>pqp-theme</code> — claro, escuro ou seguir o sistema.
            </li>
            <li>
              <code>pqp-appearance</code> — Clássico, Harmonia, Lareira ou Noite.
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
            <li>
              <code>pqp:ads-signup-reported</code>: o identificador da conta
              cujo cadastro já foi contado pela tag de conversão do Google Ads
              descrita acima, para que recarregar o app não conte o mesmo
              cadastro duas vezes. É gravado uma vez, quando você cria uma
              conta, e nunca sai do seu dispositivo. Se você nunca se cadastrar,
              ele nunca chega a ser gravado.
            </li>
            <li>
              <code>pqp-sounds</code> — se os sons de mensagem e de chamada tocam
              neste dispositivo.
            </li>
            <li>
              <code>pqp:arrived-servers</code> — servidores em que você já
              entrou, para o cartão de primeira visita não aparecer duas vezes.
            </li>
            <li>
              <code>pqp:member-sidebar</code> — se a lista de membros está
              aberta neste dispositivo.
            </li>
            <li>
              <code>pqp:call-rating-asked</code> — quando a gente pediu pela
              última vez para você avaliar uma chamada, para o aviso não
              insistir em todo desligar.
            </li>
            <li>
              <code>pqp:whats-new</code>, <code>pqp:download-hint-dismissed</code>,{" "}
              <code>pqp:mobile-beta-hint-2026-08</code>,{" "}
              <code>pqp:qg-hint-2026-08</code>,{" "}
              <code>pqp:cargos-hint-2026-08</code> — cartões e dicas do produto
              que você fechou, para ficarem fechados.
            </li>
            <li>
              <code>pqp:pending-handle-claim</code>,{" "}
              <code>pqp:pending-handle-add</code>,{" "}
              <code>pqp:pending-community-join</code> — um handle público ou
              uma comunidade que você quis reivindicar ou entrar antes de
              entrar na conta, para a gente terminar isso depois do cadastro.
              Apagados depois de usados.
            </li>
          </ul>
          <p>
            A maior parte dessas configurações também é salva na sua conta no
            nosso servidor, para acompanhar você em outro dispositivo — veja a{" "}
            <Link to="/privacy">Política de Privacidade</Link>. O Clerk também
            guarda entradas próprias aqui, para a sessão.
          </p>
          <p>
            O <strong>armazenamento de sessão</strong> (some quando você fecha a
            aba) guarda <code>pqp.connection.callback</code> e{" "}
            <code>pqp.connection.error</code> no pulo de conectar Steam,
            Battle.net ou Twitch, que sai do pqp.gg e volta.
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
      sourceRev: "a8512e98",
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
              <strong>KLIPY, GIPHY e Tenor</strong> — quando um GIF aparece em
              um canal ou no seletor de GIF, a imagem carrega direto dos
              servidores deles. GIFs novos vêm do KLIPY; mensagens antigas
              ainda podem carregar do GIPHY ou do Tenor.
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
            <li>
              <strong>Google Ads</strong> carrega a tag de conversão descrita em
              &quot;Cookies&quot; de{" "}
              <code>www.googletagmanager.com</code>, em toda página do pqp.gg.
            </li>
            <li>
              <strong>Steam, Battle.net e Twitch</strong> — só se você clicar
              em Conectar. O navegador sai do pqp.gg, entra no provedor e volta.
              A gente não guarda os tokens de acesso deles.
            </li>
            <li>
              <strong>O botão de download do APK Android</strong> no pqp.gg
              manda uma contagem de um byte para o painel do operador. Nenhuma
              conta viaja junto. O painel limita por IP durante um minuto.
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
      sourceRev: "ed412a3d",
      heading: "O que a gente não usa",
      body: (
        <>
          <p>
            Nenhum pixel de retargeting ou remarketing, nenhuma lista de
            público, nenhuma gravação de sessão, nenhum SDK de relatório de
            erro e nenhuma impressão digital de dispositivo. As notificações no
            desktop são disparadas localmente pelo seu próprio navegador. Push
            no telefone e na web existe quando a API hospedada está configurada
            com VAPID ou APNs; isso passa pela Apple ou pelo serviço de push do
            navegador, não por um SDK de analytics de terceiro. A tag do
            Google descrita em &quot;Cookies&quot; acima é a única peça de
            maquinaria de publicidade aqui, e ela só conta cadastros.
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
          <p>
            O <strong>Umami</strong>, hospedado na União Europeia, está aqui
            pelo mesmo motivo e nas mesmas condições: conta visitas, não define
            cookie, não guarda nada no seu dispositivo e não tem identificador
            persistente pra reconhecer você. O seu navegador busca o script dele
            em <code>cloud.umami.is</code>, que é o único motivo de ele aparecer
            nesta página.
          </p>
        </>
      ),
    },
    {
      id: "managing",
      sourceRev: "09a66c50",
      heading: "Como controlar isso",
      body: (
        <p>
          Você pode limpar cookies, armazenamento local e dados em cache do
          pqp.gg nas configurações do seu navegador, e bloquear requisições a
          terceiros com uma extensão, se preferir. Bloquear os cookies do Clerk
          impede o login. Bloquear os do Google não custa nada a você e custa a
          nós um cadastro não contado. Limpar o armazenamento local reseta o
          tema, o idioma e
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
