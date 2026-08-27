Anybody sharing their whole screen was also sending the machine's entire audio. Including the call itself. So everyone heard themselves come back.

That was our bug. One word in the capture options. Two people reported it and a third left it in a call rating: *"Quando alguém transmite, ele repete a Call de quem esta na chamada tbm. Aí fica com eco."*

Fixed.

## What changed

The machine's sound is now **optional and off by default**. There is a button next to the share control, and it says what it will do before you turn it on.

Sharing a **Chrome tab** still carries that tab's own sound with no toggle at all. That is the clean route: a tab share captures that tab and nothing else, so the call is not in it.

| How you share | Sound | Echo |
|---|---|---|
| A Chrome tab | yes | no |
| Whole screen, button off | no | no |
| Whole screen, button on | the whole PC | possible |
| Safari and Firefox | no | no |

## A correction to something we wrote

The post from 22 August said a whole-screen share on Windows carries sound. It did. What we did not say, because we did not know, is that it carried the call along with it. Now it only goes if you ask.

If you do turn it on, the echo can come back, because it is still the whole computer's output. On Chrome 141 and up we ask the browser to strip our own page's audio out of the capture, but we have never tested that against a real Windows loopback, so we are not going to sell it as solved.

Desktop app users are already fixed without updating anything.

## No more unlabelled buttons

Every icon button in pqp now says what it does on hover. There were twenty eight of them with no label at all, including the new one above, which the person who shipped it could not identify by looking.

## On Android

GIFs animate instead of sitting still, and video got a real player instead of not opening.
