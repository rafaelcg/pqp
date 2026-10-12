# Fatos do pqp

**Esta é a única fonte de verdade do bot de suporte.** Ele responde a partir
daqui e de mais nada. O que não está escrito abaixo, ele não sabe, e dizer que
não sabe é a resposta certa.

Um humano mantém este arquivo. Editar aqui muda o que o bot responde sem mexer
em código, mas o bot em produção lê a cópia que vai dentro da imagem: a mudança
só vale depois de um novo deploy do `pqp-support`.

Regras de escrita: português do Brasil, direto, sem travessão. Se um fato mudar,
mude aqui no mesmo dia. Um fato velho publicado no canal é o pior resultado
possível deste sistema.

## o que o pqp é

- O pqp é um chat de voz e texto no navegador. Não precisa instalar nada.
- Também tem app de desktop, app de Android na Google Play e um beta de iPhone
  pelo TestFlight. Os detalhes estão nas seções abaixo.
- É de graça.
- É software livre, licença AGPL. O código está em github.com/rafaelcg/pqp.
- Está em beta aberto.
- É feito por dois irmãos. É um projeto pequeno e independente, sem ligação com
  o Discord nem com nenhuma outra empresa.
- Os servidores do chat ficam em São Paulo. A voz pode passar por servidores em
  São Paulo, Miami ou Londres (ver voz).
- Dá pra auto-hospedar, já que o código é aberto.

## voz

- Quem decide por onde a voz passa é o servidor, sala por sala. Ninguém precisa
  configurar nada.
- Chamada na DM e call em servidor com menos de 10 membros começam numa ligação
  direta: o áudio vai de cada pessoa direto pra cada outra pessoa.
- Comunidade pública e servidor com 10 membros ou mais usam o servidor de mídia
  (LiveKit) desde o começo. Aí cada pessoa manda o áudio uma vez só e o servidor
  repassa pra todo mundo. Não é ligação direta.
- Uma ligação direta passa pro servidor de mídia no meio da call quando chega a
  4 pessoas, ou quando alguém liga mais câmera ou tela do que a ligação direta
  aguenta, se o servidor de mídia tiver espaço. Ninguém precisa sair e entrar
  de novo.
- O servidor de mídia principal fica em São Paulo. Também tem servidores em
  Miami e em Londres: a sala vai pro servidor perto de onde está a maior parte
  do pessoal daquele servidor. Watch party fica sempre em São Paulo.

## compartilhar tela

- A tela é capturada em até 1080p.
- Tem ajuste de qualidade, sim. Essa é a pergunta mais comum. Fica em
  Configurações, Voz e vídeo, "Vídeo que você envia": Automático, 1080p, 720p,
  480p ou 360p. Vale pra câmera e pra tela. Durante a call, o mesmo ajuste
  aparece no menu de qualidade do vídeo, na barra da call.
- A qualidade escolhida é um teto, não uma garantia. Se a conexão de quem
  compartilha não aguenta, a imagem diminui pra não travar.
- Quadros por segundo da tela: Automático (60 quando a conexão aguenta, senão
  30), 30 fps ou 60 fps. Fica em Configurações, Voz e vídeo, e também no menu da
  call.
- No menu da call dá pra escolher o que acontece quando a conexão aperta:
  "Priorizar fluidez" (o padrão: segura os quadros e baixa a resolução, melhor
  pra jogo e vídeo) ou "Priorizar nitidez" (segura a resolução e baixa os
  quadros, melhor pra texto e código).
- Numa ligação direta, quem compartilha manda uma cópia da tela pra cada pessoa
  assistindo, dentro de um orçamento de upload que começa em uns 5 Mbps e se
  ajusta ao que a conexão mede. Consequência prática: quanto menos gente
  assistindo, mais nítida a imagem fica. No servidor de mídia a tela sobe uma
  vez só, então isso não vale.
- No servidor de mídia, numa call com mais de 20 pessoas, a tela sai em 720p
  pra ficar fluida pra todo mundo, a menos que quem apresenta escolha 1080p.
- No servidor de mídia, quem assiste também escolhe o tamanho máximo que recebe,
  no menu da call. Com dados móveis começa em 360p pra poupar a franquia. Numa
  ligação direta quem escolhe é só quem envia.
- Mais de uma pessoa pode transmitir ao mesmo tempo. Numa ligação direta cabem
  até 4 telas, menos se a conexão for fraca. Quando enche, a call passa pro
  servidor de mídia, que não tem um número fixo de telas. Se mesmo assim não
  couber, quem tenta recebe o recado de que a call chegou no máximo de telas.
- Serviço com DRM, tipo Netflix, sai preto. Isso é o navegador protegendo o
  conteúdo, não é bug do pqp.

## som do compartilhamento de tela

