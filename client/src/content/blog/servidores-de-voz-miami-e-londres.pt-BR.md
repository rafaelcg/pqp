A pqp agora tem servidor de voz em três lugares: São Paulo, que continua sendo a casa, Miami e Londres. Quem tá longe do Brasil fala com um servidor perto dele, e a voz chega mais rápido.

## Servidor perto, menos atraso

Até esta semana, toda call que passava por servidor ia pra São Paulo, de onde quer que você estivesse. Pra quem joga do Brasil, ótimo. Pra galera de fora, cada frase fazia uma viagem longa até aqui e voltava.

Agora fica assim:

- **Miami:** Estados Unidos, Canadá, México, América Central, Caribe, Colômbia e Venezuela.
- **Londres:** Reino Unido, Irlanda, Europa ocidental e do norte, Polônia, Tchéquia, Nigéria, Gana e Quênia.
- **São Paulo:** o Brasil e todo o resto.

A diferença é grande. Medimos hoje do Reino Unido: o servidor de Londres responde em uns 15 ms, e o de São Paulo em uns 190 ms. E numa call de teste entre o Reino Unido e São Paulo, a perda de pacote foi zero em todos os servidores.

## Como funciona

Você não precisa fazer nada. Nas comunidades e nos servidores maiores, a voz passa por um servidor da pqp, e a pqp escolhe o que fica mais perto da galera daquele servidor. Todo mundo na call cai no mesmo lugar, então ninguém fica separado da conversa.

DM call e call em servidor pequeno já ligam vocês direto, de um pro outro, sem passar por servidor nenhum. Isso não mudou.

Quer ver onde a pqp roda e se cada servidor tá no ar agora? Tem um mapa novo na página inicial, em [pqp.gg/#where](https://pqp.gg/#where).

## Watch party

A watch party continua saindo de São Paulo e chega em você pela rede da Cloudflare, perto de onde você tá assistindo.

E ela também melhorou:

- O modo de baixa latência ficou mais liso. Quando a conexão engasga, o player ganha uns segundos de folga em vez de travar, e depois devolve quando dá.
- Em **Transmissões anteriores** dá pra rever o que passou, e em **Baixar** tem a câmera e a voz de quem apresentou. Numa transmissão de baixa latência também sai o vídeo inteiro, pronto uns minutos depois que acaba.
- Cada transmissão antiga mostra o pico de gente assistindo junta e quantas pessoas diferentes passaram por lá.
- Atualização nossa no servidor não derruba mais a watch party no meio do filme.

## O resto

- A pqp agora fala espanhol. Escolhe **Español** em **Configurações**, **Aparência e idioma**. Um navegador em espanhol já abre nele sozinho.
- Push-to-talk funciona em qualquer tela, até enquanto você digita. No app de desktop (0.1.9) funciona com a janela em segundo plano.

## Ainda não

- Os apps de iPhone e Android ainda não escolhem região. Uma call que começa pelo celular abre em São Paulo. Entrar numa call de Miami ou Londres pelo celular funciona normal.
