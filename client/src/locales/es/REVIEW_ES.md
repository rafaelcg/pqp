# Spanish review: 10 minutes, 30 strings

For a friend in Mexico, Argentina, Colombia or Chile. You do not need to read code.

**What we want:** neutral Latin American Spanish that sounds like a friend talking, not a bank. "Tú", never "usted" or "vos". Tell us if a line sounds like a translation, sounds like Spain, or sounds too much like one country.

**How:** read each line, write OK, or write the line you would say instead. Say which country you are from.

**Invite text people paste into their group chats** (from `client/src/lib/share-invite.ts`, not in the catalogue):

- Short: `Ven a pqp: <link> #venapqp`
- Long: `Nos mudamos a pqp. Abre en el navegador, entras a la llamada y listo: <link> #venapqp`
- Profile share: `ya me mudé a pqp. búscame en <link>`

**Choices we made on purpose, flag them if they are wrong:**

- "banda" for the group of friends (the campaign headline). Does it work where you live?
- "watch party" stays in English (Twitch and Prime Video already use it in Spanish).
- "link" in casual copy, "enlace" in settings.
- "celular", "computadora". Never "móvil", "ordenador".
- "timeout" and "banear" stay as gamers say them.
- Coin flip: "cara o cruz" (Mexico says "águila o sol", Argentina "cara o ceca").
- `voice.watchParty.startingSoon.line4` keeps the censored swear the Portuguese has. Too much?

## Home

The page at `/` (`client/src/pages/home/`, keys `home.*`). Lines 1, 4 and 5 join a title and its accent the way the page shows them.

| # | Key | Spanish | OK? |
|---|---|---|---|
| 1 | `home.hero.title` | Tu gente en una sala que es de ustedes. | |
| 2 | `home.hero.body` | Voz, pantalla compartida y chat, directo en el navegador. ¿Vienes de Discord? Pega el link de la plantilla y la estructura del servidor viene contigo. | |
| 3 | `home.night.party.body` | El canal de watch party aguanta casa llena: uno comparte la pantalla, todos miran juntos y comentan en el mismo lugar. | |
| 4 | `home.toys.title` | Los detalles que sostienen el caos. | |
| 5 | `home.end.titleLead`, `home.end.title` | Se acabó la página. Llama a tu gente. | |

What the voice pass of October 18, 2026 changed in Spanish. Check the After column too: write OK, or the line you would say instead.

| Key | Before | After | OK? |
|---|---|---|---|
| `home.hero.body` | ...la estructura del servidor se viene contigo. | ...la estructura del servidor viene contigo. (same verb as the import title) | |
| `home.night.share.title` | Comparte tu pantalla. En Chrome y Edge, el sonido va incluido. | Comparte tu pantalla. En Chrome y Edge, el sonido también va. | |
| `home.night.party.body` | ...aguanta la sala llena... | ...aguanta casa llena... ("sala" now means only the group's place) | |
| `home.move.lede`, `home.move.sample.intro`, `home.move.note` | enlace de la plantilla | link de la plantilla ("link" in casual copy) | |
| `home.move.paste.label`, `home.move.steps.link` | Enlace de la plantilla de Discord, Enlace | Link de la plantilla de Discord, Link | |
| `home.handle.hint.empty` | Sin acentos: la á queda a, la ñ queda n. | Sin acentos: á se vuelve a, ñ se vuelve n. | |
| `home.code.ours.note` | Las salas de un servidor pasan al servidor de voz cuando la sala se llena. | Las llamadas de un servidor pasan al servidor de voz cuando se llenan. | |
| `home.code.yours.note` | Sin servidor de medios, cada canal de voz aguanta unas ocho personas. | Sin servidor de voz, cada llamada aguanta unas ocho personas. (one name for the voice server) | |

## /vem (campaign)

| # | Key | Spanish | OK? |
|---|---|---|---|
| 6 | `vem.hero.title` | Casa nueva. La misma banda. | |
| 7 | `vem.hero.body` | Pega el link de la plantilla de tu Discord y tu servidor aparece igualito en pqp: categorías, canales, roles. Voz, pantalla con sonido y chat, directo en el navegador. Manda la invitación. Y ya. | |
| 8 | `vem.import.title` | La estructura llega en dos minutos. Tu gente, en lo que tarda en dar un clic. | |
| 9 | `vem.import.stays.body` | La plantilla de Discord no trae nada de eso, y pqp nunca te pide entrar a tu cuenta de allá para ir por ello. Es una copia del plano de la casa, no un camión de mudanza. A la gente la invitas tú. Los mensajes se quedan donde están. | |
| 10 | `vem.faq.friends.a` | No tienen que cambiarse. Tienen que darle clic a un link. Su sala aparece igualita aquí, con los mismos canales y los mismos roles, y la invitación abre en el navegador. Muchos grupos se quedan con los dos: Discord para lo de siempre, pqp para la llamada y la pantalla. Cuando la llamada está mejor de un lado, la gente se va solita. | |
| 11 | `vem.final.title` | La sala ya está lista. Solo falta tu banda. | |
| 12 | `vem.final.closing` | Ven a pqp. Trae a todos. | |

## Onboarding

| # | Key | Spanish | OK? |
|---|---|---|---|
| 13 | `ageGate.description` | pqp es para mayores de {age}. Te preguntamos una vez y confiamos en tu palabra. | |
| 14 | `onboarding.you.title` | ¿Cómo quieres que te vean? | |
| 15 | `onboarding.you.nameHint` | Vino de tu cuenta. Si no es como te dicen, cámbialo. | |
| 16 | `onboarding.you.later` | Luego lo arreglo | |
| 17 | `onboarding.room.title` | ¿Dónde se va a juntar tu gente? | |
| 18 | `onboarding.room.create.placeholder` | Ponle un nombre ridículo | |
| 19 | `onboarding.room.import.body` | Pega el link de discord.new y la barra lateral se viene tal cual. Discord en sí no cambia. | |
| 20 | `onboarding.ready.title` | Ahora trae a todos | |
| 21 | `onboarding.ready.description` | Pégalo en el grupo. Quien lo abra entra desde el navegador, sin instalar nada. | |

## Empty states

| # | Key | Spanish | OK? |
|---|---|---|---|
| 22 | `chat.empty.title` | Arranca la conversación | |
| 23 | `chat.empty.body` | Los mensajes se quedan guardados. Di hola. | |
| 24 | `chat.empty.owner.title` | Por ahora solo estás tú | |
| 25 | `arrival.body` | Saluda en #{channel}. Nadie sabe que llegaste hasta que hablas. | |
| 26 | `arrival.owner.body` | Solo falta tu gente. Pega la invitación en el grupo. | |
| 27 | `firstRun.title` | Tres cosas y esto ya funciona | |
| 28 | `firstRun.avatar.body` | Una letra en un cuadrito sirve. Una foto sirve más. | |

## Watch party

| # | Key | Spanish | OK? |
|---|---|---|---|
| 29 | `voice.watchParty.startingSoon.line4` | Falta poco para un stream de p*** madre. | |
| 30 | `watchParty.create.namePlaceholder` | Cinemoon, función de medianoche, el chisme del reality | |