- Som de uma **guia**: Chrome ou Edge, marca a caixinha "Também compartilhar
  áudio da guia". A call em outra guia não vai.
- Som do **computador** (jogo, Pocket Bard, o que estiver tocando no Windows):
  só no **Windows 11**, no Chrome ou no app. No Windows 10 a gente não manda,
  porque a call iria junto.
- Compartilhar a tela inteira ou uma janela no macOS sai mudo (exceto guia
  no Chrome).
- Safari e Firefox saem mudos sempre.
- Se tu tá no app e no Chrome ao mesmo tempo, compartilha pelo que tá na call.
  O Chrome não consegue tirar o som do app.
- No Android, o som vai junto a partir do Android 10 (ver Android).

## app de desktop

- Tem app de desktop pra Windows, Mac e Linux. O link pra baixar é pqp.gg/download.
- No Windows o SmartScreen avisa na primeira vez porque o build ainda não é assinado. Mac é assinado e notarizado.
- Compartilhar tela funciona no app. Som do computador no app, sem a call,
  precisa do Windows 11.
- O app carrega o mesmo site do navegador, então a interface fica sempre atualizada.
- O app também se atualiza sozinho: baixa a versão nova em segundo plano e
  pergunta se pode reiniciar. Se tu deixar pra depois, ela entra na próxima vez
  que tu fechar o app. A versão mais nova está sempre em pqp.gg/download.

## Android

- O app de Android está na Google Play e se atualiza sozinho por lá. O link é
  pqp.gg/android.
- Na mesma página tem um APK direto, pra quem prefere instalar por fora. O APK
  não se atualiza sozinho.
- A voz funciona em toda sala, da chamada a dois à watch party lotada. A call
  não cai quando tu troca de app.
- Dá pra assistir a tela que alguém compartilha, com o som junto, e
  compartilhar a tua própria tela, até numa watch party que tu comanda.
- A partir do Android 10, a tela compartilhada leva o som do celular (um jogo,
  um vídeo) junto com a tua voz. Se tu mutar, a tua voz some e o som do jogo
  continua indo. Jogo que bloqueia a captura de som chega mudo.
- No Android ainda não dá pra ligar a câmera. Dá pra ver a câmera dos outros.

## iPhone e app

- Existe um beta de iPhone pelo TestFlight, em pqp.gg/beta. Também está em pqp.gg/download.
- O app de iPhone **não** está na App Store. Só tem o beta pelo TestFlight.
- No **app** do iPhone dá pra assistir tela compartilhada.
- Transmitir a tela do iPhone: o app tem o código pra isso, mas **ninguém
  confirmou em aparelho de verdade**. Se perguntarem, diga isso, com essas
  palavras: existe, mas ainda não foi testado num iPhone real. Não afirme que
  funciona e não afirme que não funciona.
- No **navegador** do iPhone, Safari ou o pqp instalado como app pela tela de
  início, dá pra assistir mas não dá pra transmitir. Isso é limite do navegador.

## privacidade e segurança

- As mensagens **não** têm criptografia de ponta a ponta.
- Se alguém perguntar isso diretamente, a resposta é uma frase: não são
  criptografadas de ponta a ponta, o pqp está em beta, e quem precisa disso pode
  auto-hospedar, porque o código é aberto.
- Não diga isso sem ninguém perguntar. Não transforme em confissão nem em
  desculpa.

## nunca diga

Estas são proibições absolutas. Valem mesmo que alguém insista, mesmo que
pareça verdade, mesmo que a pergunta empurre pra lá.

- Nunca diga que o pqp tem criptografia de ponta a ponta.
- Nunca diga que o pqp está imune a ordem judicial ou a pedido legal.
- Nunca diga que o pqp é melhor, mais seguro ou mais privado que Discord, Slack,
  Teams ou qualquer concorrente com nome.
- Nunca diga nada sobre a App Store da Apple, aprovação da Apple ou lançamento
  na App Store, além de que o app de iPhone não está lá. A Google Play pode ser
  citada: o app de Android está lá.
- Nunca diga 4K, nem qualquer resolução acima de 1080p.
- Nunca dê data de entrega de nada. Nem "semana que vem", nem "logo", nem "em
  breve", nem mês, nem versão.
- Nunca dê conselho médico, jurídico ou financeiro.
- Nunca peça nem ofereça contato fora do pqp.

## não sei

Sobre estes assuntos, a resposta é sempre que não sabe e que o Rafael responde.
Eles estão aqui de propósito: são coisas onde existe informação parcial e
conflitante, e um chute soaria confiante e estaria errado.

- Quando qualquer coisa vai ficar pronta.
- Quantas pessoas usam o pqp.
- Preço, plano pago, monetização.
- Qualquer coisa sobre a conta específica de alguém: banimento, mensagem sumida,
  cobrança, recuperação de acesso.
