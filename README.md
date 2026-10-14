# Mutagen Sync for Obsidian

See and control [Mutagen](https://mutagen.io) sync of your vault without a terminal: a status bar dot shows whether the vault's Mutagen project (`mutagen.yml` in the vault root) is syncing, and a click starts, pauses or resumes it.

Requires Obsidian desktop and the `mutagen` CLI (path configurable in settings).

- grey - no `mutagen.yml`, no `mutagen` binary, or project not started
- yellow - sync paused
- green - sync running
- red - sync error

Click the dot: `mutagen project list` output, Start / Pause / Resume, Settings. Without a config the menu offers to create `mutagen.yml` from a template set in settings. Status is pushed by a single `mutagen sync monitor` process, no polling.

## Install via BRAT

1. Install the **BRAT** community plugin.
2. BRAT -> *Add beta plugin* -> `artemc/obsidian-mutagen-plugin`.
3. Enable **Mutagen Sync**. BRAT pulls new releases automatically.

## Release

```sh
npm version patch   # bumps package.json, manifest.json, versions.json, creates tag
git push --follow-tags
```

GitHub Actions builds and publishes a release with `main.js`, `manifest.json`, `styles.css`.

---

Made with [Claude Code](https://claude.com/claude-code).
