# Music player: state audit and redesign proposal

Status: proposal. Nothing in this file is built yet.

Written against PR #757 (`feat/music-player-stable`, commit `126c5364`), run
locally on 2026-09-21. The stack ran on port 3002 (API) and 5174 (client),
against a separate database `pqp_pr757`, because another worktree holds 3001
and 5173. Every state below was driven in a real browser as the seeded owner
account (Dev User) in the Sandbox Lobby call, except where the table says
"read from code".

Read `docs/MUSIC.md` first. This file only covers the client surface.

## 1. What cannot change

Three constraints set the shape of any redesign. A proposal that breaks one
of them is not a proposal.

1. **The YouTube iframe must never unmount.** Unmounting stops the sound.
   This is why the embed lives in one host (`music-embed-host.tsx`) and is
   painted into a placeholder through a portal. Any new placement must keep
   one host across every state change.
2. **The room state is one object, last writer wins.** The client must not
   need a new frame to show a new layout. Everything proposed here reads
   fields that already exist.
3. **Rights are enforced on the server.** A control that a member may not
   use must still be safe to show. See `musicWriteAllowed`.

## 2. State inventory

| # | State | Where it draws today | What is wrong |
|---|---|---|---|
| 1 | In a call, nothing playing, panel shut | Nothing. `MusicComposer` returns null | The Music tile on the dock is the only entry point, and it looks the same whether music exists or not |
| 2 | Panel open, nothing playing | Fila sheet: title, one hint line, search field | The hint does not say what the feature is or what may be pasted. No examples, no recent tracks |
| 3 | Typing a search | Search field, results list | Results **replace** the queue (`showQueue = !searchActive`). You lose sight of what you built while you add to it |
| 4 | Search needs Enter | Same | Typing produces nothing until Enter. A pasted link resolves only on Enter too. I hit this myself and assumed the field was broken |
| 5 | First track added | 72px bar under the sheet: art, title, who added, transport, seek | Good. This is the strongest part of the PR |
| 6 | Playing, panel shut | The bar only | The bar shows nothing about the queue. Three tracks were queued and the bar gave no sign of them |
| 7 | Playing, panel open, queue of 3 | Sheet with A SEGUIR list over the bar | Two sections compete for one short well. The sheet caps at 28rem or 50dvh and the composer still has to be typeable |
| 8 | Skip, history | Tocadas, collapsed at the bottom of the sheet | Reasonable, but it is the third collapsible thing in one column |
| 9 | Watching the video (Ver no palco) | 16:9 tile on the call stage | With the sheet open the player bar is pushed off the bottom of the window. Three stacked surfaces in one vertical well |
| 10 | In the call, viewing another channel | Sidebar radio plus Fila as a drawer | A second layout with its own now-playing card, its own seek and a five-item `…`. Two designs for one feature |
| 11 | Not in the call, room has music | Card under the channel occupants, with Ouvir | Fine |
| 12 | Member, not a manager | Vote-skip instead of skip, no shuffle, no repeat, no `…` | Read from code, not observed. The bar changes shape by rights, so a member sees a different product, not a restricted one |
| 13 | Not listening (Parar de ouvir) | An Ouvir pill replaces the play button | Read from code. The only way back in is a pill where the play button was |
| 14 | Autoplay waiting for a gesture | "Toque para tocar" pill | Read from code |

## 3. The thesis

The player is one feature spread over five surfaces: the dock tile, the
composer bar, the Fila sheet, the sidebar radio with its drawer, and the
stage tile. Each surface knows only its own slice of the state, so the
person has to open something to learn what the room is doing.

Two rules fix most of it.

**Rule A: the bar always states the whole room.** What is playing, what is
next, how many people are listening. The bar is the one surface that is
always on screen during a call.

**Rule B: the panel is one column that never replaces itself.** Search adds
rows above the queue. It does not hide the queue. Nothing in the panel is a
second copy of the bar.

## 4. The redesign

### 4.1 The bar (the only player)

Keep the composer bar from #757. Add one row and one badge.

```
+---------------------------------------------------------------+
| [art] Never Gonna Give You Up            [shuffle] [<<] (>) [>>] [repeat] |
|  56px  Dev User  ·  3 ouvindo                      [...] [speaker]        |
| 1:51 |=================------------------------------| 3:33   |
| A seguir: Daft Punk - One More Time            +3 na fila  v   |
+---------------------------------------------------------------+
```

- The fourth line is new and is a button. It states the next track and the
  queue size, and it opens the panel at the queue. This is the single
  highest value change in the proposal: it makes the queue discoverable
  without opening anything.
- With an empty queue the same line reads "Continuar com parecidas: on" or
  "A fila acabou. Adicionar" so the line never disappears and the bar never
  changes height.
- "3 ouvindo" replaces nothing. It uses the `listeners` count the
  `channel-music` frame already carries.
