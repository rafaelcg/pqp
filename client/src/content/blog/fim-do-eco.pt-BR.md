Quem compartilhava a tela inteira mandava junto o som da máquina toda. Inclusive a própria call. Resultado: todo mundo se ouvia de volta.

Era bug nosso. Uma palavra na configuração de captura. Duas pessoas reportaram e uma terceira deixou nota numa avaliação de call: *"Quando alguém transmite, ele repete a Call de quem esta na chamada tbm. Aí fica com eco."*

Corrigido.

## O que mudou na prática

O som da máquina agora é **opcional e vem desligado**. Tem um botão do lado do compartilhar, e ele avisa o que faz antes de você ligar.

Compartilhar uma **aba do Chrome** continua mandando o som daquela aba, sem precisar ligar nada. Essa é a rota limpa: a aba manda o áudio dela e nada mais, então a call não entra junto.

| Como você compartilha | Som | Eco |
|---|---|---|
| Aba do Chrome | vai | não tem |
| Tela inteira, botão desligado | não vai | não tem |
| Tela inteira, botão ligado | vai o do PC todo | pode voltar |
| Safari e Firefox | não vai | não tem |

## Uma correção no que a gente escreveu antes

No post de 22 de agosto a gente disse que no Windows a tela inteira ia com som. Ia mesmo. O que a gente não disse, porque não sabia, é que ia com a call junto. Agora vai só se você pedir.

Se você ligar o botão, o eco pode voltar, porque continua sendo o áudio do computador inteiro. No Chrome 141 pra cima a gente pede pro navegador tirar o nosso próprio som da captura, mas isso a gente nunca testou contra um loopback do Windows de verdade, então não vamos vender como resolvido.

Quem usa o app de desktop já está corrigido sem precisar atualizar nada.

## Botão sem legenda, nunca mais

Todo botão de ícone do pqp agora explica o que faz quando você passa o mouse. Eram vinte e oito botões sem nenhuma legenda, incluindo o botão novo aí de cima, que nem o autor conseguia identificar olhando.

## No Android

GIF agora anima em vez de ficar parado, e vídeo ganhou um player de verdade em vez de não abrir.
