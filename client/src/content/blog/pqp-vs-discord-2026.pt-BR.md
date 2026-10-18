pqp é uma alternativa de código aberto ao Discord: voz, texto, watch party e compartilhar tela com som, de graça. Ele ainda não tem o ecossistema de bots de terceiros do Discord, mas cobre o que mais gente procura numa alternativa: tela compartilhada que leva o som, watch party e um código que qualquer um pode ler.

Essa comparação é sobre o que roda hoje, não sobre uma promessa. Cada afirmação sobre o Discord abaixo tem um link de fonte e foi verificada em 16 de outubro de 2026. Onde o pqp fica atrás, está escrito do mesmo jeito. Se algo estiver desatualizado ou errado, escreve pra contato@pqp.gg e a gente corrige.

## O que o pqp faz

**Tela compartilhada com som, no navegador.** No Chrome ou no Edge, compartilha uma aba e marca a opção de áudio da aba que o som vai junto; no Windows a tela inteira também leva o som. Tela inteira no Mac, Firefox e Safari não levam som: é limite do navegador. Veja o [guia de compartilhar tela com áudio](/blog/compartilhar-tela-com-audio) pra cada plataforma.

**Watch party.** Compartilha a tela e a galera assiste no navegador, no PC ou no celular, com o chat do lado. Está em acesso antecipado e é liberada servidor por servidor. Já rodou uma watch party com mais de cem pessoas no pqp. Passo a passo em [como assistir um filme junto online](/blog/watch-party-assistir-filme-com-amigos).

**Código aberto.** O pqp é licenciado sob AGPL-3.0 e o código é público. Dá pra ler como uma feature funciona, reportar um bug direto no repositório ou rodar a tua própria cópia. Rodar a própria cópia precisa hoje de Postgres e de uma conta Clerk tua; ainda não existe caminho sem Clerk.

**Importar o layout do Discord.** Se a tua comunidade já existe no Discord, dá pra copiar a estrutura (categorias, canais, cargos e as permissões principais) colando um link de template discord.new ao criar uma comunidade no pqp. Não copia mensagens, membros nem emoji customizado. Detalhes em [como migrar teu servidor do Discord pro pqp](/blog/migrar-servidor-discord-para-pqp).

## Recurso por recurso

Verificado em 16 de outubro de 2026. Cada linha do Discord tem o link de onde veio; onde não deu pra verificar, a tabela diz.

| Recurso | pqp | Discord |
|---|---|---|
| Preço | De graça, sem plano pago | Grátis pra usar; streaming em HD faz parte do Nitro, que é pago ([discord.com/nitro](https://discord.com/nitro)) |
| Código aberto | Sim, AGPL-3.0 | Não: os termos licenciam o software só pra acessar o serviço ([discord.com/terms](https://discord.com/terms)) |
| Rodar na tua máquina | Sim, com Postgres e uma conta Clerk tua | Não encontramos versão auto-hospedada ([discord.com/terms](https://discord.com/terms)) |
| Compartilhar tela | Sim, até 1080p; a taxa de quadros se adapta à conexão | Sim, tela inteira ou um aplicativo ([Wikipedia](https://en.wikipedia.org/wiki/Discord)); limites exatos do plano grátis não verificados |
| Som na tela compartilhada | Som da aba no Chrome e no Edge; tela inteira no Windows | Não verificado (a central de ajuda do Discord não abriu pra gente) |
| Watch party | Sim, em acesso antecipado, qualquer aba que dê pra compartilhar | Watch Together, uma Atividade pra vídeos do YouTube ([ajuda do Discord](https://support-apps.discord.com/hc/en-us/articles/26502500234519-Watch-Together)) |
| Apps | Navegador, desktop, Android; iPhone em beta | Windows, macOS, Linux, iOS, Android, consoles e navegador ([discord.com/download](https://discord.com/download)) |
| Bots e integrações | Pequeno: webhook de entrada compatível com o do Discord, webhook de saída, comandos nativos | App Directory público ([discord.com/application-directory](https://discord.com/application-directory)) |

## Onde o Discord está na frente

O Discord tem um diretório de apps e bots bem maior, apps em mais plataformas (consoles inclusive) e anos de estrada: está no ar desde maio de 2015 ([Wikipedia](https://en.wikipedia.org/wiki/Discord)). No pqp ainda não tem loja de bots, o app de iPhone está em beta e quem faz são dois irmãos.

O pqp não finge que já alcançou isso. O que ele tem em troca é um produto mais novo, com gente que responde quando um bug aparece.

## Quando vale a pena trocar

Vale testar se:

- A tua prioridade é **tela compartilhada com som e watch party** no navegador.
- Tu quer um produto **de código aberto**, por princípio ou pra rodar a tua própria cópia.
- A tua comunidade é pequena ou média e não depende de um bot específico do Discord sem equivalente em outro lugar.

Faz menos sentido hoje se a tua comunidade depende de um bot muito específico do Discord, ou se tu precisa de apps polidos em todas as plataformas. Dá pra ficar com os dois: nada do que tu faz no pqp mexe no teu Discord.

## Perguntas frequentes

**O pqp é de graça?**
Sim. Voz, texto, watch party e criar servidor não custam nada, e o código é aberto (AGPL-3.0). Dá pra usar o serviço hospedado no pqp.gg ou rodar a tua cópia, que hoje precisa de Postgres e de uma conta Clerk tua.

**O pqp é só um clone do Discord?**
A base é parecida de propósito (servidores, canais, cargos), porque é isso que resolve o problema. O que muda é o que veio depois: watch party, tela compartilhada com som no navegador e código aberto.

**Dá pra importar meu servidor do Discord?**
Dá pra copiar o layout: categorias, canais e as permissões principais de um link de template discord.new, colando ao criar uma comunidade no pqp. Não copia membros, mensagens nem emoji customizado.

**O que o Discord ainda faz que o pqp não faz?**
Um diretório de apps e bots bem maior, apps em mais plataformas e anos de estrada. O pqp tem webhooks e comandos nativos, mas ainda não tem loja de bots.

## Testa tu mesmo

Testar não custa nada e não exige apagar o Discord. Cria uma comunidade no pqp, chama três ou quatro pessoas pra uma call e tenta compartilhar a tela com som. Se funcionar melhor que o que tu tem hoje, [cria a tua comunidade](/garanta) e manda o link pra galera.
