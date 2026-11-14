# Contributing

## The one rule

Every change that touches sync has to come with the scenario it protects. This project
makes a single promise, that no version of anybody's text disappears quietly, and the tests
are how that promise is kept rather than asserted.

## Running everything

Tool versions (node, pnpm, go) are pinned in `mise.toml`.

```bash
mise run setup    # install the pinned tools and dependencies
mise run check    # types, gofmt and vet, then every test
```

`mise run check` builds the server first, which the integration tests need, then runs
the data loss scenarios against a real server (`test:server`) and the plugin's merge,
encryption, and two-devices-end-to-end tests (`test:plugin`). `mise tasks` lists the rest.

The plugin tests spin up a real server and drive the real engine against it with two vaults
on disk. Only Obsidian itself is stubbed.

## Where things live

`server/` is Go with no cgo. The plugin is TypeScript in `src/`, bundled by esbuild into `main.js` at the root, where Obsidian looks for it. `spec/` describes
the protocol and the reasoning behind the decisions; if a change alters behaviour described
there, change that too. `ops/` is deployment.

## Style

Comments explain why, not what. The interesting comments in this codebase are the ones that
say what breaks if the code is written the obvious way instead.

English everywhere: interface strings, README, commit messages, comments. Translations are
added to `src/i18n.ts`, where English is the fallback for every missing key.

Commit messages describe the change and its reason in prose. No trailers.
