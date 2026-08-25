import { Link } from "react-router-dom";
import type { LegalDocument } from "./document";

/**
 * Política de Privacidade em português do Brasil. Tradução de `privacy.en.tsx`;
 * veja as notas de registro em `terms.pt-BR.tsx`.
 *
 * VOCABULÁRIO DA LGPD — não afrouxe nenhum destes termos: eles têm definição
 * legal e trocar por sinônimo muda o que o documento diz.
 *
 *   controlador, operador, titular, tratamento, base legal, consentimento,
 *   legítimo interesse, encarregado, anonimização, incidente de segurança.
 *
 * Em particular, o inglês diz "the operator of pqp.gg is the controller" —
 * traduzir isso como &quot;o operador do pqp.gg&quot; diria o oposto, porque na
 * LGPD &quot;operador&quot; é quem trata dados <em>em nome do</em> controlador.
 * Por isso aqui está &quot;quem administra o pqp.gg&quot;.
 *
 * As citações de artigo (art. 7, V; arts. 15–21; Lei nº 13.709/2018) ficam
 * exatamente como estão no inglês, sem reformatar para &quot;art. 7º&quot;, para
 * que os dois documentos possam ser conferidos lado a lado.
 */
export const privacyPtBr: LegalDocument = {
  locale: "pt-BR",
  path: "/privacy",
  title: "Política de Privacidade — pqp",
  description:
    "Como o pqp.gg trata dados pessoais: o que a gente coleta, as bases legais, onde os dados são tratados, por quanto tempo ficam e os seus direitos sob a LGPD e a lei de proteção de dados do Reino Unido.",
  heading: "Política de Privacidade",
  updated: "25 de agosto de 2026",
  sections: [
    {
      id: "intro",
      sourceRev: "64f3d4dc",
      body: (
        <>
          <p>
            Esta política explica quais dados pessoais o{" "}
            <strong>pqp.gg</strong> coleta, por quê, e o que você pode fazer a
            respeito. A gente tentou descrever o produto como ele funciona hoje,
            inclusive as partes que não estão prontas — onde um controle ainda
            não existe, a gente diz isso em vez de descrever um que não foi
            construído.
          </p>
          <p>
            Se você hospeda o pqp por conta própria, você é o controlador da sua
            instância. Este documento ainda descreve o que o software guarda,
            para você escrever a sua própria política a partir dele.
          </p>
        </>
      ),
    },
    {
      id: "controller",
      sourceRev: "39237263",
      heading: "Quem responde pelos seus dados",
      body: (
        <p>
          <strong>Quem administra o pqp.gg</strong> é o controlador: uma pessoa
          no Reino Unido, tocando isso como projeto pessoal e não como empresa.
          Não existe equipe de privacidade e não existe encarregado nomeado —
          nomear um seria encenação em um projeto deste tamanho. A mesma pessoa
          que escreveu o código responde as perguntas de proteção de dados, e
          existe um endereço para isso: <strong>contato@pqp.gg</strong>. Onde
          esta política mandar escrever para a gente, é esse o endereço e é essa
          a pessoa que lê.
        </p>
      ),
    },
    {
      id: "which-law",
      sourceRev: "51dc4b4a",
      heading: "Qual lei se aplica",
      body: (
        <>
          <p>
            Esta política é escrita com base na{" "}
            <strong>
              Lei Geral de Proteção de Dados (Lei nº 13.709/2018, LGPD)
            </strong>
            , porque é a lei que cobre a maior parte das pessoas que usam o
            pqp.gg. Como quem administra está no Reino Unido,{" "}
            <strong>
              a lei de proteção de dados do Reino Unido — o UK GDPR e o Data
              Protection Act 2018 — também se aplica
            </strong>
            .
          </p>
          <p>
            A gente não vai manter duas listas dizendo quase a mesma coisa. Os
            direitos descritos abaixo valem para <em>todo mundo</em>, seja qual
            for das duas leis que te dê esse direito, e quando uma te dá algo
            que a outra não dá, você recebe.
          </p>
        </>
      ),
    },
    {
      id: "age",
      sourceRev: "5290c562",
      heading: "Idade",
      body: (
        <>
          <p>
            O pqp.gg é para pessoas de <strong>18 anos ou mais</strong>. A gente
            não trata, de forma consciente, dados pessoais de crianças ou
            adolescentes. Se você acha que um menor de idade está usando o
            pqp.gg, avise em <strong>contato@pqp.gg</strong> e a gente encerra a
            conta e apaga os dados. Veja os{" "}
            <Link to="/terms">Termos de Uso</Link> para a regra de quem pode
            usar.
          </p>
          <p>
            <strong>Como a gente pergunta, e o que guarda.</strong> Na primeira
            vez que você usa o app depois de entrar, a gente pede a sua{" "}
            <strong>data de nascimento</strong> — dia, mês e ano — e você só
            pode responder uma vez. O servidor calcula se você já tem 18 anos.{" "}
            <strong>Se tiver, a gente não guarda a data</strong>: a sua conta
            guarda a resposta sim-ou-não e o momento em que você respondeu, e a
            data em si nunca é gravada no nosso banco de dados. Se a resposta
            for que você tem menos de 18 anos, a conta fica bloqueada de usar o
            pqp.gg e aí a gente guarda a data que você informou, porque é o
            registro sobre o qual um recurso teria que ser decidido. Tanto a
            resposta quanto a data, quando existe, ficam na sua conta, então
            excluir a conta apaga as duas.
          </p>
          <p>
            Isso é uma <strong>autodeclaração que a gente faz valer</strong>,
            não verificação de idade. A gente não pede documento e não usa
            serviço de comprovação de idade, porque isso significaria guardar
            muito mais dado pessoal sobre você do que uma regra de 18+ precisa.
            Uma conta bloqueada por essa checagem ainda pode baixar os seus
            dados e se excluir: os seus direitos não dependem de você ser
            bem-vindo.
          </p>
        </>
      ),
    },
    {
      id: "what-we-collect",
      sourceRev: "be10efc1",
      heading: "O que a gente coleta",
      body: (
        <>
          <p>
            <strong>Conta e perfil.</strong> O login é feito pelo{" "}
            <a href="https://clerk.com" target="_blank" rel="noreferrer">
              Clerk
            </a>
            , um provedor de identidade terceirizado.{" "}
            <strong>
              O Clerk guarda o seu e-mail e as suas credenciais de login. A
              gente não copia isso para o nosso banco de dados
            </strong>{" "}
            — embora nada impeça você de digitar o e-mail em algum campo, como o
            nome de exibição ou uma mensagem, e, se fizer isso, ele fica
            guardado como qualquer outro texto que você escreve. O que a gente
            guarda do nosso lado é: um identificador de usuário do Clerk, o seu
            nome de exibição, a sua tag <code>name#1234</code>, a URL de um
            avatar, os <em>domínios</em> dos seus e-mails verificados (por
            exemplo <code>empresa.com.br</code>, usado para entrar em servidores
            por domínio de empresa — nunca a caixa de e-mail em si), a sua
            configuração de privacidade de DM, e quando a conta foi criada. Se
            o link que trouxe você ao pqp.gg pela primeira vez veio com
            parâmetros de campanha (<code>utm_source</code>,{" "}
            <code>utm_medium</code>, <code>utm_campaign</code>,{" "}
            <code>gclid</code> ou <code>ref</code>), esses valores e a página
            em que você chegou são salvos na conta uma vez, no cadastro, e
            nunca mais alterados, para a gente saber quais links trazem gente
            pra cá. Isso não usa cookie nem terceiro (veja o{" "}
            <Link to="/cookies">Aviso de cookies</Link>) e só é lido como
            contagem por campanha, nunca como lista de pessoas.
          </p>
          <p>
            <strong>Conteúdo que você publica.</strong> Texto das mensagens,
            horários, edições, mensagens fixadas, respostas, @menções e reações
            com emoji. As mensagens são guardadas para o histórico funcionar
            quando você recarrega e para os outros membros do canal conseguirem
            ler. A gente também guarda um marcador de &quot;última leitura&quot;
            por canal, para o contador de não lidas funcionar.
          </p>
          <p>
            <strong>Comunidades.</strong> Servidores que você cria ou em que
            entra, nomes e tópicos dos canais, o seu cargo (dono / admin /
            membro), códigos de convite que você cria, e banimentos — incluindo
            o motivo em texto livre que um moderador digitou.
          </p>
          <p>
            <strong>Arquivos e imagens.</strong> Quando os anexos de arquivo
            estão ligados, a gente guarda o nome do arquivo, o tipo, o tamanho e
            as dimensões no nosso banco de dados, e o arquivo em si em
            armazenamento de objetos compatível com S3. Os anexos estão{" "}
            <strong>ligados</strong> no pqp.gg hoje. GIFs escolhidos na busca de
            GIF são guardados como um link para o provedor do GIF, não como
            cópia.
          </p>
          <p>
            <strong>Configurações.</strong> Preferências de notificação, tema,
            entrar mudo e volumes de áudio são salvos na sua conta para
            acompanhar você entre dispositivos, e espelhados no armazenamento
            local do seu navegador. Veja o{" "}
            <Link to="/cookies">Aviso de cookies</Link>.
          </p>
          <p>
            <strong>Registros de moderação.</strong> Donos e admins de servidor
            têm um log de auditoria das ações administrativas no servidor deles
            — quem expulsou, baniu, mudou um cargo, apagou a mensagem de outra
            pessoa, renomeou um canal ou exportou o servidor. Ele registra quem
            agiu, a ação, o id do alvo, um motivo opcional e o valor anterior do
            que mudou. Ele não registra o texto das mensagens.
          </p>
          <p>
            <strong>Prévias de link.</strong> Quando você publica um link, o
            nosso servidor busca aquela página uma vez para ler as tags de
            prévia e guarda em cache o título, a descrição, o nome do site e a
            imagem de prévia associados à URL. Esse cache é indexado só pela URL
            — ele não registra quem publicou.
          </p>
          <p>
            <strong>Técnicos.</strong> Logs de aplicação com erros e eventos de
            conexão. Eles registram um número de conexão e um id de usuário; não
            registram o seu endereço IP. O seu endereço IP é lido em memória,
            por um instante, para aplicar limites de uso, e não é gravado no
            nosso banco de dados nem nos nossos logs.
          </p>

          <h3>Analytics do site</h3>
          <p>
            As páginas institucionais e o app usam o{" "}
            <strong>Cloudflare Web Analytics</strong> para a gente saber se
            alguém está chegando e se o site está rápido o suficiente para usar.
            Ele é sem cookie: não guarda nada no seu dispositivo e não usa
            identificador persistente, então não consegue reconhecer você em uma
            visita futura nem seguir você para outro site.
          </p>
          <p>
            O que ele registra é o endereço da página, a página que trouxe você,
            o seu país, o seu navegador e tipo de dispositivo, e a velocidade de
            carregamento das páginas. Isso é medição agregada de tráfego, não
            perfil — não tem como a gente procurar uma pessoa específica ali, e
            isso nunca é cruzado com a sua conta.
          </p>
          <p>
            O script é injetado pela Cloudflare na borda, e não empacotado
            dentro do app, então você não vai encontrar ele no nosso
            código-fonte. Bloquear com uma extensão de navegador não quebra
            nada.
          </p>
          <p>
            As mesmas páginas também carregam o <strong>Umami</strong>,
            hospedado pelos criadores dele na União Europeia, com a mesma
            finalidade: contar visitas e ver em quais páginas as pessoas chegam.
            Ele também é sem cookie, não guarda nada no seu dispositivo e não
            usa identificador persistente. Registra o endereço da página, a
            página que trouxe você, e o seu país, navegador e tipo de
            dispositivo, tudo de forma agregada. Ele nunca vê a sua conta, e
            bloquear ele também não quebra nada.
          </p>
          <p>
            São dois porque respondem perguntas um pouco diferentes, e nenhum
            dos dois te custa nada por medir. Se isso mudar, este parágrafo muda
            junto.
          </p>

          <h3>Medição de publicidade</h3>
          <p>
            O pqp.gg compra um pouco de publicidade, e carrega o{" "}
            <strong>rastreamento de conversão do Google Ads</strong> para a
            gente saber se um anúncio produziu uma conta e não só um clique.
            Essa é a única coisa no site que não é sem cookie, e a gente prefere
            dizer isso na cara do que esconder. A tag do Google carrega em toda
            página do pqp.gg, e ela define cookies de origem própria no domínio
            pqp.gg (os nomes começam em <code>_gcl_</code>) para lembrar que a
            sua visita chegou por um anúncio.
          </p>
          <p>
            Um evento é enviado ao Google, uma vez: quando uma conta é criada, a
            tag informa que houve um cadastro. Ele não leva nome, nem e-mail,
            nem id de usuário, nem nada que você digitou. A gente não envia
            dados da sua conta para o Google, não ativou conversões aprimoradas
            nem nenhum cruzamento com dados de clientes, e não roda remarketing
            nem listas de público. Entrar de novo não envia nada, e nada do que
            você faz dentro do app envia também.
          </p>
          <p>
            O Google é um terceiro aqui e trata o que recebe, inclusive o seu
            endereço IP, sob os termos dele. Bloquear a tag com uma extensão de
            navegador, ou bloquear cookies para o pqp.gg, não quebra nada: o
            produto funciona exatamente igual e o cadastro simplesmente não é
            contado.
          </p>
          <p>
            Isso vale para o pqp.gg hospedado e para mais nada. A tag é
            adicionada na hora de compilar, e só quando a compilação recebe o id
            da nossa conta de publicidade. Uma cópia self-hosted do pqp não
            contata nenhum servidor de publicidade do Google e não define nenhum
            cookie do Google.
          </p>
        </>
      ),
    },
    {
      id: "what-we-dont-do",
      sourceRev: "0322d1cf",
      heading: "O que a gente não faz",
      body: (
        <ul>
          <li>
            <strong>Sem perfil sobre você.</strong> Não tem gravador de sessão e
            não tem serviço de relatório de erro, e nada do que a gente guarda
            monta um retrato de você como pessoa. As duas ferramentas de
            analytics descritas em &quot;O que a gente coleta&quot; acima contam
            visitas e não conseguem identificar visitantes. A única exceção ao
            &quot;nada segue você entre sites&quot; é a tag de conversão do
            Google Ads, descrita no mesmo lugar: o trabalho dela é ligar um
            clique em anúncio a um cadastro, e ela é a única coisa no pqp.gg que
            um terceiro consegue ler.
          </li>
          <li>
            <strong>Sem perfil publicitário e sem venda de dados.</strong> A
            gente anuncia, sim, e conta quantos cadastros a publicidade
            produziu, que é a tag de conversão acima. A gente não monta perfil
            publicitário, não roda remarketing nem listas de público, e não vende
            nem aluga dados pessoais.
          </li>
          <li>
            <strong>Sem fingerprinting de dispositivo e sem geolocalização.</strong>{" "}
            A gente não sonda o seu dispositivo atrás de uma impressão digital e
            não procura a sua localização.
          </li>
          <li>
            <strong>Sem gravação de voz.</strong> Nenhuma chamada é gravada nem
            armazenada pela gente, por caminho nenhum — veja abaixo.
          </li>
          <li>
            <strong>Sem endereço IP guardado.</strong> Não existe coluna de
            endereço IP em lugar nenhum do nosso banco de dados.
          </li>
          <li>
            <strong>Sem decisão automatizada sobre você.</strong> Nada aqui
            traça o seu perfil nem decide nada sobre você de forma automática.
            Decisões de moderação são tomadas por uma pessoa.
          </li>
        </ul>
      ),
    },
    {
      id: "voice",
      sourceRev: "1b3f66cc",
      heading: "Chamadas de voz",
      body: (
        <>
          <p>
            Na configuração que o pqp.gg roda hoje, a voz é{" "}
            <strong>ponto a ponto</strong>. O seu áudio vai direto do seu
            dispositivo para as outras pessoas do canal por WebRTC,
            criptografado de ponta a ponta pelo navegador (DTLS-SRTP).{" "}
            <strong>
              Ele não passa pelos nossos servidores, e a gente não conseguiria
              gravar mesmo se quisesse.
            </strong>{" "}
            O que o nosso servidor faz é só a sinalização: quem está em qual
            canal de voz e as mensagens de estabelecimento de conexão que os
            navegadores trocam.
          </p>
          <p>Duas ressalvas honestas:</p>
          <ul>
            <li>
              <strong>STUN e TURN.</strong> Para conectar dois dispositivos
              atrás de roteadores domésticos, os navegadores usam servidores
              STUN e, quando um caminho direto é impossível (comum em rede
              móvel), o áudio criptografado é retransmitido por um servidor{" "}
              <strong>TURN</strong>. Esses terceiros veem os endereços IP das
              pessoas na chamada, e o relay TURN carrega a mídia — mas ela
              continua criptografada entre os participantes, então o relay não
              consegue escutar. Os nossos provedores de STUN/TURN hoje são a{" "}
              <strong>ExpressTURN</strong>, mais os servidores STUN públicos do
              Google e da Cloudflare.
            </li>
            <li>
              <strong>Chamadas grandes.</strong> Como cada participante se
              conecta diretamente com todos os outros, esse desenho só estica
              até certo ponto antes de as conexões pesarem. O software também
              suporta um servidor de mídia (SFU) para canais maiores, o que{" "}
              <em>colocaria</em> o áudio em um servidor de terceiro. Esse modo{" "}
              <strong>não está ligado</strong> no pqp.gg. Se a gente ligar,
              atualiza esta página antes.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "legal-bases",
      sourceRev: "b4d9162b",
      heading: "Por que a gente trata os seus dados, e a base legal",
      body: (
        <>
          <p>
            Aqui está para que a gente usa os seus dados de verdade. O art. 7 da
            LGPD diz que cada uma dessas finalidades precisa se apoiar em uma
            base legal específica, então a gente nomeou a base entre parênteses
            no fim de cada item — mas a frase simples antes dela é a parte que
            responde a pergunta que você realmente tem.
          </p>
          <ul>
            <li>
              <strong>Fazer o pqp funcionar.</strong> Criar a sua conta,
              entregar as suas mensagens, manter o seu histórico para ele estar
              lá quando você recarrega, conectar as suas chamadas de voz e
              lembrar das suas configurações — o serviço básico para o qual você
              se cadastrou.{" "}
              <em>(Isso se apoia no nosso contrato com você: art. 7, V.)</em>
            </li>
            <li>
              <strong>
                Manter o serviço de pé e impedir que abusem dele.
              </strong>{" "}
              Limites de uso, bloqueio de ataques, investigação de problemas,
              proteção de outras pessoas contra dano.{" "}
              <em>
                (Base: o nosso legítimo interesse, art. 7, IX — ponderado com os
                seus direitos e limitado ao que isso realmente exige.)
              </em>
            </li>
            <li>
              <strong>Fazer valer as nossas regras.</strong> Analisar denúncias
              e manter registros de banimento e de auditoria, para uma decisão
              de moderação poder ser conferida depois em vez de aceita na
              confiança. <em>(Base: legítimo interesse, art. 7, IX.)</em>
            </li>
            <li>
              <strong>
                Agir diante de ameaça crível à vida ou à integridade física de
                alguém
              </strong>
              , incluindo denúncia envolvendo menor de idade.{" "}
              <em>
                (Base: proteção da vida ou da incolumidade física, art. 7, VII,
                e, onde a lei nos obriga a comunicar, cumprimento de obrigação
                legal, art. 7, II.)
              </em>
            </li>
            <li>
              <strong>Cumprir a lei.</strong> Responder a uma ordem legal, ou
              guardar os registros que a lei manda guardar.{" "}
              <em>(Base: cumprimento de obrigação legal, art. 7, II.)</em>
            </li>
            <li>
              <strong>
                Nos defender, ou afirmar um direito, se um dia houver disputa.
              </strong>{" "}
              <em>
                (Base: exercício regular de direitos em processo judicial,
                administrativo ou arbitral, art. 7, VI.)
              </em>
            </li>
            <li>
              <strong>Medir a nossa publicidade.</strong> Contar quantos
              cadastros uma campanha de anúncio produziu, pela tag de conversão
              do Google Ads descrita acima. Ela conta um evento; não identifica
              você para a gente nem para o Google.{" "}
              <em>
                (Base: legítimo interesse, art. 7, IX. Para se opor, bloqueie a
                tag no navegador ou escreva para a gente.)
              </em>
            </li>
            <li>
              <strong>Qualquer coisa opcional que você ligar</strong>, como as
              notificações no desktop, que o seu navegador pede permissão em
              separado.{" "}
              <em>
                (Base: o seu consentimento, art. 7, I — retire quando quiser em{" "}
                <span lang="en">Settings</span> ou no navegador.)
              </em>
            </li>
          </ul>
          <p>
            Pela lei do Reino Unido, essas mesmas oito atividades se apoiam nas
            bases equivalentes do art. 6 do UK GDPR — contrato, legítimo
            interesse, obrigação legal, interesses vitais e consentimento, nessa
            ordem. O tratamento é o mesmo dos dois jeitos; só mudam os números
            dos artigos.
          </p>
          <p>
            Onde a gente se apoia em legítimo interesse, você pode se opor —
            escreva para <strong>contato@pqp.gg</strong> e a gente olha o
            tratamento específico ao qual você está se opondo.
          </p>
        </>
      ),
    },
    {
      id: "who-sees",
      sourceRev: "a1e5b534",
      heading: "Quem mais vê os seus dados",
      body: (
        <>
          <p>
            A gente usa serviços de terceiros para tocar o pqp.gg. Eles tratam
            dados seguindo as nossas instruções e para nenhuma outra finalidade:
          </p>
          <ul>
            <li>
              <strong>Clerk</strong> — autenticação. Guarda o seu e-mail e as
              suas credenciais.
            </li>
            <li>
              <strong>Fly.io</strong> — servidores de aplicação e o banco de
              dados Postgres, em{" "}
              <strong>São Paulo, Brasil (região gru da Fly)</strong>.
            </li>
            <li>
              <strong>Cloudflare</strong> — serve o app web e o site
              institucional.
            </li>
            <li>
              <strong>Cloudflare R2</strong> — armazenamento de objetos para os
              anexos de arquivo, quando os anexos estão ligados. O seu navegador
              envia e baixa os bytes dos anexos <em>direto</em> para esse
              armazenamento, usando links assinados de vida curta, então o
              provedor de armazenamento vê o seu endereço IP enquanto um arquivo
              é transferido.
            </li>
            <li>
              <strong>ExpressTURN</strong>, mais os STUN públicos do Google e da
              Cloudflare — estabelecimento e retransmissão da conexão de voz,
              como descrito acima.
            </li>
          </ul>
          <p>
            Alguns terceiros são contatados diretamente pelo seu navegador:
          </p>
          <ul>
            <li>
              <strong>Google Fonts</strong> — as fontes do site carregam da CDN
              do Google em toda página, então o Google vê o seu endereço IP e
              qual página você abriu.
            </li>
            <li>
              <strong>GIPHY e Tenor</strong> — a busca de GIF passa pelo nosso
              servidor (então o provedor vê o termo buscado vindo da gente, não
              de você), mas a imagem do GIF em si carrega direto da CDN deles,
              então eles veem o endereço IP de todo mundo que vê o GIF no canal.
            </li>
            <li>
              <strong>DiceBear</strong> — as imagens de avatar prontas em{" "}
              <span lang="en">Settings</span> carregam do serviço deles.
            </li>
            <li>
              <strong>Google Ads</strong> carrega a tag de conversão em toda
              página do pqp.gg, então o Google vê o seu endereço IP e qual
              página você abriu, e é avisado uma vez quando uma conta é criada.
              Está detalhado em &quot;Medição de publicidade&quot; acima.
            </li>
          </ul>
          <p>
            A gente deliberadamente <em>não</em> usa hot-link nas imagens de
            prévia de link: elas passam pelo nosso servidor, então abrir um
            canal nunca conta ao site linkado quem é você.
          </p>
          <p>
            A gente também divulga dados quando uma ordem legal válida exige, ou
            quando é necessário para proteger alguém de dano grave. A gente não
            vende dados pessoais.
          </p>
        </>
      ),
    },
    {
      id: "where-processed",
      sourceRev: "18d155e8",
      heading: "Onde os seus dados são tratados",
      body: (
        <>
          <p>
            <strong>
              Os seus dados são tratados em vários países, e provavelmente não
              no seu.
            </strong>{" "}
            Clerk, Cloudflare, o nosso armazenamento de objetos, os provedores
            de STUN/TURN e o Google Fonts operam globalmente e normalmente
            tratam dados nos Estados Unidos e na Europa. Os servidores de
            aplicação e o banco de dados rodam na <strong>Fly.io</strong> em{" "}
            <strong>São Paulo, Brasil (região gru da Fly)</strong>. A pessoa que
            administra o pqp.gg está no Reino Unido, então tudo que é tratado
            por um humano é tratado lá.
          </p>
          <p>
            A base honesta dessas transferências: são serviços comerciais
            comuns, usados nos termos publicados por cada um deles, e é nesses
            termos que as transferências se apoiam. Não existe acordo de
            transferência sob medida negociado para o pqp, porque não existe
            empresa para assinar e não existe advogado para redigir. O banco de
            dados já roda no Brasil, então as suas mensagens não saem do país no
            dia a dia — mas quem lê uma denúncia ou responde a um pedido de
            exclusão está no Reino Unido, e isso também é uma transferência.
          </p>
        </>
      ),
    },
    {
      id: "retention",
      sourceRev: "333cd4dc",
      heading: "Por quanto tempo a gente guarda cada coisa",
      body: (
        <>
          <ul>
            <li>
              <strong>Conta e perfil</strong> — até a conta ser excluída.
            </li>
            <li>
              <strong>A declaração de 18+</strong> — a resposta sim-ou-não e
              quando você respondeu, até a conta ser excluída. A data de
              nascimento em si só é guardada quando a resposta foi de menor de
              18 anos.
            </li>
            <li>
              <strong>Mensagens em um servidor</strong> — por tempo
              indeterminado, por padrão. Cada dono de servidor pode definir uma{" "}
              <strong>janela de retenção de mensagens</strong> para o servidor
              dele, depois da qual uma rotina diária apaga as mensagens mais
              antigas que essa janela. Mensagens fixadas ficam de fora. O padrão
              é não ter janela, então nada é apagado a menos que o dono peça.
            </li>
            <li>
              <strong>Mensagens diretas e grupos de DM</strong> — guardados por
              tempo indeterminado.{" "}
              <strong>
                As janelas de retenção de servidor não valem para DMs.
              </strong>{" "}
              Tirar uma DM da sua barra lateral esconde ela da sua visão; não
              apaga a conversa para a outra pessoa. Apagar mensagens específicas
              que você enviou apaga elas de verdade.
            </li>
            <li>
              <strong>Anexos</strong> — o mesmo tempo que a mensagem à qual
              pertencem. Quando a mensagem some, uma rotina de hora em hora
              apaga o arquivo guardado.
            </li>
            <li>
              <strong>Logs de auditoria de servidor</strong> — 90 dias, depois
              apagados automaticamente.
            </li>
            <li>
              <strong>Cache de prévia de link</strong> — atualizado depois de 7
              dias; as entradas hoje não são expurgadas. Elas contêm metadados
              da página, não dados pessoais sobre você.
            </li>
            <li>
              <strong>Amostras de status do serviço</strong> — 30 dias. Não
              contêm informação de usuário nem de servidor.
            </li>
            <li>
              <strong>Banimentos</strong> — guardados até o dono do servidor
              desfazer, para o banimento sobreviver à saída da pessoa banida.
            </li>
          </ul>
          <p>
            <strong>O que sobrevive à exclusão da sua conta.</strong> Excluir a
            sua conta remove o seu perfil, as suas configurações e todas as
            mensagens que você escreveu, em qualquer lugar. Alguns registros
            ficam, cada um porque a lei permite manter dados quando eles são
            necessários para cumprir obrigação legal ou para exercer direitos em
            processo (art. 16 da LGPD; o UK GDPR tem a mesma ressalva no art.
            17(3)):
          </p>
          <ul>
            <li>
              <strong>
                Entradas de auditoria das ações de moderação que você tomou
              </strong>{" "}
              no servidor de outra pessoa. A entrada fica e o seu id de usuário
              é removido dela, e o log continua sendo apagado depois de 90 dias
              como qualquer outra entrada. É o único registro de que um
              moderador apagou uma mensagem ou baniu um membro; se excluir a
              conta apagasse isso, abusar de um servidor estaria a um clique de
              ser apagado também.
            </li>
            <li>
              <strong>Banimentos que você aplicou em outras pessoas</strong>,
              com o seu id removido. Esse registro é um fato sobre quem foi
              banido e sobre o servidor, não sobre você — removê-lo readmitiria
              em silêncio todo mundo que você já baniu.
            </li>
            <li>
              <strong>Denúncias que outras pessoas fizeram sobre você</strong>,
              incluindo a cópia do conteúdo denunciado guardada como prova, com
              o seu id removido. Uma denúncia tem que sobreviver ao que ela
              aponta, senão excluir a conta seria um jeito de destruir o
              registro da sua própria conduta. Denúncias já resolvidas são
              apagadas depois de 90 dias.
            </li>
            <li>
              <strong>Denúncias que você fez sobre outras pessoas</strong>, com
              o seu id removido. São registros da conduta de outra pessoa, e uma
              fila aberta não pode se esvaziar porque quem denunciou foi embora.
            </li>
          </ul>
          <p>
            Fora esses, a gente pode guardar o mínimo necessário para cumprir
            obrigação legal ou para exercer direitos em processo.
          </p>
        </>
      ),
    },
    {
      id: "rights",
      sourceRev: "c13ef77e",
      heading: "Os seus direitos, e como usar",
      body: (
        <>
          <p>
            O art. 18 da LGPD te dá os direitos abaixo, e os arts. 15–21 do UK
            GDPR te dão os mesmos com outros nomes. Os dois mais pesados —{" "}
            <strong>conseguir uma cópia dos seus dados e excluir a sua conta</strong>{" "}
            — são self-service no app, em <span lang="en">Settings</span>, na
            seção <span lang="en">&quot;Your data&quot;</span>. Outros são
            self-service em outros pontos das configurações, e o resto é tratado
            por uma pessoa. Onde um controle não existe, a gente diz isso em vez
            de descrever um botão que não foi construído.
          </p>
          <ul>
            <li>
              <strong>
                Confirmação de que a gente trata os seus dados, e acesso a eles
                (art. 18, I e II)
              </strong>{" "}
              — self-service: <strong lang="en">Download my data</strong>, em{" "}
              <span lang="en">Settings</span>, na seção{" "}
              <span lang="en">&quot;Your data&quot;</span>, monta um arquivo com
              os dados de conta, as configurações e as mensagens que a gente tem
              sobre você, incluindo a sua declaração de 18+. Para o que esse
              arquivo não cobrir, escreva para <strong>contato@pqp.gg</strong>.
            </li>
            <li>
              <strong>
                Correção de dados incompletos ou desatualizados (art. 18, III)
              </strong>{" "}
              — self-service: mude o seu nome de exibição, a sua tag, o seu
              avatar e as suas configurações em{" "}
              <span lang="en">Settings</span>, dentro do app. Para o que você
              não conseguir mudar lá, escreva para a gente.
            </li>
            <li>
              <strong>
                Anonimização, bloqueio ou eliminação de dados desnecessários ou
                excessivos (art. 18, IV)
              </strong>{" "}
              — escreva para a gente descrevendo o que quer remover. Você também
              pode apagar as suas próprias mensagens uma a uma no app, ou
              excluir a conta inteira você mesmo — veja o art. 18, VI abaixo.
            </li>
            <li>
              <strong>Portabilidade (art. 18, V)</strong> — self-service:{" "}
              <strong lang="en">Download my data</strong> te dá um arquivo JSON
              estruturado e legível por máquina. Ele traz o seu perfil, as suas
              configurações, a sua declaração de 18+, os servidores em que você
              está e o seu cargo em cada um, todas as mensagens que você
              escreveu com o canal e o servidor em que estavam e os arquivos
              anexados a elas, as conversas de que você participou, quem você
              bloqueou, as denúncias que você fez e as ações de moderação que
              você tomou. Contas muito grandes têm um limite, e o arquivo avisa
              quando foi cortado. (<em>Donos</em> de servidor também podem
              exportar um servidor inteiro em{" "}
              <span lang="en">Server Settings</span>, mas essa é uma ferramenta
              de dono que cobre as mensagens de todo mundo naquele servidor —
              não é uma exportação de dados pessoais.)
            </li>
            <li>
              <strong>
                Eliminação dos dados tratados com consentimento (art. 18, VI)
              </strong>{" "}
              — self-service: <strong lang="en">Delete my account</strong>, em{" "}
              <span lang="en">Settings</span>, na seção{" "}
              <span lang="en">&quot;Your data&quot;</span>. Você confirma
              digitando a sua própria tag. É permanente, não tem como desfazer e
              não existe backup para restaurar, e é exclusão de verdade em vez
              de conta escondida: o seu perfil, as configurações, todas as
              mensagens que você escreveu em qualquer lugar, as suas reações,
              menções, marcadores de leitura, participações em servidores e em
              conversas, os convites que você criou e os arquivos que você
              enviou vão todos embora, e a sua conta no Clerk é excluída
              também. Alguns registros de moderação ficam para trás — veja
              &quot;O que sobrevive à exclusão da sua conta&quot; acima.{" "}
              <strong>Uma coisa impede:</strong> se você ainda é dono de um
              servidor com outras pessoas dentro, a gente recusa e diz quais são
              esses servidores, porque levar o servidor junto destruiria as
              mensagens de todo mundo lá dentro para atender o seu pedido.
              Transfira o servidor para outro membro, ou apague o servidor, e
              depois exclua a sua conta. Servidor onde não tem mais ninguém não
              é problema — ele vai junto com a conta. Para o que isso não
              cobrir, escreva para <strong>contato@pqp.gg</strong>.
            </li>
            <li>
              <strong>
                Informação sobre com quem a gente compartilha dados (art. 18,
                VII)
              </strong>{" "}
              — a lista está em &quot;Quem mais vê os seus dados&quot; acima;
              escreva para a gente se quiser mais detalhe.
            </li>
            <li>
              <strong>
                Informação sobre a possibilidade de não consentir e as
                consequências (art. 18, VIII)
              </strong>{" "}
              — os únicos recursos baseados em consentimento são opcionais, como
              as notificações no desktop. Não consentir desliga aquele recurso e
              nada mais.
            </li>
            <li>
              <strong>Revogação do consentimento (art. 18, IX)</strong> —
              desligue o recurso em <span lang="en">Settings</span> ou revogue a
              permissão no navegador.
            </li>
          </ul>
          <p>
            <strong>O que a sua exportação deixa de fora, e por quê.</strong>{" "}
            Ela contém as mensagens que <em>você</em> escreveu. Não contém
            mensagens que outras pessoas escreveram, incluindo a outra metade
            das suas mensagens diretas. Aquelas palavras são dado pessoal delas,
            não seu — o direito de acesso é o direito de acesso a dados sobre{" "}
            <em>você</em>, e uma mensagem que outra pessoa escreveu é a
            expressão dessa pessoa. Deixar isso de fora te custa muito pouco:
            você continua podendo ler cada uma dessas mensagens no app,
            exatamente como sempre pôde. O que muda é só se as palavras de outra
            pessoa viram um arquivo que pode ser encaminhado, publicado ou
            entregue a um terceiro em uma ação só. Pelo mesmo motivo, uma
            denúncia que você fez lista o que você disse e quem você denunciou,
            mas não a cópia do conteúdo denunciado. No lugar da transcrição, o
            arquivo lista cada conversa de que você participou, quem mais estava
            nela, quando ela teve movimento pela última vez e quantas das
            mensagens eram suas. Se você precisar mesmo do outro lado — um
            processo judicial, uma denúncia de assédio — escreva para{" "}
            <strong>contato@pqp.gg</strong>, e esse pedido é avaliado a mão. Não
            existe caminho self-service para as mensagens de outra pessoa, e não
            deveria existir.
          </p>
          <p>
            <strong>Como fazer um pedido.</strong> Escreva para{" "}
            <strong>contato@pqp.gg</strong> do e-mail da sua conta, dizendo o
            que você quer. A gente pode pedir informação para confirmar que é
            você mesmo — e não vai pedir mais do que o necessário. O art. 19 da
            LGPD nos dá até <strong>15 dias</strong> para uma resposta completa
            e a lei do Reino Unido permite um mês; a gente trabalha com o prazo
            mais curto. Esses são prazos legais, não um nível de serviço que a
            gente inventou, e são os únicos prazos deste site que não somos nós
            que definimos.
          </p>
          <p>
            <strong>O que a gente ainda não consegue fazer.</strong> Excluir a
            sua conta <em>de fato</em> tira as mensagens que você escreveu das
            conversas de outras pessoas, incluindo as mensagens diretas delas
            com você. O custo honesto é que o lado delas dessas conversas fica
            com buracos onde estava a sua metade, e não tem como dar exclusão a
            alguém sem isso. O que a gente não alcança é a cópia que já saiu dos
            nossos sistemas: as suas mensagens ainda vão estar em uma exportação
            que um dono de servidor rodou antes de você sair, e em qualquer
            print que outro membro tirou.
          </p>
          <p>
            Você também tem o direito de reclamar a uma autoridade se achar que
            a gente tratou os seus dados de forma errada: no Brasil, a{" "}
            <strong>ANPD (Autoridade Nacional de Proteção de Dados)</strong>; no
            Reino Unido, o{" "}
            <strong>Information Commissioner&apos;s Office (ICO)</strong>.
          </p>
        </>
      ),
    },
    {
      id: "controls",
      sourceRev: "b7056055",
      heading: "Controles que você tem no app hoje",
      body: (
        <ul>
          <li>
            <strong>Bloqueio.</strong> Bloquear alguém impede que qualquer um
            dos dois abra ou mande mensagem direta para o outro, e faz as
            mensagens da pessoa pararem de te notificar. Saiba do limite:{" "}
            <strong>bloquear não é ficar invisível</strong> — em um servidor
            onde vocês dois estão, a pessoa continua vendo as mensagens que você
            publica lá, e você continua vendo que ela publicou, recolhido.
          </li>
          <li>
            <strong>Privacidade de DM.</strong> Escolha quem pode começar uma DM
            com você: todo mundo, só quem compartilha um servidor com você (o
            padrão), ou ninguém. Isso vale para conversas novas; não fecha as
            que já existem.
          </li>
          <li>
            <strong>Apagar as suas próprias mensagens</strong> e sair de
            qualquer servidor.
          </li>
          <li>
            <strong>Baixar os seus dados e excluir a sua conta</strong> — em{" "}
            <span lang="en">Settings</span>, na seção{" "}
            <span lang="en">&quot;Your data&quot;</span>. Os dois estão
            descritos acima.
          </li>
        </ul>
      ),
    },
    {
      id: "security",
      sourceRev: "8fd809d4",
      heading: "Segurança",
      body: (
        <p>
          O tráfego é criptografado em trânsito. O áudio de voz é criptografado
          entre os participantes. Os links de anexo são de vida curta e
          assinados, em vez de públicos. O nosso servidor se recusa a buscar
          prévia de link em endereços de rede interna. Nenhum sistema é
          perfeitamente seguro, e este é mantido por uma pessoa sem equipe de
          segurança atrás — se você encontrar uma vulnerabilidade, por favor
          conte para a gente em <strong>contato@pqp.gg</strong> antes de contar
          para qualquer outra pessoa. Se um incidente de segurança criar risco
          real para você, a gente comunica você e a autoridade competente, como
          exigem o art. 48 da LGPD e os arts. 33–34 do UK GDPR.
        </p>
      ),
    },
    {
      id: "self-hosted",
      sourceRev: "1eb5616f",
      heading: "Instâncias self-hosted",
      body: (
        <p>
          Se você roda o pqp por conta própria, você escolhe o banco de dados, a
          aplicação do Clerk e a hospedagem, e você é o controlador dos seus
          usuários. O pqp.gg não recebe os dados dos seus usuários. A nossa
          publicidade também não chega na sua cópia: a tag de conversão do
          Google Ads descrita acima é adicionada só na compilação do pqp.gg, então
          uma instância self-hosted sai sem ela. Conte para os seus membros como
          você lida com as informações deles.
        </p>
      ),
    },
    {
      id: "changes",
      sourceRev: "d2252693",
      heading: "Mudanças",
      body: (
        <p>
          A gente pode atualizar esta política. A data de atualização no topo
          vai mudar, e a gente avisa no app antes de mudanças que afetem você de
          forma relevante passarem a valer.
        </p>
      ),
    },
    {
      id: "contact",
      sourceRev: "7751323d",
      heading: "Contato",
      body: (
        <p>
          Pedidos de privacidade, abuso e segurança, relatos de vulnerabilidade
          e qualquer outra coisa desta página: <strong>contato@pqp.gg</strong>.
          Um endereço, lido pela única pessoa que toca o pqp.gg.
        </p>
      ),
    },
  ],
};
