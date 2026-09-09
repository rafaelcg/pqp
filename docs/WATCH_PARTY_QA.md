# QA manual da watch party (staging)

Dez passos, na ordem. É o que os testes automatizados **não** conseguem cobrir:
tudo que precisa de uma imagem de verdade saindo do LiveKit, de som, de uma
segunda máquina e de um olho humano.

O que já está coberto por `client/e2e/watch-party.spec.ts` e não precisa de você:
criar pela barra, o nome, a tela de montagem, Ir ao vivo, o bloco no topo da
barra, quem vê e quem não vê o botão de criar, o chat durante a sessão, os três
estados (marcada, ao vivo, encerrada) e o player sumindo pra quem entra na call.

Onde: `https://staging.pqp-3yr.pages.dev` (API `pqp-api-staging`).
Reserve uns 25 minutos e um filme qualquer aberto numa aba.

---

### 0. Antes de tudo: a flag está mesmo no build?

Abre `https://staging.pqp-3yr.pages.dev/app` e olha o topo da barra de canais.

**Certo:** aparece **Criar watch party**. Se não aparecer, para aqui: o build
saiu sem `VITE_WATCH_PARTY_CHANNELS=true` e nada abaixo vai funcionar. Foi
exatamente isso que aconteceu na PR #419.

Confere também `https://pqp-api-staging.fly.dev/ready`: em `checks.liveHls` tem
que vir `ok: true`. Com ele desligado a sessão fica ao vivo e nunca aparece
imagem nenhuma.

### 1. Montar: o seletor do navegador e o aviso

Clica em **Criar watch party**, põe um nome (`Teste sábado`) e **Montar**.
Na tela de montagem, clica em **Escolher o que compartilhar** e escolhe a aba do
filme, com **compartilhar áudio da aba** marcado.

**Certo:** a prévia mostra o filme, com **Só você tá vendo isso** em cima, e o
aviso "Você é responsável pelo que transmite" aparece **aqui**, antes de
qualquer coisa sair. Confirma em **Entendi**.

Ninguém mais vê nada ainda: a barra do outro navegador continua sem o bloco.

### 2. Ir ao vivo e a imagem chegando na segunda máquina

Clica **Ir ao vivo**. Numa segunda máquina (ou outro perfil do Chrome, com
outra conta de verdade), entra no mesmo servidor.

**Certo:** o bloco aparece no topo da barra com o nome da watch party, a foto
do host e **AO VIVO**. Um clique no bloco e a imagem começa em poucos segundos,
sem pedir microfone e sem pedir um segundo clique. Enquanto a imagem não chega,
o painel diz **A watch party começou** em vez de ficar preto e mudo.

Cronometra: da hora que você clicou até a imagem aparecer, quantos segundos?
Anota. É o número que a galera vai sentir no sábado.

### 3. O som

Na segunda máquina, o vídeo começa mudo (regra do navegador).

**Certo:** aparece **Toca pra ligar o som**. Clica. O áudio do filme sai, e o
controle de volume no canto de baixo à direita funciona.

Se não sair som nenhum, o problema é o áudio de aba não ter sido capturado no
passo 1. Volta e refaz com a caixinha marcada.

### 4. Atraso, qualidade e o Pular pro ao vivo

Ainda na segunda máquina, com a imagem rodando.

**Certo:** o badge de cima mostra **~Ns de atraso** com um número plausível
(algo entre 5 e 30 segundos), o menu de **Qualidade da transmissão** lista mais
de uma opção, e se você pausar e voltar aparece **Pular pro ao vivo** e ele
volta pro presente.

### 5. Entrar na call: o filme não pode tocar duas vezes

Na segunda máquina, clica **Entrar na call**.

**Certo:** o player HLS some na hora e você passa a ver a tela do host pela
call. **Um filme só, um áudio só.** Se você ouvir o mesmo som duas vezes com
alguns segundos de diferença, para tudo e me avisa: é o pior bug possível pro
sábado.

Sai da call (**Sair**). O player volta.

### 6. Mudar as opções com gente assistindo

Do lado do host, abre **Opções** na barra da watch party.
Muda **Quem pode falar** para `Todo mundo` e depois de volta para
`Só o host e convidados`. Põe **Chat lento** em 10 segundos.

**Certo:** na segunda máquina, sem recarregar nada, o chat passa a segurar a
segunda mensagem por 10 segundos, e o botão de falar aparece e some junto com a
mudança do palco. O host nunca perde o próprio microfone ao fechar o palco.

### 7. Barra lado a lado num notebook

Do lado do host, com a imagem no ar, joga a divisória pro modo lado a lado e
estreita a janela até um tamanho de notebook (1280 ou menos).

**Certo:** o nome da watch party continua legível e **Encerrar** continua
clicável, sem ficar cortado na divisória. As ações quebram pra segunda linha em
vez de sumirem.

### 8. Celular e o app do iPhone

Abre a mesma sessão no celular: no navegador e, se der, no app do TestFlight
(build 21).

**Certo:** no navegador dá pra assistir de pé, com o vídeo em cima e o chat
embaixo. No iPhone o app mostra o vídeo acima do chat do canal, com **AO VIVO** e
a contagem de quem está assistindo. No app ainda **não** existe criar, montar
nem Encerrar: isso é esperado, não é bug.

### 9. O host cai

**Fecha a aba do host** com a sessão no ar e olha a segunda máquina.

**Certo:** a sessão continua ao vivo e ninguém é cortado. Quem está assistindo
vê **O host caiu** com o recado de que a watch party encerra sozinha se ele não
voltar. Reabre a aba do host dentro de 5 minutos: o aviso some sozinho.

O botão **Assumir** só aparece pra co-host, e hoje **não existe tela pra
promover co-host** (só a rota `POST /api/watch-parties/:id/cohosts`). Se você
quiser ver esse botão no sábado, promova pela API antes de começar. Se não
quiser, o caminho é o de cima: ou o host volta, ou a sessão encerra sozinha em
5 minutos.

### 10. Encerrar e o que fica pra trás

Do lado do host, **Encerrar** e confirma.

**Certo:** o bloco some da barra de todo mundo na hora, quem estava assistindo
vê **A transmissão acabou**, e o chat lento volta pro valor que o canal tinha
antes (se o canal não tinha, volta a não ter). O host volta a ver **Criar watch
party** no lugar do bloco.

---

## Se der ruim no sábado

- **Ninguém vê o bloco:** a flag do build (passo 0). Não tem conserto no ar; é
  redeploy do web.
- **Ao vivo mas sem imagem:** `LIVE_HLS_ENABLED` ou o bucket. O painel já diz
  isso em palavras, então a galera não fica olhando pro nada.
- **Imagem dobrada com dois áudios:** quem está assistindo saiu da call sem
  querer entrar. Manda sair da call e assistir só pelo bloco.
- **Sala virando bagunça:** **Opções**, **Quem pode falar** em
  `Só o host e convidados`, e **Chat lento** em 30 segundos.
