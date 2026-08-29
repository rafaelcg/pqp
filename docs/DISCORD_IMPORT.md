# Copy Discord layout

Paste a Discord Guild Template link. pqp creates a new community whose
sidebar looks like that Discord server.

This is a layout copy. It is not a Discord login, not a bot in their
server, and not a transfer of members or messages.

## What a person does

1. In Discord: Server Settings → Templates → copy the link (`discord.new/…`).
2. In pqp: create a community → **Copy a Discord layout**.
3. Paste the link. Preview the tree, private channels, and dropped items.
4. Confirm. pqp creates the community, then shows an invite to send.

Discord itself is not changed.

## What is copied

- Server name
- Categories, text channels, and voice channels, in sidebar order
- Channel names as Discord spelled them (emoji and spaces included)
- Topics, truncated at 200 characters
- Cosmetic roles: name, colour, hoist, mentionable
- Privacy: a channel is private if Discord `@everyone` (placeholder id `0`)
  is denied VIEW on the channel or its parent category

## What is not copied

Not in a Guild Template:

- Members, messages, attachments, custom emoji, webhooks, bans, Discord invites

Mapped away by pqp:

- Discord permission bits and overwrites other than privacy
- NSFW, slowmode, bitrate, forum tags, threads, directory channels
- Server icon
- Roles that cannot be sanitised to pqp's `letters, numbers, underscore` names
- Roles named `everyone`, `here`, `Owner`, `Admin`, `Manager`, or
  `Moderator` after sanitising (those names are already seeded)

Announcement, forum, and media channels become text channels. Stage channels
become voice channels.

## Privacy

pqp visibility is `channel_viewable`, which reads `channel_overwrites`.
The import writes `@everyone` deny VIEW (`Permission.VIEW_CHANNEL`, bit 6)
for each inferred-private channel via `applyPrivateChannelOverwrites`.

It does not insert `channel_members` for the importer. They are the owner,
so `channel_viewable` already returns true for them.

Inference uses Discord's VIEW bit (`1 << 10`), not pqp's. Categories are
never marked private; a category VIEW deny makes the children private.

This fails closed: a category deny plus a channel allow still marks the
channel private.

## Positions

pqp sibling groups, matching `moveChannel`:

- Top-level text, top-level voice, and categories: three separate `0..n-1`
  sequences (`parent_id IS NULL` plus `type`)
- Inside a category: text and voice share one mixed sequence

Discord's global `position` is not copied as-is.

## Roles

`seedDefaultRoles` still creates `@everyone` (position 0) plus the staff
ladder (Moderator, Manager, Admin, Owner). Imported roles are cosmetic:
they get `PERMISSION_DEFAULT_EVERYONE`. Staff is shifted up by `n` so
the copies sit under the ladder, same as a homemade cargo.

Names are sanitised before insert (NFD, strip marks, spaces to `_`) so
the unique `LOWER(name)` index cannot abort the transaction.

## API

Auth required. Character accounts get 403, same as `POST /api/servers`.

- `POST /api/import/discord/preview` `{ source }` → mapped tree, dropped
  lists, named private channels, `templateUpdatedAt`, `isDirty`. No writes.
- `POST /api/import/discord/apply` `{ source }` → re-fetches and remaps,
  then creates the server in one transaction.

`source` is a bare code, `discord.new/CODE`, or
`discord.com/template/CODE`. The pasted string is never fetched as a URL.
Only `^[A-Za-z0-9]{4,32}$` is interpolated into
`https://discord.com/api/v10/guilds/templates/{code}`.

Fetch uses `safeFetch` (5s, 512KB, 3 redirects). Per-user limiter matches
export. A small global bucket protects the shared Discord egress IP.

Caps: 200 channels, 30 categories, 100 imported custom roles. The 512KB
body cap can fire first.

Audit action: `server.discord_import` (template code and counts, not the
snapshot).

## Operator notes

No `DISCORD_*` env. No bot. No OAuth. The template endpoint is public
for a valid code.

A later rename of a copied channel still uses the Settings regex
(`letters, numbers, - or _`). The first rename after import is when a
name with emoji or spaces has to be slugified.

## Template field inventory (2026-08-28)

A Guild Template is `GET /api/v10/guilds/templates/{code}`. The snapshot lives
in `serialized_source_guild`. Placeholder ids are integers, not snowflakes.
Discord's create-guild body is the shape of that snapshot: name, description,
region, verification level, default notifications, explicit content filter,
preferred locale, AFK timeout, roles, channels, AFK / system channel ids,
system channel flags, icon hash. Channel rows may also carry bitrate, user
limit, NSFW, slowmode, topic, parent, overwrites, forum tags, default archive
/ sort / layout, RTC region, video quality, and flags. Role rows may also
carry permissions, colour, hoist, mentionable, icon, and unicode emoji.

