import { Link } from "react-router-dom";
import type { LegalDocument } from "./document";

/**
 * Termos de Uso em português do Brasil. Tradução de `terms.en.tsx` — o inglês é
 * a fonte da verdade, e `sourceRev` em cada seção diz contra qual versão do
 * inglês aquele texto foi escrito. Se o inglês mudar, `documents.test.ts` quebra
 * e aponta a seção; a saída é revisar o português e carimbar o novo valor.
 *
 * Registro: o mesmo do resto do produto — frases curtas, "você", sem ponto de
 * exclamação e sem juridiquês. O documento em inglês foi escrito de propósito
 * para ser lido por qualquer pessoa; transformá-lo em petição aqui seria um
 * documento pior, não melhor.
 *
 * Termos que ficam em inglês: `pqp`, `contato@pqp.gg`, os nomes de recurso que
 * brasileiro fala em inglês (chat, kick, ban, self-host, open source) e as
 * citações de artigos de lei. Os rótulos de botão do app (`Settings`,
 * `Delete my account`, `Your data`) também ficam em inglês porque a interface
 * ainda está em inglês — mandar a pessoa procurar &quot;Excluir minha conta&quot;
 * em uma tela que diz &quot;Delete my account&quot; seria uma instrução errada.
 * Quando a interface for traduzida, estes rótulos mudam junto.
 */
