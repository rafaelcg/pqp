Tela compartilhada agora vai **com som**. E o vídeo ficou fluido.

## O som

Antes, quando você passava a tela, ia só a imagem. Filme sem áudio, jogo sem áudio, clipe sem áudio. Todo mundo do outro lado via a boca mexendo e não ouvia nada.

Agora vai o áudio junto. Um detalhe importante: o navegador só entrega o som se você **compartilhar uma guia do Chrome e marcar a caixinha "Também compartilhar áudio da guia"**. O pqp avisa isso na hora de escolher, porque essa caixinha é fácil de não ver.

Onde funciona hoje:

| Situação | Som |
|---|---|
| Chrome ou Edge, compartilhando uma **guia**, caixinha marcada | vai |
| Chrome ou Edge no Windows, tela inteira | vai |
| Chrome no macOS, tela inteira ou janela | não vai |
| Safari e Firefox | não vai |

Sem a caixinha, em qualquer lugar, continua indo só o vídeo. Isso não é erro, é limite do navegador, e o pqp fala isso na tela em vez de deixar você descobrir pelo silêncio do outro lado.

## O vídeo

Esse era o problema mais chato e a causa era vergonhosa: a gente nunca tinha dito pro navegador o que estava mandando. Sem essa dica, o codificador assume que tela compartilhada é planilha, e planilha se otimiza pra nitidez: ele segura a resolução e gasta o movimento. Ótimo pra texto parado, péssimo pra qualquer coisa que se mexe.

Trocamos a prioridade pra movimento, limitamos a captura em 1080p a 30 quadros e passamos a dividir a banda de subida entre as pessoas da sala em vez de mandar o mesmo tanto pra cada uma. Filme, jogo e partida agora parecem ao vivo em vez de uma sequência de fotos.

## Uma pergunta depois da call

Quando uma call acaba, se ela durou mais de um minuto e tinha mais alguém junto, aparece uma perguntinha: de 1 a 5, como foi. Nota baixa abre um campo opcional pra dizer o que quebrou.

Ela pergunta no máximo uma vez a cada seis horas, e fechar sem responder conta igual. A gente não quer treinar ninguém a ignorar aviso.

O que a gente guarda: a nota, quanto tempo durou, quantas pessoas tinham, se teve tela e por qual caminho a call passou. O que a gente não guarda: quem estava, o que foi dito, nada.

## Ainda não

- Passar a tela do iPhone. Dá pra assistir, não dá pra transmitir.
- Som quando você compartilha a tela inteira no macOS. Limite do navegador, não nosso.
- Deixar o vídeo compartilhado em tela cheia no Safari do iPhone: a imagem some e o som continua. Já está na fila.
