# QA manual da watch party (staging)

Uma checagem antes e onze passos, na ordem. É o que os testes automatizados **não** conseguem cobrir:
tudo que precisa de uma imagem de verdade saindo do LiveKit, de som, de uma
segunda máquina e de um olho humano.

O que já está coberto por `client/e2e/watch-party.spec.ts` e não precisa de você:
criar pela barra, o nome, a tela de montagem, Ir ao vivo, o bloco no topo da
barra, quem vê e quem não vê o botão de criar, o chat durante a sessão, os três
estados (marcada, ao vivo, encerrada), o player sumindo pra quem entra na call
e o caminho inteiro do co-host (promover, o outro navegador virando co-host no
socket, o host caindo de verdade e o Assumir). O que o e2e **não** consegue
provar é justamente o que os passos 9 e 10 pedem: a imagem parando quando o
host cai e quanto tempo ela demora pra voltar.

Onde: `https://staging.pqp-3yr.pages.dev` (API `pqp-api-staging`).
Reserva uns 25 minutos e um filme qualquer aberto numa aba.

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
(build 22 ou mais novo).

**Certo:** no navegador dá pra assistir de pé, com o vídeo em cima e o chat
embaixo. No iPhone o app mostra o vídeo acima do chat do canal, com **AO VIVO** e
a contagem de quem está assistindo. No app ainda **não** existe criar, montar
nem Encerrar, e isso é esperado.

### 8b. O canal no iPhone quando não tem nada rolando

Do build 22 em diante, dá pra conferir isso a semana inteira, sem transmissão
nenhuma. Abre a lista de canais do servidor no app.

**Certo:** a watch party fica numa seção própria, **Watch party**, no topo da
lista, com o ícone de claquete. Ela **não** aparece junto com os canais de voz.
Abrindo o canal, aparece um cartão dizendo que ninguém começou a transmitir
ainda, e **não** tem botão de telefone no canto de cima. Assistir não ocupa vaga
na call, e é por isso que o botão não está lá.

Com a transmissão no ar, a mesma lista ganha o selo **AO VIVO** na linha da
watch party. Ele pode levar até 30 segundos pra aparecer se o app já estava
aberto antes de começar: é o relógio do servidor, não o app travado.

### 9. Promover um co-host

Do lado do host, com a sessão no ar, abre **Opções** na barra da watch party e
desce até **Co-hosts**. Acha a segunda conta na lista e clica **Promover**.

**Certo:** a pessoa sai da lista de baixo e aparece em cima com **Tirar co-host** do
lado. Na segunda máquina, **sem recarregar nada**, o botão **Encerrar** aparece
na barra: ela virou co-host de verdade, na hora, pelo socket.

Ainda na segunda máquina, com o palco fechado (`Só o host e convidados`), o
botão de **Falar** tem que aparecer. Co-host promovido no meio da sessão ganha
o microfone junto com o crachá; se não ganhar, a pessoa assume uma sala em que
não consegue dizer uma palavra.

Clica **Tirar co-host** e confere que some dos dois lados. Depois promove de novo, que é
o estado que o passo 10 precisa.

**Escolhe quem pode transmitir.** Um co-host que não tem permissão de
transmitir nesse canal assume a watch party e **não** consegue colocar imagem
de volta (não aparece botão de compartilhar pra ele). Pra sábado, promove
alguém do staff.

### 10. O host cai, e o co-host assume

**Fecha a aba do host** com a sessão no ar e olha a segunda máquina.

**Certo:** a sessão continua ao vivo e ninguém é cortado. Quem está assistindo
vê **O host caiu** com o recado de que a watch party encerra sozinha se ele não
voltar. O co-host vê **Assumir**. Clica: o aviso some, o botão some, e a barra
passa a mostrar o nome dele como host. A sessão continua **AO VIVO**.

**A imagem, porém, não sobrevive.** Se quem estava compartilhando era o host, a
transmissão para na hora que a aba dele fecha, porque o egress segue quem
compartilha e não quem é host. Cronometra: fecha a aba do host e conta quantos
segundos até o player da segunda máquina parar. Depois o co-host compartilha a
tela dele e conta quantos segundos até a imagem voltar. **Esses dois números
são o buraco real do sábado**, e nenhum botão de co-host encurta eles.

Se quiser ver o caso bom: põe o **co-host** compartilhando desde o começo e
fecha a aba do host. Aí não acontece nada com a imagem, que é a configuração
segura pra um evento grande.

### 11. Encerrar e o que fica pra trás

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
- **O host caiu no meio:** a sessão não acaba, mas a imagem para se era ele que
  estava compartilhando. O co-host clica **Assumir** e **compartilha a tela
  dele**. São duas ações, não uma. Se ninguém assumir, a watch party encerra
  sozinha em 5 minutos.
- **Prevenção, e é a única que funciona de verdade:** quem compartilha e quem é
  host são duas pessoas diferentes. Aí o host cair não mexe na imagem.
