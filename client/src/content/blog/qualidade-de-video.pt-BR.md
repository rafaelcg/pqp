A sua câmera agora manda 720p, e você escolhe a qualidade.

## O seletor

Em Configurações, Voz e vídeo:

| Opção | O que ela pede |
|---|---|
| **Automático** (padrão) | 720p, e devolve resolução se a conexão pedir |
| 1080p | 1920x1080 |
| 720p | 1280x720 |
| 480p | 854x480 |
| 360p | 640x360 |

**Automático não quer dizer "sem opinião".** Ele pede 720p e deixa a conexão devolver resolução quando não dá conta, nos dois sentidos: aperta e cai, melhora e sobe.

As opções fixas servem pra quando você sabe algo que o navegador não sabe. Internet de hotel, franquia contada, notebook velho esquentando: trave em 480p e pronto.

Trocar no meio da call **não desliga a câmera**. A luzinha não pisca e ninguém some da tela, porque a mudança vai na trilha que já está no ar em vez de capturar tudo de novo.

Do lado do seletor tem um número: o que você está mandando de verdade, agora, em tamanho, quadros e kbps. Se a conexão estiver segurando, ele fala. Achamos melhor mostrar do que deixar você adivinhar por que a imagem está feia.

## Por que 720p é novidade

Quando o pqp ligava a câmera, ele pedia isso pro navegador:

```
getUserMedia({ video: true })
```

E só. Sem falar tamanho, sem falar quadros, sem falar nada. Quando você não pede um tamanho, quem escolhe é o navegador, e o Chrome escolhe **640x480**. O Firefox e o Safari param no mesmo lugar.

Ou seja: a sua webcam de 1080p mandava 480p porque ninguém nunca pediu mais. Não tinha trava, não tinha limite de plano, não tinha economia de banda. Tinha um pedido que a gente nunca fez.

E o pior vem depois. Saindo de 480p, o primeiro degrau pra baixo quando a conexão aperta é 320x240. Então bastava a rede piorar um pouco pra imagem virar aquele quadradinho borrado, porque ela já começava a call a um passo do fundo do poço.

A tela compartilhada nunca teve esse problema, porque ali a gente pedia 1080p direitinho. Faltava fazer o mesmo pela câmera, e agora está feito: ela pede 720p a 30 quadros e tem um teto de banda próprio, em vez de disputar no braço com a tela compartilhada.

## Tela cheia com duas telas

Desde a semana passada dá pra duas pessoas passarem a tela ao mesmo tempo. O botão de tela cheia, porém, era mais velho que isso, e fazia o que sempre fez: colocava **as duas** em tela cheia juntas, lado a lado, cada uma pela metade.

Agora cada tela tem o seu botão, e ele aparece só quando tem mais de uma. Trocar de uma pra outra não sai e volta da tela cheia, troca na hora. Esc sai, como sempre.

No caminho a gente achou um bug pior que esse, no painel de voz do servidor: com duas telas abertas no iPhone, uma cobria o botão de sair da outra. Tela cheia sem saída. Também está consertado.

## Consertado desde o último post

O vídeo compartilhado em tela cheia no Safari do iPhone ficava preto. Estava na fila no post passado, foi ao ar e funciona.

## Ainda não

- Passar a tela do iPhone. Dá pra assistir, não dá pra transmitir.
- Som quando você compartilha a tela inteira no macOS. Limite do navegador, não nosso.
- 1080p não é garantia. É um pedido. Webcam que não faz 1080p entrega o que ela tem, e conexão ruim derruba a resolução mesmo com a opção travada. O número do lado do seletor existe justamente pra isso ficar visível.

Quer só passar a tela pros amigos e ver o que funciona hoje? Tem uma comparação honesta em [compartilhar tela no navegador](/tela).
