pqp now runs voice servers in three places: São Paulo, still home, plus Miami and London. If you are far from Brazil, your call now talks to a server near you, and your voice gets there faster.

## Closer servers, lower delay

Until this week, every call that went through a server went through São Paulo, wherever you were. Great if you play from Brazil. For everyone else, every sentence made a long trip down here and back.

Here is how it works now:

- **Miami:** the United States, Canada, Mexico, Central America, the Caribbean, Colombia and Venezuela.
- **London:** the UK, Ireland, western and northern Europe, Poland, Czechia, Nigeria, Ghana and Kenya.
- **São Paulo:** Brazil and everywhere else.

The difference is big. We measured it today from the UK: the London server answers in about 15 ms, and São Paulo in about 190 ms. And a test call between the UK and São Paulo had zero packet loss on every server.

## How it works

You do not have to do anything. In communities and bigger servers, voice goes through a pqp server, and pqp picks the one closest to the people in that server. Everyone in the call lands on the same one, so nobody gets split off from the conversation.

DM calls and calls in small servers already connect you straight to each other, with no server in the middle. That has not changed.

Want to see where pqp runs, and whether each server is up right now? There is a new map on the home page, at [pqp.gg/#where](https://pqp.gg/#where).

## Watch party

Watch parties still stream from São Paulo, and reach you through Cloudflare's network, close to wherever you are watching.

They got better too:

- Low-latency mode is smoother. When your connection hiccups, the player takes a few seconds of cushion instead of freezing, then gives them back when it can.
- In **Past broadcasts** you can rewatch a show, and **Download** has the presenter's camera and voice. A low-latency show also gets the whole video, ready a few minutes after it ends.
- Each past show lists its peak of people watching together and how many different people came by.
- An update on our side no longer drops a watch party in the middle of the film.

## The rest

- pqp speaks Spanish now. Pick **Español** in **Settings**, **Appearance & Language**. A browser set to Spanish opens in it on its own.
- Push-to-talk works on every screen, even while you type. In the desktop app (0.1.9) it works with the window in the background.

## Not yet

- The iPhone and Android apps do not pick a region yet. A call started from a phone opens in São Paulo. Joining a Miami or London call from a phone works fine.
