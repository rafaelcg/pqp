Compartilhar tela com áudio no pqp depende de como você compartilha, não só do que você usa. No Chrome ou Edge, compartilhando uma guia com a caixinha de áudio marcada, o som vai sempre. No Safari e no Firefox, o som nunca vai, seja lá o que você compartilhar: é limite do navegador, não do pqp.

Esse guia mostra a combinação certa pra cada sistema, sem achismo: o que testamos e o que ainda não.

## Por que o som às vezes não vai

Quem decide se um navegador entrega o áudio de uma tela compartilhada é o próprio navegador, através da API `getDisplayMedia`. Alguns navegadores nunca implementaram a captura de áudio do sistema nessa API. Outros implementaram só pra guias, não pra tela inteira. O pqp usa exatamente o que cada navegador oferece, e mostra na tela, antes de você compartilhar, o que vai e o que não vai, em vez de deixar você descobrir pelo silêncio do outro lado.

## A tabela por plataforma

| Onde você compartilha | O que compartilha | O som vai? |
|---|---|---|
| Chrome ou Edge, **guia do navegador** | Uma aba específica, caixinha de áudio marcada | Sim |
| Chrome ou Edge no **Windows**, tela inteira | A tela toda | Sim (o botão de áudio do sistema é opcional e vem desligado, pra evitar eco da própria call) |
| Chrome no **macOS**, tela inteira ou janela | Tela ou janela | Não. Limite do Chrome no macOS |
| **Safari** | Guia, janela ou tela | Não, nunca |
| **Firefox** | Guia, janela ou tela | Não, nunca |
| **App de desktop** (Windows, Mac, Linux) | Tela ou janela, direto do app | No Windows 11, o áudio do sistema vai junto, sem duplicar sua própria voz |
| **Android** (app nativo) | Tela do celular | O app manda e recebe a imagem da tela compartilhada; o áudio do sistema do celular não está confirmado ainda |
| **iPhone** | Tela do celular | Você já assiste a uma tela compartilhada dentro do app. Transmitir a tela a partir do iPhone ainda está em desenvolvimento |

## Como garantir o som no Chrome ou Edge (a rota mais confiável)

1. Clique em compartilhar tela dentro da call.
2. Na janela que o navegador abre, escolha a aba **Guia do Chrome** (não "Janela" nem "Tela inteira").
3. Marque a caixinha **"Também compartilhar áudio da guia"**. É fácil passar direto por ela, então confira antes de confirmar.
4. Confirme. O pqp mostra um checklist rápido antes de você ir ao vivo numa watch party, incluindo esse item.

Essa é a rota que funciona igual em qualquer sistema operacional, porque o áudio pertence à aba, não à captura de tela do sistema.

## Compartilhando a tela inteira no Windows

No Windows, compartilhar a tela inteira também manda o áudio do sistema, mas esse botão vem **desligado por padrão**. O motivo é simples: se você está numa call de voz e liga esse botão, o áudio da própria call pode voltar pra dentro da captura, e todo mundo se ouve de volta com eco. Ligue só se realmente precisa mandar um som que não é de uma guia específica, como um jogo fora do navegador.

## No macOS, pelo navegador, ainda não

Se você compartilha a tela inteira ou uma janela no Chrome do macOS, o vídeo vai mas o áudio não. Isso é um limite do próprio Chrome nesse sistema, documentado e conhecido, não um bug do pqp. A saída que funciona: compartilhe uma guia do Chrome em vez da tela inteira, e o áudio daquela guia vai normalmente.

## No celular

No **Android**, o app nativo já manda e recebe tela compartilhada: quem está na call vê o que você está fazendo no celular. No **iPhone**, hoje dá pra assistir a uma tela compartilhada de outra pessoa direto no app; mandar a sua própria tela a partir do iPhone é um recurso que ainda está em desenvolvimento, então evite depender dele pra uma apresentação importante por enquanto.

## Perguntas frequentes

**Por que às vezes minha tela compartilhada não tem som?**
Porque o navegador, não o pqp, decide se entrega o áudio. Safari e Firefox nunca entregam o som de uma tela compartilhada. Chrome e Edge entregam quando você compartilha uma guia (com a caixinha de áudio marcada) ou a tela inteira no Windows.

**Como eu garanto que o som vai junto no Chrome?**
Compartilhe uma guia (não a janela inteira nem uma tela) e marque a caixinha "Também compartilhar áudio da guia" na janela que o Chrome abre antes de confirmar. É a rota mais confiável em qualquer sistema operacional.

**No Mac dá pra compartilhar tela inteira com som?**
Pelo navegador, não: é um limite do Chrome no macOS, não do pqp. Compartilhando uma guia do Chrome o som vai normalmente, em qualquer sistema.

**Dá pra compartilhar a tela do celular?**
No Android, o app nativo já manda e recebe tela compartilhada. No iPhone hoje dá pra assistir a uma tela compartilhada dentro do app; transmitir a tela a partir do iPhone ainda está em desenvolvimento.

## Testa numa call rápida

A forma mais fácil de confirmar que funciona no seu caso é testar: abre uma call no pqp com um amigo, compartilha uma guia do Chrome com a caixinha marcada, e confere se o som chegou do outro lado. Se ainda não tem onde testar, [crie uma comunidade](/garanta) ou veja a [página de compartilhar tela](/tela) com as opções que funcionam hoje.