- Member and manager get the **same** bar. Skip becomes vote-skip with a
  count badge on the same button, in the same place. Shuffle and repeat stay
  visible and disabled, with the reason in the tooltip. A member should see
  a locked control, not an absence.

### 4.2 The panel (one column)

One panel, one layout, in both places it can appear. Header, search,
results, queue, history.

```
FILA · 4                                    [+] [palco] [x]
+---------------------------------------------------------------+
| [search] Cole um link ou busque                                |
+---------------------------------------------------------------+
| RESULTADOS (only while a query is live)                        |
|   row  row  row                                     [+] [play next]
+---------------------------------------------------------------+
| A SEGUIR · 3                                                   |
|   Daft Punk - One More Time            Dev User   5:21  [x]    |
|   Caetano Veloso - Sozinho             Dev User   4:58  [x]    |
+---------------------------------------------------------------+
| TOCADAS · 2                                              v     |
+---------------------------------------------------------------+
```

Changes against today:

- Search is **always** in the panel, not behind `+`. The `+` in the header
  goes away. One field, always in the same place.
- Search runs as you type, debounced at 350 ms, and a pasted link resolves
  at once without Enter. Enter keeps working and adds the first result.
- Results are a bounded list above the queue, at most five rows with a
  "mais resultados" row. The queue stays visible under it. Escape clears the
  results, not the panel.
- No now-playing card and no second seek in the panel, in either variant.
  The drawer's 48px card goes away. The drawer gets the bar instead, which
  is the same component the composer uses.
- The five-item `…` goes away from the drawer header. Room policy lives in
  the bar `…` only, so there is one menu with one content.

### 4.3 Watching the video

Today, stage plus panel plus bar stack in one column and the bar can leave
the window.

Proposal: when the tile is on the stage, the panel opens as a **right-edge
overlay over the stage**, not in the composer well. The bar stays where it
is. Nothing moves off screen. The embed does not remount because the panel
never held it.

### 4.4 The empty state

State 2 is the first thing a new person sees, and today it is one hint line.

```
FILA · 0
+---------------------------------------------------------------+
| [search] Cole um link ou busque                                |
|                                                                |
| Toca junto com a call. Ninguem ouve pelo nosso servidor:       |
| cada um toca do YouTube na propria maquina.                    |
|                                                                |
| YouTube  ·  YouTube Music  ·  Spotify (link vira busca)        |
|                                                                |
| TOCADAS · 5   (when the room has history)                      |
+---------------------------------------------------------------+
```

The three source names are text, not buttons. They answer "what may I
paste" without a trip to the docs.

### 4.5 The dock tile

One meaning: show or hide the panel. Two visual states already exist
(`data-music-dock="playing|idle"`). Add a small dot on the tile when the
room has music and this person is not listening, so state 13 is visible
without opening anything.

## 5. What changes, by file

| File | Change |
|---|---|
| `music-now-playing.tsx` | Add the "A seguir" row and the listener count. Make member controls disabled rather than absent. Move vote-skip onto the skip button |
| `music-fila.tsx` | Remove `adding` / `searchActive`. Search is always mounted. Results render above the queue. Drop the drawer's now-playing card and its `…`. Add the stage overlay variant |
| `music-search-picker.tsx` | Debounced live search, resolve a pasted link without Enter, cap the visible results |
| `music-mini-player.tsx` | The drawer renders the same bar as the composer instead of its own card |
| `music-extras.tsx` | One overflow menu content. Vote-skip becomes a badge on skip |
| `music-composer.tsx` | Render when the panel is open **or** a track is on, unchanged; pass the stage placement through |
| `locales/*` | New strings for the "A seguir" row, the listener count, the empty state copy and the disabled tooltips |
| `docs/MUSIC.md` | Rewrite the client section once this lands |

No server change. No protocol change.

## 6. Risks

- The bar grows by one line (about 18px). The composer well is already
  tight when the panel and the stage are both on. Section 4.3 buys that back
  by moving the panel off the well when the stage is on.
- Live search raises the load on `GET /api/music/search`. The per-user
  limiter is 20 burst then one every two seconds, so a 350 ms debounce with
  a minimum of three characters is the floor, not a preference.
- The drawer and the composer sharing one bar means one regression can hit
  both. That is the point, but it needs the existing tests extended to the
  drawer.

## 7. Not verified yet

- The member bar (state 12), the not-listening bar (13) and the
  "Toque para tocar" state (14) are designed from code. To see them I need a
  second dev account in a second browser profile
  (`localStorage.setItem("pqp:dev-user-suffix", "bob")` before loading
  `/app`).
- The pane I drove renders about 800 CSS px wide, so the app took its narrow
  layout in places. The drawer position and the 28rem breakpoint behaviour
  need one pass in a real desktop window.
