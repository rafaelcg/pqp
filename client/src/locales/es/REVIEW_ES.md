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

## Landing

| # | Key | Spanish | OK? |
|---|---|---|---|
| 1 | `landing.hero.title` | Voz, pantalla compartida y chat. Para tu gente, a tu manera. | |
| 2 | `landing.hero.body` | Crea la comunidad, manda el link y súmate a la llamada. Pantalla compartida con sonido, watch parties para más de cien personas, y el código es abierto: el servidor puede ser tuyo. | |
| 3 | `landing.hero.hint` | ¿Tienes un enlace de invitación? Ábrelo. ¿Ya tienes cuenta? Entra. | |
| 4 | `landing.cta.title` | La sala está vacía. Arregla eso. | |
| 5 | `landing.cta.body` | Arma una comunidad en menos de un minuto. Al caos lo invitas después. | |

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
