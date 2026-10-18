pqp is an open source alternative to Discord: voice, text, watch parties and screen share with sound, free. It does not have Discord's third-party bot ecosystem yet, but it covers what people usually go looking for in an alternative: screen shares that carry sound, a watch party, and code anyone can read.

This comparison is about what runs today, not a roadmap promise. Every claim about Discord below has a source link and was checked on 16 October 2026. Where pqp falls short, that is written here too. If something is out of date or wrong, write to contato@pqp.gg and we will fix it.

## What pqp does

**Screen share with sound, in the browser.** In Chrome or Edge, share a tab and tick the tab audio box and the sound goes along; on Windows a whole screen carries sound too. A whole screen on a Mac, Firefox and Safari do not carry sound, which is a browser limit. See the [screen share with audio guide](/blog/compartilhar-tela-com-audio) (in Portuguese) for every platform.

**A watch party.** Share your screen and people watch in the browser, on a computer or a phone, with the chat beside it. It is in early access and switched on one server at a time. A watch party with more than a hundred people has already run on pqp. Step-by-step guide: [how to watch a film together online](/blog/watch-party-assistir-filme-com-amigos).

**Open source.** pqp is licensed under AGPL-3.0, and the code is public. You can read how a feature works, file a bug in the repository, or run your own copy. Running your own copy needs Postgres and your own Clerk account today; there is no Clerk-free path yet.

**Discord layout import.** If your community already exists on Discord, you can copy the structure (categories, channels, roles and the main permissions) by pasting a discord.new template link when creating a community in pqp. It does not copy messages, members or custom emoji. Details in [how to bring your Discord server to pqp](/blog/migrar-servidor-discord-para-pqp) (in Portuguese).

## Feature by feature

Checked on 16 October 2026. Each Discord line links to where it comes from; where we could not verify something, the table says so.

| Feature | pqp | Discord |
|---|---|---|
| Price | Free, no paid plan | Free to use; HD streaming is part of paid Nitro ([discord.com/nitro](https://discord.com/nitro)) |
| Open source | Yes, AGPL-3.0 | No: the terms license the software only to access the service ([discord.com/terms](https://discord.com/terms)) |
| Run it yourself | Yes, with Postgres and your own Clerk account | No self-hosted edition found ([discord.com/terms](https://discord.com/terms)) |
| Screen share | Yes, up to 1080p; frame rate adapts to the connection | Yes, a whole screen or one application ([Wikipedia](https://en.wikipedia.org/wiki/Discord)); exact free-plan limits not verified |
| Sound on a shared screen | Chrome and Edge tab audio; Windows whole screen | Not verified (Discord's help center would not open for us) |
| Watch party | Yes, in early access, any tab you can share | Watch Together, an Activity for YouTube videos ([Discord help](https://support-apps.discord.com/hc/en-us/articles/26502500234519-Watch-Together)) |
| Apps | Browser, desktop, Android; iPhone in beta | Windows, macOS, Linux, iOS, Android, consoles and the browser ([discord.com/download](https://discord.com/download)) |
| Bots and integrations | Small: Discord-compatible incoming webhooks, outgoing webhooks, built-in commands | A public App Directory ([discord.com/application-directory](https://discord.com/application-directory)) |

## Where Discord is ahead

Discord has a much bigger directory of apps and bots, apps on more platforms (consoles included), and years on the road: it has been public since May 2015 ([Wikipedia](https://en.wikipedia.org/wiki/Discord)). pqp has no bot store yet, the iPhone app is a beta, and two brothers make it.

pqp does not pretend to have caught up on either. What it offers instead is a younger product, with someone who answers when a bug shows up.

## When switching makes sense

Switching is worth a try if:

- Your priority is **screen share with sound and watch parties** in the browser.
- You want an **open source** product, whether on principle or because you want to run your own copy.
- Your community is small to medium and does not depend on one specific Discord bot with no equivalent elsewhere.

It makes less sense today if your community depends on a very specific Discord bot, or if you need polished apps on every platform. You can also keep both: nothing you do on pqp touches your Discord.

## Frequently asked questions

**Is pqp free?**
Yes. Voice, text, watch parties and creating a server cost nothing, and the code is open source under AGPL-3.0. You can use the hosted service at pqp.gg or run your own copy, which today needs Postgres and your own Clerk account.

**Is pqp just a Discord clone?**
The base is deliberately similar (servers, channels, roles) because that shape solves the problem. What differs is what came after it: a watch party, screen share with sound in the browser, and open source code.

**Can I import my Discord server?**
You can copy the layout: categories, channels and the main permissions from a discord.new template link, by pasting it when creating a community in pqp. It does not copy members, messages or custom emoji.

**What does Discord still do that pqp does not?**
A much bigger directory of apps and bots, apps on more platforms, and years on the road. pqp has webhooks and built-in commands, but no bot store yet.

## Try it yourself

Trying costs nothing and does not require deleting Discord. Create a community on pqp, invite three or four people to a call, and try sharing your screen with sound. If it works better than what you have today, [create your community](/garanta) and send the link around.
