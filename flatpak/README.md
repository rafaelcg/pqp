# Flatpak

Packaging for the pqp desktop app as `gg.pqp.pqp`. It repackages the release's
Linux `.deb` on `org.electronjs.Electron2.BaseApp`. Design notes, permissions
and the Flathub submission steps: [`docs/DESKTOP.md`](../docs/DESKTOP.md) §7.

| File | What it is |
|---|---|
| `gg.pqp.pqp.yml` | The manifest, pinned to one release's `.deb` by sha256 |
| `gg.pqp.pqp.metainfo.xml` | AppStream metadata |
| `gg.pqp.pqp.desktop` | The launcher, with the `pqp://` handler |
| `pqp.sh` | Runs Electron through `zypak-wrapper` |
| `bump.mjs` | Points the manifest at a release (`--pinned` prints the current one) |
| `build-bundle.sh` | Builds the manifest and exports a single-file bundle |

## The `.flatpak` on each release

Every published desktop release (`v*`) gets `pqp-<version>-x86_64.flatpak`
attached by [`.github/workflows/flatpak-manifest.yml`](../.github/workflows/flatpak-manifest.yml),
built from the manifest pinned to that release. To install it:

```bash
flatpak install --user pqp-0.2.5-x86_64.flatpak
flatpak run gg.pqp.pqp
```

The bundle names Flathub as its runtime repo, so on a machine without Flathub
`flatpak install` offers to add it and pulls `org.freedesktop.Platform` from
there. A bundle has no update source and the in-app updater is off inside
Flatpak, so a new version means downloading the next release's bundle.

Backfill a release that was published before this existed:

```bash
gh workflow run flatpak-manifest.yml -f tag=v0.2.5
```

## Build it yourself

On Linux with `flatpak` and `flatpak-builder`:

```bash
flatpak/build-bundle.sh out/pqp-$(node flatpak/bump.mjs --pinned)-x86_64.flatpak
```

It builds into `$FLATPAK_WORK_DIR` (default `/tmp/pqp-flatpak`), then installs
the bundle into a throwaway installation with no remotes and checks the layout
(`SKIP_SMOKE=1` skips that).