export const termsPtBr: LegalDocument = {
  locale: "pt-BR",
  path: "/terms",
  title: "Termos de Uso — pqp",
  description:
    "Termos de uso do serviço hospedado pqp.gg: o que o pqp é de verdade, quem pode usar (18+), uso aceitável, moderação, denúncias e remoção de conteúdo.",
  heading: "Termos de Uso",
  updated: "5 de novembro de 2026",
  sections: [
    {
      id: "intro",
      sourceRev: "70b87c2b",
      body: (
        <p>
          Estes termos valem para o serviço hospedado em <strong>pqp.gg</strong>
          , que é tocado por <strong>uma pessoa, não uma empresa</strong>.
          &quot;Nós&quot; e &quot;a gente&quot;, daqui pra baixo, são essa
          pessoa. Ao criar uma conta ou usar o app, você concorda com estes
          termos. Cópias self-hosted do software open source seguem a licença do
          projeto e os termos que você definir para os seus próprios usuários —
          não estes termos do serviço hospedado.
        </p>
      ),
    },
    {
      id: "before-you-move",
      sourceRev: "180beac5",
      heading: "Leia isto antes de trazer a sua galera pra cá",
      body: (
        <>
          <p>
            O pqp é um projeto pessoal, feito por diversão por uma pessoa no
            tempo livre dela, com a família ajudando no produto. Não tem
            empresa, não tem produto pago e não tem central de atendimento. Quem
            lê o seu e-mail é quem escreveu o código, e essa mesma pessoa analisa
            toda denúncia de abuso em até 24 horas (veja Uso aceitável e
            Denunciar abuso, mais abaixo). Essa promessa é sobre denúncias; o
            &quot;no estado em que se encontra&quot; mais adiante é sobre
            disponibilidade e recursos. Dá para mandar um presente
            para a hospedagem pelo GitHub Sponsors ou Pix, em{" "}
            <Link to="/apoie">/apoie</Link>. Isso não destrava nada: sem selo,
            sem recurso extra, sem reembolso. O serviço é oferecido{" "}
            <strong>no estado em que se encontra</strong>: não existe garantia
            de disponibilidade, não existe nível de serviço nenhum e não existe
            promessa de que o pqp.gg vai estar de pé no ano que vem. Recursos
            podem mudar ou sumir, e a coisa toda pode parar. A gente avisaria se
            desse, mas nem isso dá pra prometer.
          </p>
          <p>
            Isso está no topo porque mudar um grupo de amigos de app de conversa
            é uma decisão que você deveria tomar com o quadro real na frente. O
            resto desta página é escrito do mesmo jeito: o que é verdade,
            inclusive as partes que não estão prontas.
          </p>
        </>
      ),
    },
    {
      id: "age",
      sourceRev: "9c06c23c",
      heading: "Você precisa ter 18 anos ou mais",
      body: (
        <>
          <p>
            <strong>O pqp.gg é só para adultos.</strong> Você só pode criar uma
            conta ou usar o serviço se tiver{" "}
            <strong>18 anos ou mais</strong>. Não existe versão do pqp.gg para
            menores de idade, e não existe caminho de consentimento dos pais que
            torne aceitável uma conta de quem tem menos de 18 anos. Ao se
            cadastrar, você confirma que tem 18 anos ou mais e que é legalmente
            capaz de aceitar estes termos.
          </p>
          <p>
            Se a gente souber que uma conta é de alguém com menos de 18 anos,
            ela vai ser encerrada e os dados ligados a ela apagados, sem aviso.
            Encerramento por segurança de menor não tem recurso. Se você
            digitou a data errada na checagem de 18 anos, escreva para{" "}
            <strong>contato@pqp.gg</strong> pelo e-mail dessa conta: isso é
            data digitada errada, não recurso de uma decisão de segurança de
            menor. A gente também pode encerrar quando tiver uma suspeita de
            boa-fé de que o titular da conta tem menos de 18 anos — por exemplo,
            pelo que a pessoa fala no chat ou por uma denúncia que a gente
            recebe.
          </p>
          <p>
            <strong>
              Para denunciar uma conta que você acredita ser de menor de idade
            </strong>
            , escreva para <strong>contato@pqp.gg</strong> com a tag do usuário
            (o <code>name#1234</code> da pessoa), o servidor ou a DM onde você
            viu, e o que te levou a acreditar que ela tem menos de 18 anos.
            Denúncias sobre menores de idade são tratadas antes de todo o resto.
            Você não precisa ter conta para enviar uma.
          </p>
          <p>
            Hoje a gente não verifica idade com documento nem com um serviço
            terceirizado de comprovação de idade. O requisito é aplicado no
            cadastro por autodeclaração e, depois disso, por ação sobre denúncia
            — a gente diz isso com todas as letras em vez de dar a entender que
            existe uma checagem que não é feita.
          </p>
        </>
      ),
    },
    {
      id: "service",
      sourceRev: "13359b9c",
      heading: "O serviço",
      body: (
        <p>
          O pqp é um produto de chat e voz em tempo real: servidores, canais de
          texto e de voz, mensagens diretas, convites, perfil público opcional,
          contas de jogo ligadas se você quiser, e o que vem junto. É de graça,
          e não existe plano pago. Uma contribuição em{" "}
          <Link to="/apoie">/apoie</Link> não muda isso. A gente pode mudar,
          pausar ou encerrar qualquer parte disso.
        </p>
      ),
    },
    {
      id: "accounts",
      sourceRev: "cb22aa2b",
      heading: "Contas",
      body: (
        <>
          <p>
            Você entra pelo Clerk, um provedor de identidade terceirizado. O
            Clerk guarda as suas credenciais de login e o seu e-mail; o pqp
            guarda um nome de exibição, uma tag <code>name#1234</code>, a URL de
            um avatar e os domínios dos seus e-mails verificados. Guarde bem as
            suas credenciais. Você é responsável pelo que acontece na sua conta.
            Informe dados corretos e não se passe por outras pessoas, por marcas
            nem pelo próprio pqp.
          </p>
          <p>
            Uma pessoa, uma conta. Não crie contas para escapar de um ban, e não
            venda, alugue nem transfira a sua conta.
          </p>
        </>
      ),
    },
    {
      id: "acceptable-use",
      sourceRev: "748b4f44",
      heading: "Uso aceitável",
      body: (
        <>
          <p>
            <strong>
              O pqp tem tolerância zero com conteúdo inadequado e com usuários
              abusivos.
            </strong>{" "}
            Qualquer pessoa pode denunciar um conteúdo ou uma pessoa de dentro
            do app, e qualquer pessoa pode bloquear alguém. A gente analisa
            toda denúncia em até 24 horas. Quando a violação é confirmada, a
            gente remove o conteúdo e remove a conta que o publicou.
          </p>
          <p>Não use o pqp.gg para:</p>
          <ul>
            <li>
              Sexualizar menores de idade de qualquer forma, ou compartilhar,
              pedir ou linkar material de abuso sexual infantil. Esta é a única
              regra sem etapa de aviso: significa encerramento imediato e, onde
              a lei exigir, comunicação às autoridades competentes.
            </li>
            <li>
              Assediar, ameaçar, perseguir ou organizar linchamento virtual
              contra alguém; incitar violência ou automutilação
            </li>
            <li>
              Promover ódio contra pessoas por raça, cor, etnia, origem
              nacional, religião, deficiência, sexo, orientação sexual ou
              identidade de gênero
            </li>
            <li>
              Divulgar informação privada de alguém sem consentimento (doxxing),
              ou divulgar imagem íntima de alguém sem o consentimento dessa
              pessoa
            </li>
            <li>Descumprir a lei, ou planejar ou coordenar atividade ilegal</li>
            <li>
              Distribuir malware, aplicar phishing ou fraude, mandar spam ou
              raspar o serviço de forma abusiva
            </li>
            <li>
              Tentar invadir contas, servidores ou infraestrutura, ou burlar
              limites de uso e controles de acesso
            </li>
            <li>
              Violar propriedade intelectual ou privacidade de outras pessoas
            </li>
            <li>
              Gravar conversas de voz sem o consentimento das pessoas que estão
              nelas, onde a lei exigir esse consentimento
            </li>
            <li>
              Automatizar o serviço de um jeito que piore ele para as outras
              pessoas
            </li>
          </ul>
          <p>
            Donos e admins de servidor são responsáveis pelas comunidades que
            tocam. Manter um servidor cujo propósito aparente é quebrar estas
            regras já é, por si só, uma violação.
          </p>
        </>
      ),
    },
    {
      id: "filtering",
      sourceRev: "0edb23a3",
      heading: "O que a gente filtra automaticamente",
      body: (
        <>
          <p>
            O pqp confere o que você publica antes de outras pessoas verem.
            Quando uma conferência recusa algo, você é avisado na hora e o
            conteúdo não é publicado.
          </p>
          <ul>
            <li>
              <strong>Texto.</strong> Mensagens e edições em canais de
              servidor, posts de fórum, stories, comentários e posts do Baú, e
              os nomes e o recado que você escolhe para si são comparados com
              uma lista embutida de ofensas discriminatórias e ameaças
              (inclusive mandar alguém se matar, ameaça de estupro e conteúdo
              sexual com crianças), em inglês, português e espanhol. Se bater,
              não é enviado e você vê: &quot;This message was not sent: it
              breaks pqp&apos;s rules on abusive language.&quot; (no app em
              português: &quot;Essa mensagem não foi enviada: ela quebra as
              regras do pqp sobre linguagem abusiva.&quot;). Xingamento e
              palavrão do dia a dia não estão na lista. Mensagens diretas e
              mensagens de grupo não são lidas por esse filtro. O filtro vem
              ligado em todo servidor. O dono do servidor pode desligar para o
              servidor dele nas configurações do AutoMod, e pode somar as
              próprias palavras bloqueadas, links e limites de menção.
            </li>
            <li>
              <strong>Imagens.</strong> Uma imagem nova anexada a uma mensagem,
              ou publicada no Baú de uma comunidade, é checada por um serviço
              automático de segurança de imagem antes de qualquer outra pessoa
              ver. Se não passar, é descartada.
            </li>
            <li>
              <strong>O que nenhum programa confere.</strong> Arquivos de vídeo,
              áudio e PDF, fotos de perfil e banners, e ícones de servidor não
              são varridos automaticamente hoje; para esses, o caminho é a
              denúncia. Chamadas de voz não são escutadas. O nome que vem da
              sua conta de login quando você se cadastra não passa pelo filtro
              de texto.
            </li>
          </ul>
          <p>
            Filtro automático é uma primeira linha, não um moderador. Ele deixa
            passar coisa, e às vezes pega algo inofensivo. Não substitui a
            denúncia: se algo passar, denuncie, e a gente analisa toda denúncia
            em até 24 horas.
          </p>
        </>
      ),
    },
    {
      id: "your-content",
      sourceRev: "3ab311f9",
      heading: "O seu conteúdo",
      body: (
        <p>
          Você continua dono das mensagens, dos arquivos e do resto do conteúdo
          que publica, inclusive um perfil público, um banner, depoimentos e um
          layout do Discord que você cola ao criar um servidor. Você nos concede
          uma licença limitada e não exclusiva para hospedar, armazenar,
          transmitir e exibir esse conteúdo para o produto funcionar — por
          exemplo, mostrar o seu histórico de mensagens para os membros do seu
          servidor, ou mostrar um depoimento aprovado numa página pública que
          você publicou. Essa licença existe para operar o serviço e termina
          quando o conteúdo é apagado, exceto pelas cópias que a gente precise
          manter para cumprir uma obrigação legal. Você é responsável pelo
          que publica e por ter o direito de publicar, inclusive qualquer ícone
          de servidor que você importar.
        </p>
      ),
    },
    {
      id: "moderation",
      sourceRev: "87aae367",
      heading: "Moderação e aplicação das regras",
      body: (
        <>
          <p>
            A maior parte da moderação no pqp acontece dentro do servidor, feita
            por quem toca ele. Donos e admins de servidor podem:
          </p>
          <ul>
            <li>Apagar mensagens nos canais deles</li>
            <li>Remover (kick) um membro do servidor</li>
            <li>
              Banir um membro do servidor, o que remove a pessoa e impede que
              ela entre de novo
            </li>
            <li>Mudar cargos e restringir quem pode publicar onde</li>
          </ul>
          <p>
            Ações no nível do servidor são gravadas no log de auditoria daquele
            servidor, então os membros com acesso conseguem ver quem fez o quê.
          </p>
          <p>
            Separadamente, a gente pode agir no nível da plataforma quando
            recebe uma denúncia ou fica sabendo de um problema de outra forma.
            Dependendo da gravidade e do histórico, isso pode ser: remover
            conteúdo específico, restringir a capacidade de uma conta publicar,
            tirar um servidor do serviço hospedado, suspender uma conta ou
            encerrar uma conta em definitivo. Uma violação confirmada das regras de
            uso aceitável acima termina com o conteúdo removido e com a conta
            que o publicou removida. Para conteúdo envolvendo menores de idade,
            ameaça crível de violência ou material de abuso sexual infantil, isso
            acontece primeiro e sem aviso.
          </p>
          <p>
            A gente também pode suspender contas ou servidores que coloquem o
            serviço ou outras pessoas em risco, incluindo abuso da própria
            infraestrutura.
          </p>
        </>
      ),
    },
    {
      id: "reporting",
      sourceRev: "97a657bd",
      heading: "Como denunciar abuso",
      body: (
        <>
          <p>
            Se você tem conta, use a ação <strong>Denunciar</strong> numa
            mensagem, num membro ou no cartão de uma comunidade. Esse é o canal
            de denúncia. Ele manda um recorte do conteúdo denunciado para quem
            pode agir. Dá para bloquear uma pessoa de dentro do app também, o
            que esconde as mensagens dela para você.
          </p>
          <p>
            Você também pode escrever para <strong>contato@pqp.gg</strong>. É
            assim que se denuncia sem ter conta, e como denunciar uma conta que
            você acredita ser de menor de idade. Inclua:
          </p>
          <ul>
            <li>
              O que você está denunciando — uma mensagem, uma pessoa, um
              servidor, uma DM
            </li>
            <li>
              Onde está: o nome do servidor, o nome do canal e a tag do usuário
              (<code>name#1234</code>)
            </li>
            <li>Por que isso quebra estes termos, em uma ou duas frases</li>
            <li>Prints, se você tiver, e mais ou menos quando aconteceu</li>
          </ul>
          <p>
            <strong>O que acontece depois.</strong> A gente analisa toda denúncia
            em até 24 horas. Denúncias envolvendo menores de idade, perigo
            físico iminente ou imagens íntimas sem consentimento furam a fila.
            Se a denúncia procede, o conteúdo é removido e a conta que o
            publicou também.
          </p>
          <p>
            <strong>Uma coisa não tem ressalva.</strong> Conteúdo que sexualiza
            menor de idade e material de abuso sexual infantil são removidos
            assim que vistos, a conta é encerrada e o caso é comunicado às
            autoridades competentes. Sem fila, sem prazo, sem recurso.
          </p>
          <p>
            A gente conta o resultado para você quando dá para fazer isso sem
            expor dado pessoal de outra pessoa.
          </p>
          <p>
            Não use a denúncia para assediar alguém. Denúncias repetidas de
            má-fé são, elas mesmas, uma violação.
          </p>
        </>
      ),
    },
    {
      id: "copyright",
      sourceRev: "c5ef3d5e",
      heading: "Direitos autorais e outras notificações legais",
      body: (
        <>
          <p>
            Se você acredita que um conteúdo no pqp.gg viola os seus direitos
            autorais ou outros direitos, mande uma notificação para{" "}
            <strong>contato@pqp.gg</strong> identificando a obra, a localização
            exata do conteúdo, os seus dados de contato e uma declaração de que
            você é o titular dos direitos ou está autorizado a agir por ele. A
            gente analisa e remove o conteúdo quando a alegação se sustenta.
          </p>
          <p>
            Ordens judiciais e outras notificações legais formais vão para o
            mesmo endereço. Não existe sede registrada para receber citação,
            porque não existe empresa — o pqp.gg é tocado por uma pessoa física
            no Reino Unido. Remoção de conteúdo que a lei do seu país nos obrigue
            a fazer é algo que a gente faz; uma notificação que só afirma um
            direito é algo que a gente lê e avalia.
          </p>
        </>
      ),
    },
    {
      id: "appeals",
      sourceRev: "e9b86a1f",
      heading: "Recursos",
      body: (
        <>
          <p>
            Se a gente suspender ou encerrar a sua conta ou remover o seu
            conteúdo e você achar que a gente errou, responda a mensagem da
            punição ou escreva para <strong>contato@pqp.gg</strong> em até 30
            dias. Diga o que foi feito e por que você acha que foi um erro.
          </p>
          <p>
            A gente não vai fingir que o recurso chega a um revisor
            independente: quem tomou a primeira decisão é a única pessoa que
            existe, e o que ela vai fazer é olhar de novo com o que você contou.
            Não existe prazo prometido. Decisões sobre contas encerradas por
            motivo de segurança infantil são definitivas.
          </p>
          <p>
            Recurso sobre ação que o <em>dono de um servidor</em> tomou dentro
            do servidor dele — um kick, um ban, uma mensagem apagada — vai para
            o dono daquele servidor, não para a gente. A gente não reverte
            decisão de moderação da comunidade, a menos que o próprio servidor
            esteja quebrando estes termos.
          </p>
        </>
      ),
    },
    {
      id: "our-stuff",
      sourceRev: "e5f789dd",
      heading: "As nossas coisas",
      body: (
        <p>
          O nome pqp, a identidade visual do pqp.gg e a infraestrutura hospedada
          são nossos. O código open source está disponível sob a licença do
          projeto — separada do serviço hospedado.
        </p>
      ),
    },
    {
      id: "voice",
      sourceRev: "6e4ce0a9",
      heading: "Voz e mídia",
      body: (
        <p>
          A voz usa WebRTC. No caminho direto, o áudio e o vídeo de tela
          compartilhada vão direto entre os participantes e não passam por
          servidor nenhum nosso. No caminho repassado, eles passam por um
          servidor de mídia que a gente mesmo roda, em São Paulo, Miami ou
          Londres, que repassa e não guarda nada: nenhuma chamada comum é
          gravada nem armazenada pela gente, em nenhum dos dois caminhos. Uma
          chamada num servidor pode passar do caminho direto para o repassado
          enquanto está acontecendo. Uma
          watch party é diferente. É uma transmissão que a gente leva ao
          público e grava, e a gravação fica guardada por 30 dias. Quais salas
          são quais, e o que esse repasse e essa gravação significam para os
          seus dados, está na{" "}
          <Link to="/privacy">Política de Privacidade</Link>. A fila de música
          numa chamada de voz toca um vídeo do YouTube no aparelho de cada um; a gente não hospeda esse stream. O caminho
          direto tem um teto prático: cada pessoa no canal se conecta com todas
          as outras, então uma sala direta cheia pesa na conexão de todo mundo.
          A qualidade depende da sua rede e, no caminho direto, da rede das
          outras pessoas também, e a gente não garante áudio sem interrupção.
          Você responde pelo que compartilha na tela, pelo que toca na fila de
          música e pelo que transmite numa watch party.
        </p>
      ),
    },
    {
      id: "termination",
      sourceRev: "bbcc734b",
      heading: "Encerramento por você",
      body: (
        <p>
          Você pode parar de usar o pqp.gg quando quiser. Para excluir a sua
          conta, use{" "}
          <strong lang="en">Delete my account</strong> em{" "}
          <span lang="en">Settings</span>, na seção{" "}
          <span lang="en">&quot;Your data&quot;</span>. É permanente e não tem
          como desfazer. Veja a{" "}
          <Link to="/privacy">Política de Privacidade</Link> para o que a gente
          apaga e o que precisa manter.
        </p>
      ),
    },
    {
      id: "disclaimer",
      sourceRev: "888f5eb4",
      heading: "Isenção de garantias",
      body: (
        <p>
          O serviço é oferecido &quot;no estado em que se encontra&quot;. Na
          máxima extensão permitida pela lei, a gente não dá garantia de
          comercialização, de adequação a uma finalidade específica nem de não
          violação de direitos de terceiros. A gente não promete que o serviço
          vai estar livre de erros nem sempre disponível. Guarde as suas
          próprias cópias de qualquer coisa que você ficaria triste de perder.
        </p>
      ),
    },
    {
      id: "liability",
      sourceRev: "773088da",
      heading: "Limitação de responsabilidade",
      body: (
        <>
          <p>
            Na máxima extensão permitida pela lei, o pqp e quem o administra não
            respondem por danos indiretos, incidentais, especiais ou
            consequentes, nem por perda de dados, de lucros ou de reputação
            decorrente do uso do pqp.gg. O serviço é gratuito, então a nossa
            responsabilidade total por qualquer reclamação relacionada a ele é
            limitada a zero, e ao que você tiver pagado para a gente se isso um
            dia mudar.
          </p>
          <p>
            <strong>
              Nada nestes termos retira direitos que você tem por lei
              imperativa.
            </strong>{" "}
            Se você está no Brasil, isso inclui o Código de Defesa do Consumidor
            (Lei nº 8.078/1990) e a Lei Geral de Proteção de Dados (Lei nº
            13.709/2018); se você está no Reino Unido ou na União Europeia,
            inclui os seus direitos de consumidor e de proteção de dados de lá.
            Quando uma cláusula acima conflitar com um direito ao qual você não
            pode renunciar, esse direito prevalece e o resto destes termos
            continua valendo.
          </p>
        </>
      ),
    },
    {
      id: "indemnity",
      sourceRev: "8bdbd468",
      heading: "Indenização",
      body: (
        <p>
          Você concorda em nos indenizar por reclamações decorrentes do seu
          conteúdo ou do seu uso indevido do serviço, na medida permitida pela
          lei.
        </p>
      ),
    },
    {
      id: "governing-law",
      sourceRev: "cccd7c4e",
      heading: "Lei aplicável e foro",
      body: (
        <p>
          O pqp.gg é operado a partir do Reino Unido. Estes termos são regidos
          pelas <strong>leis da Inglaterra e do País de Gales</strong>, e os
          litígios ficam sujeitos aos{" "}
          <strong>tribunais da Inglaterra e do País de Gales</strong>. Se você
          usa o pqp.gg como consumidor, regras imperativas podem permitir que
          você acione a Justiça do país onde mora, independentemente dessa
          escolha — e quem está no Brasil mantém os seus direitos sob o Código
          de Defesa do Consumidor e a LGPD, não importa em que país esteja quem
          administra o serviço. A gente não vai discutir o contrário.
        </p>
      ),
    },
    {
      id: "privacy",
      sourceRev: "1687fb1e",
      heading: "Privacidade",
      body: (
        <p>
          A nossa <Link to="/privacy">Política de Privacidade</Link> explica
          como a gente lida com dados pessoais. O nosso{" "}
          <Link to="/cookies">Aviso de cookies</Link> cobre cookies e
          armazenamento local.
        </p>
      ),
    },
    {
      id: "changes",
      sourceRev: "699fd0b4",
      heading: "Mudanças",
      body: (
        <p>
          A gente pode atualizar estes termos. Continuar usando depois da data
          de atualização no topo desta página significa que você aceita os novos
          termos. Para mudanças que reduzam os seus direitos de forma relevante,
          a gente avisa no app ou por e-mail antes de elas passarem a valer. Se
          você não concordar, pare de usar o pqp.gg e exclua a sua conta.
        </p>
      ),
    },
    {
      id: "contact",
      sourceRev: "eca5ae40",
      heading: "Contato",
      body: (
        <>
          <p>
            Um endereço para tudo — suporte, denúncias de abuso e de segurança,
            contas de menores de idade, pedidos de privacidade, divulgação de
            vulnerabilidade, notificações legais e recursos:{" "}
            <strong>contato@pqp.gg</strong>.
          </p>
          <p>
            É a caixa de entrada de uma pessoa só, e isso é de propósito. Mais
            cinco endereços seriam mais cinco caixas que ninguém lê.
          </p>
        </>
      ),
    },
  ],
};