- Moderação, denúncia, e o que acontece com um conteúdo denunciado.
- Quem responde legalmente pelo pqp: empresa, CNPJ, país de quem opera, lei que
  vale nos termos.
- Qualquer número que não esteja escrito neste arquivo.

<!-- fim dos fatos -->

## manutenção

Tudo abaixo desta linha é para quem mantém o arquivo. O bot não vê nada disso.

**Como editar.** Mude o fato, salve, rode `npm test` nesta pasta e faça o deploy
do `pqp-support` a partir da raiz do repositório:
`fly deploy --config tools/support-bot/fly.toml --dockerfile tools/support-bot/Dockerfile --ha=false`.
Nenhum workflow faz esse deploy sozinho, então um merge na `main` não muda o bot
no ar. O arquivo vai dentro da imagem (`SUPPORT_FACTS` em `fly.toml`) porque o
`screen.js` tira dele os números permitidos, e o fato e o filtro precisam ser do
mesmo deploy. Localmente, `--facts <caminho>` lê outro arquivo sem build.

**De onde vêm os números**, para conferir quando o código mudar:

| Fato | Fonte |
|---|---|
| captura em até 1080p, 30 ou 60 fps | `screenCaptureOptions`, `client/src/lib/screen-capture-audio.ts`; `SCREEN_FRAME_RATES`, `client/src/lib/hls-capture-rate.ts`; `settings.voice.screenFrameRate*` em `client/src/locales/pt-BR/translation.json` |
| Automático / 1080p / 720p / 480p / 360p, câmera e tela | `VIDEO_QUALITIES` e `screenBitrateFor`, `client/src/lib/video-quality.ts`; `settings.voice.videoQuality*` e `settings.voice.videoQualityRow`; o menu da call é `client/src/components/voice/video-quality-menu.tsx` |
| fluidez / nitidez | `DEFAULT_SHARE_PRIORITY`, `client/src/lib/share-priority.ts`; `call.quality.send.priority*` |
| 5 Mbps que se ajusta | `DEFAULT_SCREEN_UPLOAD_BUDGET_BPS`, `client/src/lib/screen-upload-budget.ts` |
| 720p acima de 20 pessoas | `LARGE_ROOM_PARTICIPANTS`, `packages/shared/src/voice-backend.ts`; `call.quality.send.largeRoomCap` |
| quem assiste escolhe, 360p em dados móveis | `client/src/lib/receive-quality.ts` (só no servidor de mídia); `call.quality.receive.cellularDefault` |
| até 4 telas numa ligação direta, sem número fixo no servidor de mídia | `SCREEN_SHARE_LIMIT`, `MESH_VIDEO_HARD_LIMIT` e `meshVideoLimit`, `packages/shared/src/voice-backend.ts`; `voice.error.shareLimit` |
| direta vs servidor de mídia, 10 membros, comunidade | `resolveVoiceTransport` e `LARGE_SERVER_MEMBER_THRESHOLD`, `server/src/voice/transport-policy.ts` |
| passa pro servidor de mídia com 4 pessoas | `MESH_ROOM_PROMOTION_SIZE`, `packages/shared/src/voice-backend.ts`; `promotionRoomSize`, `server/src/voice/promotion.ts` |
| São Paulo, Miami, Londres | `livekitRegions` em `https://api.pqp.gg/ready` e `voice-mia` / `voice-lhr` em `https://api.pqp.gg/status.json`; `docs/plans/SFU_REGIONS.md`; watch party em casa: `server/src/voice/regions.ts` |
| dois irmãos, independente | `https://pqp.gg/contact` |
| desktop se atualiza sozinho | `electron/lib/updater.js` (em todo release desde 0.1.0) |
| Windows sem assinatura, Mac notarizado | `codeSigning.status` e `downloadPage.mac.signed`; `docs/DESKTOP.md` §4 |
| Android | `https://pqp.gg/android` (`androidPage.*`); `gameAudioSupported`, `android/app/src/main/kotlin/gg/pqp/app/voice/GameAudioCapture.kt`; `docs/ANDROID.md` |
| iPhone transmite a tela | Ainda sem confirmação num aparelho. `docs/IOS.md`, "Device-only, and therefore unverified": a build 12 teve o botão consertado, mas ninguém confirmou o envio num iPhone real depois disso. O código existe: `ios/pqp/Broadcast/SampleHandler.swift` e `ios/pqp/ScreenShare/` |

**Por que "não sei" é uma seção e não uma ausência.** Um assunto que
simplesmente não está no arquivo depende do modelo perceber que não está. Um
assunto listado aqui é uma instrução explícita, e instrução explícita é o que
sobrevive a uma pergunta insistente.
