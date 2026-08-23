# Fatos do pqp

**Esta é a única fonte de verdade do bot de suporte.** Ele responde a partir
daqui e de mais nada. O que não está escrito abaixo, ele não sabe, e dizer que
não sabe é a resposta certa.

Um humano mantém este arquivo. Editar aqui muda o que o bot responde no próximo
minuto, sem deploy e sem mexer em código.

Regras de escrita: português do Brasil, direto, sem travessão. Se um fato mudar,
mude aqui no mesmo dia. Um fato velho publicado no canal é o pior resultado
possível deste sistema.

## o que o pqp é

- O pqp é um chat de voz e texto no navegador. Não precisa instalar nada.
- É de graça.
- É software livre, licença AGPL. O código está em github.com/rafaelcg/pqp.
- Está em beta aberto.
- É feito por uma pessoa só.
- Os servidores ficam em São Paulo.
- Dá pra auto-hospedar, já que o código é aberto.

## voz

- A voz é WebRTC em malha, ou seja, o áudio vai direto de cada pessoa pra cada
  outra pessoa.
- Vai bem até umas 5 ou 6 pessoas por sala. Acima disso a qualidade cai, porque
  cada pessoa passa a mandar o próprio áudio pra todo mundo ao mesmo tempo.
- Existe um plano de usar um servidor de mídia pra salas maiores. Não está no ar.

## compartilhar tela

- A captura é 1080p a 30 quadros por segundo.
- Não existe ajuste manual de qualidade. Não tem botão, não tem menu, não tem
  configuração escondida. Essa é a pergunta mais comum e a resposta é essa.
- O que existe é automático: o envio tem um orçamento de mais ou menos 5 Mbps
  dividido entre quem está assistindo, com um piso de 600 kbps e um teto de
  2,5 Mbps por pessoa.
- Consequência prática, e é a única coisa acionável que dá pra dizer: quanto
  menos gente assistindo, mais nítida a imagem fica.
- A captura é marcada como movimento e prioriza manter a fluidez. Ou seja, em
  cena com muito movimento ela abre mão de nitidez pra não travar. Texto pequeno
  perde um pouco de definição; vídeo para de engasgar.
- Serviço com DRM, tipo Netflix, sai preto. Isso é o navegador protegendo o
  conteúdo, não é bug do pqp.

## som do compartilhamento de tela

- O som só vai junto no Chrome e no Edge, compartilhando **uma guia**, com a
  caixinha "Também compartilhar áudio da guia" marcada.
- Compartilhar a tela inteira ou uma janela no macOS sai mudo.
- Safari e Firefox saem mudos sempre.
- Isso é limite do navegador, não é bug do pqp e não tem contorno do nosso lado.

## app de desktop

- O app de desktop publicado é a versão 0.1.0, de 7 de agosto.
- Nessa versão o compartilhamento de tela não funciona: o app não consegue
  perguntar qual tela você quer.
- Já está corrigido no código, mas ainda não saiu build novo com a correção.
- Enquanto isso, compartilhar tela pelo navegador funciona normalmente. Essa é a
  saída pra quem precisa hoje.

## iPhone e app

- Existe um beta de iPhone pelo TestFlight, em pqp.gg/beta.
- O app **não** está na App Store.
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
- Nunca diga nada sobre App Store, aprovação de app ou lançamento em loja.
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
- Qualquer número que não esteja escrito neste arquivo.

<!-- fim dos fatos -->

## manutenção

Tudo abaixo desta linha é para quem mantém o arquivo. O bot não vê nada disso.

**Como editar.** Mude o fato, salve, reinicie o bot. Não existe cache. Não
existe build. O arquivo é lido no boot e revalidado a cada leitura.

**De onde vêm os números**, para conferir quando o código mudar:

| Fato | Fonte |
|---|---|
| 1080p30 | `SCREEN_CAPTURE_OPTIONS`, `client/src/hooks/use-voice.ts` |
| 5 Mbps / 600 kbps / 2,5 Mbps | `SCREEN_UPLOAD_BUDGET_BPS`, `SCREEN_MIN_BITRATE_BPS`, `SCREEN_MAX_BITRATE_BPS`, `client/src/lib/peer-connection-manager.ts` |
| movimento / fluidez | `track.contentHint = "motion"` e `params.degradationPreference`, mesmos arquivos |
| som só em guia do Chrome | comentário em `use-voice.ts` perto de `getAudioTracks()`, e `voice.share.noAudio` em `client/src/locales/pt-BR/translation.json` |
| 5 ou 6 por sala | `tela.faq.people.a`, `client/src/locales/pt-BR/translation.json` |
| desktop 0.1.0 | única tag publicada; `electron/package.json` já está em 0.1.1 sem release |
| SFU não está no ar | `LIVEKIT_*` não aparece em nenhum `fly.toml` |
| iPhone transmite a tela | Resolvido em 23/08. `docs/IOS.md` se contradizia: a seção detalhada dizia que as duas direções funcionam, e um resumo mais abaixo ainda listava screen share como "só na web". O resumo era de `f68bfcb` (07/08) e a funcionalidade entrou em `e6027ba` (08/08), um commit **descendente**, que atualizou a seção e esqueceu o resumo. O resumo foi corrigido. O código existe: `ios/pqp/Broadcast/SampleHandler.swift` e `ios/pqp/ScreenShare/` |

**Por que "não sei" é uma seção e não uma ausência.** Um assunto que
simplesmente não está no arquivo depende do modelo perceber que não está. Um
assunto listado aqui é uma instrução explícita, e instrução explícita é o que
sobrevive a uma pergunta insistente.