Checked against Discord's Guild Template docs and
`APITemplateSerializedSourceGuild` (`discord-api-types` v10).

### Copied today

| Discord | pqp |
|---|---|
| Guild name | Server name |
| Category / text / voice | Same types, sidebar order recomputed |
| Announcement / forum / media | Flattened to text |
| Stage | Flattened to voice |
| Channel name, topic | Name kept; topic cut at 200 |
| `@everyone` deny VIEW | Private channel (`channel_overwrites`) |
| Role name, colour, hoist, mentionable | Cosmetic role (`PERMISSION_DEFAULT_EVERYONE`) |

### In the template, not copied (pqp has no home, or we refused)

These are on the snapshot. A later cut can copy them only if pqp grows the
matching feature, or if we accept a lossy map.

| Discord field | Why it is dropped | Later? |
|---|---|---|
| `icon_hash` | pqp has `servers.icon_url` / `icon_key`, but the API does not PUT bytes. Icons are a client presign. The template has a hash, not a file. | Yes, if we fetch `cdn.discordapp.com/icons/{source_guild_id}/{hash}` ourselves (constructed URL, not the paste) and add a server-side store path. Scan the image. |
| Guild `description` | pqp `community_tagline` is for listed communities. Import does not opt the server into the directory (`COMMUNITIES_ENABLED` / `is_community`). | Prefill tagline without listing, if we want a poster later. |
| Role `permissions` | Discord bit numbers are not pqp's 20 bits, even when names match (`VIEW_CHANNEL` is Discord `1<<10`, pqp `1<<6`). Auto-map is a privilege decision (`Muted` becoming a full member). | Possible as an explicit, documented subset. Not silent. |
| Overwrites other than `@everyone` VIEW | pqp has a real overwrite editor. Template overwrites name other roles by placeholder id, which we do create. Copying SEND / CONNECT / etc. has the same bit-number problem. | Best next mapping: VIEW allow/deny per imported role only. Still fail closed. |
| Role `icon` / `unicode_emoji` | pqp roles have no icon column. | After role icons exist. |
| `nsfw` | The instance is already 18+. No per-channel NSFW flag. | Unlikely. |
| `rate_limit_per_user` (slowmode) | Gap #20 in [`DISCORD_GAPS.md`](./DISCORD_GAPS.md). No `slowmode_seconds` column. | When slowmode ships. |
| `bitrate`, `user_limit`, `video_quality_mode`, `rtc_region` | No per-channel Discord-style voice caps in schema. | Only if we add those knobs. |
| Forum tags, default reaction, sort, layout, auto-archive | Flattened to text. pqp threads hang off a root message, which a template does not contain. | After a real forum type, not by inventing empty threads. |
| Threads (types 10/11/12), directory (14) | Dropped. Directory is Discord hub-only. | Directory: never. Threads: not from a template. |
| `verification_level`, `explicit_content_filter` | pqp uses an age gate, not Discord's verification ladder. | No. |
| `default_message_notifications` | pqp notification levels are per-user prefs, not a guild default. | No. |
| `preferred_locale` | Could seed `community_language` on list. Import does not list. | Only with a listing flow. |
| AFK channel / timeout, system channel / flags, premium progress bar | pqp has no AFK and no Discord system channel. | No. |
| `region` | Legacy Discord voice region. Unused. | No. |

Announcement, forum, media, and stage as first-class types would stop the
flatten. That is a product type decision, not an import bug.

### Not in a Guild Template

Discord does not serialize these. This paste cannot grow them.

- Members, nicknames, role assignments
- Messages, pins, reactions, attachments
- Custom emoji, stickers, soundboard
- Webhooks, integrations, automod
- Bans, Discord invite codes, vanity URL
- Audit log, scheduled events, onboarding, widget
- Server banner / splash (the template carries `icon_hash`, not banner bytes)
- Member-targeted overwrites (there are no members)

A bot in their server still cannot mint pqp accounts: Discord ids are not
Clerk logins, and there is no email. Message history needs
`MESSAGE_CONTENT`, a scanner, and a server-side upload. Hotlinking
`cdn.discordapp.com` attachment URLs expires. That path is out.

A live Discord → pqp webhook relay of *new* messages is a different product
(incoming webhooks already exist). It is not this paste.

## Related

Prior research: [`research/discord-transfer.html`](./research/discord-transfer.html)
(2026-08-08). The roles section there is stale; roles shipped 2026-08-24.
Field inventory above is 2026-08-28. This feature does not add Discord to
Connections. See [`CONNECTIONS.md`](./CONNECTIONS.md).
