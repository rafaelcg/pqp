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
  updated: "23 de setembro de 2026",
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
      sourceRev: "a6784eed",
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
            O segundo é a <strong>tag do Google Ads</strong>. O pqp.gg compra um
            pouco de publicidade, e a tag do Google carrega em toda página daqui
            para a gente saber se um anúncio produziu uma conta e não só um
            clique. Ela define, para todo visitante, um cookie de origem própria
            no domínio pqp.gg chamado <code>_gcl_au</code>, com um identificador
            aleatório. Quando você chega por um anúncio, ela também registra
            esse clique em outros cookies com nomes começando em{" "}
            <code>_gcl_</code>, para ligar um cadastro posterior a ele. Esses{" "}
            <strong>não</strong> são estritamente necessários: bloqueie e tudo
            funciona exatamente igual, e o cadastro simplesmente não é contado.
            O Google documenta o nome e o prazo de cada um no site dele.
          </p>
          <p>
            <strong>O que a tag envia ao Google.</strong> Cada vez que você
            carrega uma página, a tag informa a visualização: o endereço e o
            título da página, o tamanho da sua tela, o seu navegador e sistema
            operacional, e o identificador <code>_gcl_au</code>. Parte desses
            envios vai para os endereços que o Google Ads usa para montar
            públicos de remarketing, então o Google Ads pode incluir a sua
            visita numa lista de público da nossa conta de anúncios. Quando uma
            conta é criada, a tag envia mais um evento: que houve um cadastro.
            Esse evento não leva nome, nem e-mail, nem id de usuário, nem nada
            que você digitou. O nosso código não entrega dado nenhum da conta
            para a tag.
          </p>
          <p>
            São esses os cookies do pqp.gg. O nosso analytics e o nosso
            relatório de erros não definem nenhum (veja &quot;Terceiros que o
            seu navegador contata&quot;). Quando a tag fala com os servidores do
            Google, o Google também pode ler e definir cookies próprios nos
            domínios dele, se o seu navegador permitir cookies de terceiros.
            Esses são do Google, sob os termos do Google.
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
      sourceRev: "816a9015",
      heading: "Armazenamento local",
      body: (
        <>
          <p>
            O seu navegador guarda estes sob a origem pqp.gg, então outros sites
            não conseguem ler. O nosso código não envia nenhum deles a um
            anunciante. A maioria é configuração. Os que guardam algo que você
            digitou, ou um id, dizem isso. Sair da conta não apaga nenhum deles:
            veja &quot;Como controlar isso&quot;.
          </p>
          <p>
            <strong>Aparência e idioma</strong>
          </p>
          <ul>
            <li>
              <code>pqp-theme</code>: claro, escuro ou seguir o sistema.
            </li>
            <li>
              <code>pqp-appearance</code>: Clássico, Harmonia, Lareira ou Noite.
              O visual escolhido, separado do claro e do escuro.
            </li>
            <li>
              <code>pqp-accent-hue</code>: uma cor de destaque escolhida, ou a
              do visual.
            </li>
            <li>
              <code>pqp-contrast</code>: padrão, alto, ou seguir o contraste do
              sistema.
            </li>
            <li>
              <code>pqp-chat-display</code>: tamanho do texto do chat e
              espaçamento entre mensagens.
            </li>
            <li>
              <code>pqp:locale</code>: o idioma que você escolheu (inglês ou
              português), quando você escolheu algum.
            </li>
          </ul>
          <p>
            <strong>Voz, vídeo e som</strong>
          </p>
          <ul>
            <li>
              <code>pqp-local-settings</code>: entrar com o microfone mudo,
              lista de participantes compacta, ativação por voz ou
              push-to-talk e a tecla, volume de entrada e de saída, se as
              prévias de link aparecem, e as suas outras preferências de voz e
              vídeo. Também guarda qual microfone, câmera e saída de áudio você
              escolheu, como os ids que o navegador dá a esses dispositivos.
            </li>
            <li>
              <code>pqp-sounds</code>: se os sons de mensagem e de chamada tocam
              neste dispositivo, e qual toque.
            </li>
            <li>
              <code>pqp:auto-mute-join-leave-large-rooms</code>: se os sons de
              entrada e saída ficam mudos numa chamada grande.
            </li>
            <li>
              <code>pqp:receive-quality</code>: a qualidade de vídeo que você
              pediu para receber.
            </li>
            <li>
              <code>pqp:video-fit</code>: se o vídeo de câmera, tela e watch
              party preenche o quadro ou cabe dentro dele.
            </li>
            <li>
              <code>pqp:share-cursor</code>,{" "}
              <code>pqp:hide-screen-preview</code>: se o seu cursor aparece no
              compartilhamento de tela, e se você vê uma prévia da sua própria
              tela.
            </li>
            <li>
              <code>pqp:call-split</code>,{" "}
              <code>pqp:participant-rail</code>: como a chamada e o chat dividem
              a janela, e se a faixa de participantes está aberta.
            </li>
          </ul>
          <p>
            <strong>Watch parties e música</strong>
          </p>
          <ul>
            <li>
              <code>pqp:hls-quality</code>, <code>pqp:hls-volume</code>: a
              qualidade e o volume que você escolheu ao assistir uma
              transmissão.
            </li>
            <li>
              <code>pqp:watch-party-activity-open</code>,{" "}
              <code>pqp:watch-party-audience-monitor</code>,{" "}
              <code>pqp:watch-camera-pip</code>,{" "}
              <code>pqp:watch-camera-voice-volume</code>: como a tela da watch
              party está arrumada, e o volume da câmera de quem transmite.
            </li>
            <li>
              <code>pqp:mic-in-stream</code>,{" "}
              <code>pqp:voice-track-mode</code>,{" "}
              <code>pqp:stream-mix-mic-gain</code>,{" "}
              <code>pqp:stream-mix-display-gain</code>: para quem transmite, se o
              seu microfone vai na transmissão, em qual faixa, e o volume dele
              perto do filme.
            </li>
            <li>
              <code>pqp:watch-party-stream-quality:</code> seguido do id da sua
              conta: para quem transmite, a altura da transmissão que você
              escolheu.
            </li>
            <li>
              <code>pqp:music-volume</code>, <code>pqp:music-placement</code>,{" "}
              <code>pqp:music-duck</code>, <code>pqp:music-auto-join</code>: o
              volume do player de música, se o vídeo dele aparece no palco, se
              ele abaixa quando alguém fala, e se ele liga sozinho quando uma
              sala começa a tocar música.
            </li>
          </ul>
          <p>
            <strong>Layout e notificações</strong>
          </p>
          <ul>
            <li>
              <code>pqp-notifications</code>: se você permitiu notificações no
              desktop, e os seus níveis de notificação, guardados pelo id do
              servidor e do canal.
            </li>
            <li>
              <code>pqp:collapsed-categories</code>: os ids das categorias de
              canal que você recolheu na barra lateral.
            </li>
            <li>
              <code>pqp:member-sidebar</code>, <code>pqp:channel-sidebar</code>,{" "}
              <code>pqp:channel-sidebar-width</code>: se a lista de membros e a
              lista de canais estão abertas, e a largura delas.
            </li>
            <li>
              <code>pqp:overview-start-here:</code> seguido do id de um
              servidor: para a equipe do servidor, os canais que você escolheu
              para os cartões &quot;Começar por aqui&quot; daquele servidor.
            </li>
            <li>
              <code>pqp:community-home-viewer</code>: para a equipe do servidor,
              qual visão de membro do Baú você está pré-visualizando.
            </li>
          </ul>
          <p>
            <strong>O que você já viu</strong>
          </p>
          <ul>
            <li>
              <code>pqp:arrived-servers</code>: os ids dos últimos 50 servidores
              em que você entrou, para o cartão de primeira visita não aparecer
              duas vezes.
            </li>
            <li>
              <code>pqp:call-rating-asked</code>: quando a gente pediu pela
              última vez para você avaliar uma chamada, para o aviso não
              insistir em todo desligar.
            </li>
            <li>
              <code>pqp:whats-new</code>, <code>pqp:whats-new-feed</code>: a
              novidade mais recente que você já viu.
            </li>
            <li>
              <code>pqp:community-home-settings-seen</code>, e{" "}
              <code>pqp:community-home-row-seen:</code> seguido do id de um
              servidor: selos do Baú que você já viu.
            </li>
            <li>
              Cartões e dicas do produto que você fechou, para ficarem fechados:{" "}
              <code>pqp:download-hint-dismissed</code>,{" "}
              <code>pqp:mobile-beta-hint-2026-08</code>,{" "}
              <code>pqp:qg-hint-2026-08</code>,{" "}
              <code>pqp:cargos-hint-2026-08</code>,{" "}
              <code>pqp:cinema-hint-2026-09</code>,{" "}
              <code>pqp:music-pip-2026-09</code>,{" "}
              <code>pqp:voice-clean-settings-seen</code>, toda chave que começa
              com <code>pqp:feature-hint-</code>, e{" "}
              <code>pqp:voice-capacity-</code> seguido do id de um canal de voz.
            </li>
          </ul>
          <p>
            <strong>Cadastro e links</strong>
          </p>
          <ul>
            <li>
              <code>pqp:acquisition</code>: se o link que trouxe você aqui
              veio com parâmetros de campanha (<code>utm_source</code>,{" "}
              <code>utm_medium</code>, <code>utm_campaign</code>,{" "}
              <code>gclid</code> ou <code>ref</code>), esses valores e a página
              em que você chegou, para a gente saber de qual link veio um
              cadastro. Não guarda identificador de tipo nenhum, o nosso código
              nunca entrega ele a terceiro, expira em 30 dias, é gravado uma vez só (um link
              de campanha posterior não substitui) e é apagado do seu
              dispositivo na primeira vez que o app carrega depois do seu
              login, quando é enviado uma única vez para a sua conta. Se você
              nunca se cadastrar, ele simplesmente expira.
            </li>
            <li>
              <code>pqp:ads-signup-reported</code>: o identificador da conta
              cujo cadastro já foi contado pela tag do Google Ads descrita
              acima, para que recarregar o app não conte o mesmo cadastro duas
              vezes. É gravado uma vez, quando você cria uma conta, e nunca sai
              do seu dispositivo. Se você nunca se cadastrar, ele nunca chega a
              ser gravado.
            </li>
            <li>
              <code>pqp:pending-handle-claim</code>,{" "}
              <code>pqp:pending-handle-add</code>,{" "}
              <code>pqp:pending-community-join</code>,{" "}
              <code>pqp:pending-create-community</code>,{" "}
              <code>pqp:pending-invite-ref</code>: um handle que você quis
              reivindicar, uma pessoa que você quis adicionar, ou uma
              comunidade, servidor ou convite em que você quis entrar ou que quis
              criar antes de entrar na conta, para a gente terminar isso depois
              do cadastro. Cada um expira em uma hora e é apagado depois de
              usado.
            </li>
          </ul>
          <p>
            <strong>Texto que você digitou</strong>
          </p>
          <ul>
            <li>
              <code>pqp:composer-drafts:</code> seguido do id da sua conta:
              <strong> rascunhos de mensagem.</strong> O que você digitou num
              canal e não enviou espera por você quando você volta, como no
              Discord ou no Slack. Só texto, nunca anexos. Guarda até 50
              canais, descarta um rascunho depois de 30 dias, e apaga o
              rascunho quando você envia ou esvazia a caixa.
            </li>
            <li>
              <code>pqp:outbox:</code> seguido do id da sua conta: mensagens a
              caminho. Uma mensagem de texto que você envia num canal é
              guardada aqui primeiro, para não se perder se a conexão cair ou a
              aba fechar, e sai daqui no momento em que o nosso servidor
              responde. Normalmente não guarda nada por mais de um instante.
              Uma mensagem que não chegou é enviada de novo quando você
              reconecta, ou descartada depois de 24 horas. Arquivos, enquetes e
              respostas em thread não passam por aqui.
            </li>
          </ul>
          <p>
            <strong>Guardado por outros programas na página</strong>
          </p>
          <ul>
            <li>
              <code>emoji-mart.frequently</code>,{" "}
              <code>emoji-mart.last</code>: os emojis usados recentemente no
              seletor de emoji.
            </li>
            <li>
              <code>_gcl_ls</code>: gravado pela tag do Google Ads, com a mesma
              finalidade dos cookies <code>_gcl_</code> descritos em
              &quot;Cookies&quot;.
            </li>
            <li>O Clerk também guarda entradas próprias aqui, para a sessão.</li>
          </ul>
          <p>
            O seu tema e visual, idioma, exibição do chat, sons, níveis de
            notificação e as principais configurações de voz (entrar mudo, modo
            de entrada, volumes) também são salvos na sua conta no nosso
            servidor, para acompanhar você em outro dispositivo. Veja a{" "}
            <Link to="/privacy">Política de Privacidade</Link>.
          </p>
          <p>
            O <strong>armazenamento de sessão</strong> (some quando você fecha a
            aba) guarda:
          </p>
          <ul>
            <li>
              <code>pqp.connection.callback</code> e{" "}
              <code>pqp.connection.error</code>, no pulo de conectar Steam,
              Battle.net ou Twitch, que sai do pqp.gg e volta. Cada um é apagado
              assim que é lido.
            </li>
            <li>
              <code>pqp:desktop-login</code>, enquanto você entra no app de
              desktop pelo navegador. Apagado quando isso termina.
            </li>
            <li>
              <code>pqp:onboarding-started-at-ms</code>,{" "}
              <code>pqp:onboarded-at-ms</code>,{" "}
              <code>pqp:arrival_first_message</code>,{" "}
              <code>pqp:arrival_first_voice</code>: tempos e marcas de uma vez
              só dos seus primeiros passos, para cada um ser contado uma vez.
            </li>
            <li>
              <code>pqp:confetti-spent</code>: o id da sua conta, para o confete
              de boas-vindas tocar uma vez só.
            </li>
            <li>
              <code>com.grafana.faro.session</code> e{" "}
              <code>com.grafana.faro.lastNavigationId</code>: um id de sessão e
              um id de página aleatórios para o relatório de erros, descrito em
              &quot;Terceiros que o seu navegador contata&quot;. Nenhum dos dois
              é o id da sua conta.
            </li>
          </ul>
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
      sourceRev: "f537eca5",
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
              <strong>Google Ads</strong>: a tag descrita em &quot;Cookies&quot;
              carrega de <code>www.googletagmanager.com</code> em toda página do
              pqp.gg, e envia as visualizações de página para servidores do
              Google em <code>doubleclick.net</code> e <code>google.com</code>.
            </li>
            <li>
              <strong>Cloudflare Web Analytics</strong>: a Cloudflare coloca o
              script dela, de <code>static.cloudflareinsights.com</code>, em
              toda página quando ela sai da rede deles. Ele conta visitas e mede
              a velocidade das páginas. O aviso de privacidade descreve o que
              ele registra.
            </li>
            <li>
              <strong>Umami</strong>: o script carrega de{" "}
              <code>cloud.umami.is</code> e envia as contagens de visita para{" "}
              <code>gateway.umami.is</code>. O aviso de privacidade descreve o
              que ele registra.
            </li>
            <li>
              <strong>Grafana Faro</strong>, da Grafana Labs, manda para a gente
              os erros do app web, para a gente consertar. Ele envia relatórios
              para o coletor da Grafana em São Paulo (
              <code>faro-collector-prod-sa-east-1.grafana.net</code>). Um
              relatório tem o endereço da página, a mensagem de erro e onde no
              nosso código ela aconteceu, erros que o app escreve no console do
              navegador, medições de velocidade da página, os endereços e tempos
              das requisições que o app faz, e o seu navegador e sistema
              operacional. Ele leva o id de sessão aleatório do armazenamento de
              sessão listado acima. O nosso código nunca diz a ele quem você é,
              mas alguns endereços de requisição têm ids, e o link para assistir
              a transmissão de uma watch party tem o id da sua conta. Ele não
              registra cliques, teclas nem a tela.
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
      sourceRev: "f31c91fe",
      heading: "O que a gente não usa",
      body: (
        <>
          <p>
            Nenhuma gravação de sessão: nada no pqp.gg grava a sua tela nem o
            que você digita. Nenhuma impressão digital de dispositivo feita pelo
            nosso código. As notificações no desktop são disparadas localmente
            pelo seu próprio navegador. Push no telefone e na web existe quando
            a API hospedada está configurada com VAPID ou APNs; isso passa pela
            Apple ou pelo serviço de push do navegador, não por um SDK de
            analytics de terceiro. A tag do Google descrita em
            &quot;Cookies&quot; acima é a única peça de maquinaria de
            publicidade aqui.
          </p>
          <p>
            O <strong>Cloudflare Web Analytics</strong>, o{" "}
            <strong>Umami</strong> e o <strong>Grafana Faro</strong> não definem
            cookie. O Cloudflare Web Analytics e o Umami também não guardam nada
            no seu dispositivo e não usam identificador persistente, então não
            conseguem reconhecer você entre visitas nem entre sites. O Grafana
            Faro guarda só o id de sessão aleatório no armazenamento de sessão
            listado acima, que some quando você fecha a aba. Por isso a frase em
            &quot;Cookies&quot;, de que o nosso analytics e o nosso relatório de
            erros não definem cookie, é verdadeira.
          </p>
        </>
      ),
    },
    {
      id: "managing",
      sourceRev: "7586bca2",
      heading: "Como controlar isso",
      body: (
        <>
          <p>
            Você pode limpar cookies, armazenamento local e dados em cache do
            pqp.gg nas configurações do seu navegador, e bloquear requisições a
            terceiros com uma extensão, se preferir. Bloquear os cookies do
            Clerk impede o login. Bloquear os do Google não custa nada a você e
            custa a nós um cadastro não contado. Limpar o armazenamento local
            reseta o tema, o idioma e as preferências de notificação naquele
            dispositivo, mas não mexe na sua conta.
          </p>
          <p>
            <strong>Sair da conta não limpa o armazenamento local.</strong>{" "}
            Rascunhos e mensagens não enviadas ficam no dispositivo sob o id da
            sua conta, então estão lá quando você volta, e a próxima pessoa que
            entrar no mesmo navegador não vê. As configurações são do
            navegador, não da conta, então a próxima pessoa fica com as suas.
            Se você divide o dispositivo e quer apagar tudo, limpe os dados do
            site pqp.gg nas configurações do navegador.
          </p>
        </>
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
