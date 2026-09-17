pqp é uma alternativa de código aberto ao Discord: voz, texto, watch party e compartilhar tela com som, de graça. Ele não tem o catálogo de bots de terceiros do Discord ainda, mas resolve rápido o que mais gente procura numa alternativa: chamada que não cai, tela compartilhada com áudio de verdade, e um código que qualquer um pode ler.

Essa comparação é sobre o que roda hoje, não sobre uma promessa. Onde o pqp ainda não chega no Discord, está escrito aqui do mesmo jeito.

## O que o pqp já faz melhor

**Tela compartilhada com som, sem plugin.** No Discord, compartilhar tela com áudio depende do sistema e às vezes falha silenciosamente. No pqp, compartilhando uma guia do Chrome ou Edge com a caixinha de áudio marcada, o som vai junto, e o app avisa antes de você entrar ao vivo se alguma coisa está errada (navegador sem suporte, mic mutado, câmera desligada). Veja o [guia de compartilhar tela com áudio](/compartilhar-tela-com-audio) pra cada plataforma.

**Watch party embutida.** Criar uma sessão pra assistir filme, jogo ou live junto com a galera é um botão dentro da call, não uma extensão de terceiros. Já rodou uma watch party de mais de 500 pessoas assistindo ao mesmo tempo no pqp, com mixer pra balancear microfone e áudio do filme, e qualidade que você escolhe (720p ou 1080p). Passo a passo em [como assistir um filme junto online](/blog/watch-party-assistir-filme-com-amigos).

**Código aberto de verdade.** pqp é licenciado sob AGPL-3.0. Isso não é um slogan: o código do cliente, do servidor e do app mobile está público, qualquer pessoa pode ler como uma feature funciona, reportar um bug direto no repositório, ou rodar a própria instância. O Discord é fechado.

**Import de layout do Discord.** Se sua comunidade já existe no Discord, dá pra copiar a estrutura (categorias, canais, cargos) colando um link de Guild Template ao criar uma comunidade no pqp. Não copia mensagens nem membros, porque isso não está no template. Detalhes em [como migrar seu servidor do Discord pro pqp](/blog/migrar-servidor-discord-para-pqp).

## Onde o pqp e o Discord empatam

| Recurso | pqp | Discord |
|---|---|---|
| Voz e texto em servidores | Sim | Sim |
| Cargos e permissões por canal | Sim | Sim |
| DM e lista de amigos | Sim | Sim |
| Compartilhar tela | Sim, com som | Sim, som às vezes falha |
| Watch party embutida | Sim | Não (precisa de extensão) |
| App mobile nativo | Android nativo, iPhone em beta | Sim, maduro |
| App de desktop | Sim (Electron) | Sim |
| Código aberto | Sim (AGPL-3.0) | Não |
| Catálogo de bots de terceiros | Menor, mais novo | Enorme, maduro |
| Diretório público de servidores | Comunidades com endereço próprio | Milhões de servidores |

## O que o Discord ainda faz que o pqp não faz

Um jeito honesto de olhar pra isso: o Discord tem mais de dez anos de vantagem em duas coisas específicas. A primeira é o **ecossistema de bots de terceiros**: moderação automática avançada, música, integrações com todo tipo de jogo, feitas por milhares de desenvolvedores fora da empresa. A segunda é o **tamanho do diretório público**: milhões de servidores catalogados e buscáveis.

O pqp não finge que já alcançou isso. O que ele tem em troca é um produto mais novo, sem o peso de anos de decisões legadas, com quem responde rápido quando um bug aparece.

## Quando faz sentido trocar

Trocar faz mais sentido se:

- Sua prioridade é **watch party e tela compartilhada com som** funcionando sem gambiarra.
- Você quer um produto **de código aberto**, seja por princípio ou porque quer rodar a própria instância.
- Sua comunidade é pequena ou média e não depende de um bot específico do Discord que não existe em outro lugar.
- Você já testou o Discord e a voz trava, ou a tela some, ou você simplesmente quer testar outra coisa.

Não faz tanto sentido ainda se sua comunidade depende de um bot muito específico do Discord sem equivalente, ou se o alcance de um diretório gigante de servidores é o ponto principal.

## Perguntas frequentes

**pqp é de graça?**
Sim. Voz, texto, watch party e criar servidor não custam nada, e o código é aberto (AGPL-3.0), dá pra ler, rodar e até hospedar você mesmo.

**O pqp é só um clone do Discord?**
A base é parecida de propósito (servidores, canais, cargos), porque é isso que resolve o problema. O que muda é o que veio depois: watch party com mixer e qualidade ajustável embutidos, screen share com áudio sem plugin, código aberto, e um time que responde rápido.

**Dá pra importar meu servidor do Discord?**
Dá pra copiar o layout: categorias, canais e cargos de um Discord Guild Template, colando o link ao criar uma comunidade no pqp. Não copia membros, mensagens nem emoji customizado, porque isso não está no template.

**O que o Discord ainda faz que o pqp não faz?**
Um catálogo de bots de terceiros do tamanho do Discord, canais de fórum, e um diretório público de milhões de servidores. O pqp tem comunidades públicas e o próprio import de layout do Discord, mas o ecossistema de bots de terceiros ainda é menor, porque é mais novo.

## Testa você mesmo

A troca não custa nada e não exige apagar o Discord. Cria uma comunidade no pqp, chama três ou quatro pessoas pra uma call, tenta compartilhar a tela com som e uma watch party rápida. Se funcionar melhor que o que você tem hoje, [crie sua comunidade](/garanta) e mande o link pra galera.
