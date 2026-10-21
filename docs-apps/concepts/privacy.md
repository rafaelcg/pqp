# What an app never sees

An app is untrusted code, so what it is allowed to learn about people is decided by the protocol and not by the app's good manners. This page is the list, and how it is kept true.

## The list

An app **never** receives:

- a pqp **user id**
- an **email address**
- a **token** of any kind
- a **server id** or **channel id** (it does not know where it is running)
- a **file name** of a file somebody picks
- **who is in a call with whom**, anything about voice, video, or other channels
- anything **outside its own frame**: the page, other apps, cookies, other tabs

It **does** receive, for each person in the session:

- a **display name** (cleaned of control and bidirectional characters, at most 64 characters)
- an **avatar** as a `data:` URL, or none
- a random **seat id**, valid for this session only
- their **role** (`player` or `spectator`), whether they are the session host, and whether their connection is present or reconnecting
- optionally, an **app-scoped id** (`appUserId`), only for people who consented, only for apps that declared `identity: "user-id"`, and different for every app

And for the device: the **locale**, the **theme tokens**, and whether the person prefers **reduced motion**.

## How it is kept true

- **By construction.** The bridge schemas that describe every message to an app simply have no field for these things. The page builds each participant from scratch (a seat id, a cleaned name, a data URL) rather than filtering a richer object, so nothing extra can leak through a forgotten field.
- **By a test that fails.** `bridge.test.ts` walks every bridge schema and fails if a key named `userId`, `user_id`, `email`, `token`, `serverId` or `channelId` appears on it.
- **Strictly toward the app.** Messages to an app drop unknown keys, so a field the page adds later never reaches an old app by accident.
- **Server frames carry ids, the page strips them.** The WebSocket frames between the page and the server do contain user ids, because the page needs them to draw avatars. They are removed before anything is forwarded to the frame.

## The privacy rules

Some are enforced by code and some are guidance. They are kept apart here, because an author should know which is which.

**Enforced by the platform**

1. **Every capability is opt-in and visible.** `identity`, `localFiles` and `share` default to the least, and what an app asks for is shown to people before they join.
2. **Content is declared.** `content.userText` and `content.userImages` say whether people's own words or pictures appear in your app for others to see. Every app stays off public communities until the operator records a safety decision for it, and these two flags are what that decision reads.
3. **The presence line is yours to write, and bounded.** What pqp shows under a person's name (`Raf is in Eco`) comes from your manifest's `presence` strings: plain text in three languages, exactly one `{name}`, no em dash, and `tu` in pt-BR. The name that goes into it is cleaned (control and bidirectional characters removed, 32 characters at most), and spliced in as plain text, so a name cannot break out of the sentence.
4. **Your source is public.** The manifest requires an open source license and an https source URL, so what the app does with people's data can be read.

**Guidelines for authors** (nothing in the code can force these, and a reviewer reads your source)

1. **Ask for the least.** `display` identity unless you can say what `user-id` is for. `localFiles` off unless the app opens a file. Small `state` and `events` caps.
2. **Do not try to learn more.** Do not try to link a seat to an account by comparing names, avatars or timing. The protocol gives you no way to do it directly, and an app that tries is exactly what a review is meant to catch.
3. **Mind what you copy out.** `state.result` is written into the conversation's record and outlives the session, so keep people's names and avatars out of it.

## What the person controls

- Whether an app can run in their server at all: the server owner can switch an app off for the whole server, and an operator can switch it off everywhere.
- Whether `appUserId` exists: only if they consent.
- Their own files: nothing is read unless they pick it.

Next: the [SDK reference](/sdk/).
