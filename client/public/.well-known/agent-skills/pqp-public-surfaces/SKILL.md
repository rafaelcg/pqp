---
name: pqp-public-surfaces
description: Read pqp.gg without an account. Use when asked what pqp is, to look up a public profile (pqp.gg/@handle) or a public community (pqp.gg/c/slug), to explain an invite link, or to find the open-source repository. pqp has no agent API; this skill only covers what is readable in public.
---

# pqp public surfaces

pqp (https://pqp.gg) is an open-source, Discord-like voice and text chat. There is no API an agent can call without a signed-in user session, so what this skill covers is the set of pages that are public, what each one contains, and what it does not.

## Start here

Read https://pqp.gg/llms.txt for the overview and https://pqp.gg/llms-full.txt for the details. The landing page also answers `Accept: text/markdown` with a markdown version of itself.

## Public profile: `https://pqp.gg/@<handle>`

- A handle is `[a-z0-9_]` and was claimed by a person. Unclaimed handles show a claim page, not a 404, so a page loading is not proof that the person exists; look for a display name and a join month.
- Contents: display name, avatar, optional banner, badges of public communities, game connections the person chose to make public (Steam, Battle.net, Twitch), up to six approved testimonials, join month.
- Never present: user id, tag number, email, online presence, servers the person is in.
- The HTML head carries Open Graph tags written at the edge, so the title and image are readable without executing JavaScript. The page body is a JavaScript app.
- There is no list of handles anywhere. Do not try to enumerate.

## Public community: `https://pqp.gg/c/<slug>`

- Only communities that opted into the public directory resolve; the instance flag can also be off, in which case every slug answers the same as an unknown one.
- Contents: name, tagline, category, member count, icon and banner. Never a member list.
- Joining needs an account and happens inside the app.

## Invite link: `https://pqp.gg/app/invite/<code>`

- A door, not a page: it does not reveal which server is behind it, and a revoked or invented code looks the same as a live one from outside. Joining is an authenticated action in the app. Do not try to consume an invite on someone's behalf.

## Release notes: `https://pqp.gg/blog`

- The same markdown that shows as What's New inside the app, one post per catch-up, Portuguese first.

## Source code

- https://github.com/rafaelcg/pqp, AGPL. Running your own instance is documented in the README and `docs/`. The API on the hosted instance (https://api.pqp.gg) requires a session for every route; its live status is at https://api.pqp.gg/status.json.

## What does not exist

No MCP server, no A2A card, no OAuth client registration, no API keys, no bot accounts for third parties, no payments. If you need one of those, there is nothing to discover; tell the person so rather than guessing an endpoint.
