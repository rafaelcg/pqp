Semana de conserto. A maior parte do que saiu não é coisa nova pra clicar, é coisa que parava de funcionar e agora se resolve sozinha, ou pelo menos te diz o que fazer.

## O microfone teimoso

Uma pessoa não conseguia entrar em canal de voz. Trocou o microfone nas configurações e voltou a funcionar. O problema é que ela teve que descobrir isso sozinha.

Agora o pqp tenta os microfones em ordem: o que você escolheu, o padrão do sistema, e depois cada um que o navegador listar. O primeiro que abrir ganha, e a call avisa qual foi. Se nenhum abrir, a mensagem para de ser "Could not start audio source" em inglês e passa a dizer o que costuma ser: outro programa segurando o microfone, ou um fone bluetooth que dormiu. Junto vem um botão que leva direto pras configurações de voz.

Uma coisa que ele não faz mais: pedir permissão de novo depois de você negar. Pedir duas vezes seguidas é o jeito mais rápido de um site ser bloqueado pra sempre.

## O "conectando" que não terminava

Alguém ficou preso em "conectando" no app do PC e no celular, em redes diferentes. A API estava de pé pra todo mundo.

Do lado de cá, quatro coisas bem diferentes viram a mesma bolinha girando: sessão recusada, token que nunca volta (filtro de DNS ou bloqueador de anúncio no serviço de login), HTTPS liberado mas WebSocket bloqueado, e rede sem caminho até o servidor de retransmissão. Antes, a barra dizia "reconectando" pra todos os quatro, pra sempre.

Agora tem **Verificar conexão**: cinco testes, cada resultado aparecendo conforme chega, e no fim uma frase dizendo qual é o problema. Tem um botão de copiar o relatório pra colar no QG. Se a sessão foi recusada duas vezes seguidas, aparece **Entrar de novo** em vez de tentativa infinita.

## Compartilhar tela com som

Dois problemas, um de cada lado.

No Windows, quem ligava o som mandava a própria call de volta pra dentro dela e todo mundo se ouvia com eco. Isso é o app novo (v0.1.4) que resolve, porque a correção mora no shell e não na página. Quem já tem o pqp instalado recebe sozinho.

O outro: marcar a caixinha de som e o compartilhamento simplesmente não começar. Áudio e vídeo viram um pedido só, então uma tela que não tem som pra entregar derruba a captura inteira, imagem junto. Agora o app só pede som onde dá pra entregar, e quando ainda assim falha aparece um botão de **compartilhar sem som** ali mesmo, em vez de não acontecer nada.

## Seu nome na call

Se você tem apelido no servidor, a lista do canal de voz mostrava seu nome de verdade enquanto o resto da tela mostrava o apelido. Agora é o apelido nos dois lugares, e trocar de nome no meio da call atualiza pra quem já está lá dentro.

## DM que aparece

Mensagem direta que chegava enquanto você lia um canal era fácil de perder: uma bolinha vermelha e só. Agora tem um card embaixo do cabeçalho com quem mandou e um botão de abrir, um som próprio (com chave separada nas configurações), a contagem no título da aba, e data nas conversas: hoje mostra a hora, ontem mostra "Ontem", e mais velho mostra o dia. Mensagem de semana passada parava de parecer de agora.

## O resto

**Favoritos.** Estrela num canal e ele sobe pro topo da lista. Ele muda de lugar, não vira cópia.

**Cargo VIP.** Lilás, aparece separado na lista, sem poder nenhum a mais. É pra marcar quem você quiser marcar.

**Câmera na call.** Chamada só de voz continua uma barra fina. Ligou câmera ou tela, ela cresce pro palco inteiro, com tela cheia e recolher.

**Um clique entra.** Clicar na linha do canal de voz entra. O ícone de telefone que ficava ali saiu.

**GIF novo.** A busca de GIF trocou de fornecedor e ficou mais rápida.

**Página de apoio.** `/apoie` com GitHub Sponsors e Pix. Doação não desbloqueia nada, e não vai desbloquear.

**Primeiro acesso.** Eram seis tipos de janela diferentes com seis animações diferentes. Virou um sistema só.

**Celular.** Android e iOS acompanharam, e saiu build nova no TestFlight.

## E a política de privacidade

Ela dizia que não tinha rastreador nenhum. Isso deixou de ser verdade quando entrou o analytics e a tag de conversão do Google Ads, e o texto ficou pra trás. Corrigimos: o pqp.gg hospedado usa analytics sem cookie e uma tag que conta cadastro, só. Sem remarketing, sem lista de público. Quem roda o pqp no próprio servidor não herda nada disso.
