Semana de conserto. A maior parte do que saiu não é coisa nova pra clicar, é coisa que quebrava e agora se resolve sozinha, ou pelo menos te diz o que fazer. A lista completa está no fim.

## O microfone teimoso

Uma pessoa não conseguia entrar no canal de voz. Trocou o microfone nas configurações e voltou a funcionar. O problema é que ela teve que descobrir isso sozinha.

Agora o pqp tenta os microfones em ordem: o que você escolheu, o padrão do computador, e depois os outros que existirem. O primeiro que abrir ganha, e a chamada te avisa qual foi. Se nenhum abrir, a mensagem para de ser um erro em inglês e passa a dizer o que costuma ser: outro programa segurando o microfone, ou um fone bluetooth que dormiu. Do lado vem um botão que leva direto pras configurações de voz.

Uma coisa que ele não faz mais: pedir permissão de novo depois de você negar. Pedir duas vezes seguidas é o jeito mais rápido de um site ficar bloqueado pra sempre.

## O "conectando" que não terminava

Alguém ficou preso em "conectando" no computador e no celular, em redes diferentes. O servidor estava de pé pra todo mundo.

Acontece que coisas bem diferentes travam do mesmo jeito, com a mesma bolinha girando: sua sessão expirou, um bloqueador de anúncio comeu o login, sua rede deixa passar site mas bloqueia chamada de voz, ou a rede não tem caminho até o servidor de som. Antes, dava "reconectando" pra todas elas, pra sempre.

Agora tem o botão **Verificar conexão**. Ele faz cinco testes, mostra cada resultado conforme chega, e no fim diz numa frase o que está travando. Tem um botão pra copiar o resultado e colar no QG, e se a sua sessão caiu de vez aparece **Entrar de novo** em vez de ficar tentando pra sempre.

## Compartilhar tela com som

Dois problemas, um de cada lado.

No Windows, quem ligava o som mandava a própria chamada de volta pra dentro dela, e todo mundo se ouvia com eco. Isso está resolvido no aplicativo novo (v0.1.4). Quem já tem o pqp instalado no computador recebe a atualização sozinho.

O outro: você marcava a caixinha de som, escolhia a tela, e simplesmente não acontecia nada. Som e imagem vão no mesmo pedido, então uma tela que não tem som pra dar derrubava a transmissão inteira, imagem junto. Agora o pqp só pede som onde dá pra ter som, e quando mesmo assim falha aparece um botão de **compartilhar sem som** ali na hora.

## A nossa política de privacidade estava errada

Ela dizia que não tinha rastreador nenhum. Isso deixou de ser verdade quando entrou o nosso contador de visitas e a tag do Google Ads, e o texto ficou pra trás. Corrigimos: o pqp.gg usa um contador de visitas sem cookie e uma tag que só conta cadastro. Não fazemos remarketing e não montamos lista de público. Quem roda o pqp no próprio servidor não herda nada disso.

## Tudo que mudou

### Novidades

- **Canal favorito.** Clica na estrela e o canal sobe pro topo da lista, pra você não caçar ele toda vez.
- **Cargo VIP.** Um cargo lilás já pronto, pra marcar quem você quiser. Aparece separado na lista de gente e não dá poder nenhum a mais.
- **Quem é o quê.** Dono, admin, gerente, moderador e VIP agora aparecem com uma marca do lado do nome.
- **Câmera na chamada.** Chamada só de voz continua uma barrinha fina. Ligou câmera ou tela, ela vira uma tela grande, com tela cheia e recolher.
- **Entrar na call com um clique.** Clica no canal de voz e você já está dentro.
- **Texto formatado no chat.** Negrito, listas e blocos de código, do mesmo jeito que no Discord. Shift+Enter pula linha sem enviar.
- **Trazer o servidor do Discord.** A cópia agora traz também as permissões de cada cargo e o ícone do servidor.
- **Não lidas na barra dos servidores.** Bolinha com o número de mensagens novas e de menções.
- **GIFs mais rápidos.** Trocamos quem fornece a busca de GIF.
- **Saber que chegou DM.** Chegou mensagem direta, aparece um aviso na tela com quem mandou e um botão pra abrir. Tem som próprio, que dá pra desligar, e contagem no título da aba.
- **Descobrir por que não conecta.** O botão Verificar conexão testa cinco coisas e diz o que está travando.
- **Página de apoio.** `/apoie`, com GitHub Sponsors e Pix. Doar não dá vantagem nenhuma no app, e não vai dar.
- **Boas-vindas mais curtas.** As várias telinhas de primeiro acesso viraram uma só.
- **App do iPhone atualizado.** Saiu versão nova no TestFlight.

### Correções

- Não dava pra entrar no canal de voz quando o microfone não abria. Agora o pqp tenta os outros sozinho e avisa qual pegou.
- Quando nenhum microfone abre, a mensagem agora explica o que costuma ser, em vez de um erro em inglês.
- O pqp não pede permissão de microfone de novo logo depois de você negar.
- O "conectando" que nunca terminava agora tem saída: tentar na hora, verificar a conexão, ou entrar de novo.
- Compartilhar tela com som no Windows devolvia a chamada com eco. Resolvido no aplicativo novo, que se atualiza sozinho.
- Marcar "compartilhar som" e a tela nunca aparecer pros outros.
- A lista do canal de voz mostrava seu nome de verdade em vez do seu apelido no servidor.
- Trocar de apelido não aparecia pra quem já estava na chamada com você.
- Mensagem direta de outro dia parecia que tinha chegado hoje.
- A nossa política de privacidade dizia que não havia rastreador nenhum, o que não era mais verdade.
