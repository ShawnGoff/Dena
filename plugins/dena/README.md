# Dena plugin

Live capture for Dena. Once installed, every Claude Code session on this computer reports to Dena:
exit codes, timings, and the notes channel that lets the agent record why it chose an approach.
Nothing is recorded unless a project is set to **recording** in Dena, and the hook never copies
prompt or tool text (Dena reads that from the transcript, for recorded projects only).

## Install

From the Dena folder you cloned:

```
/plugin marketplace add <path to your Dena folder>
/plugin install dena@dena
```

Run `dena serve` (or open Dena) afterwards; the first-run checklist shows whether capture is on.

## Differences from `dena hooks install`

- The plugin cannot add the permission rule that lets the agent run `dena-hook.mjs note` without a
  prompt. Claude Code will ask the first time; allow it, or add the rule yourself.
- Use one or the other for a project. `dena hooks install <project>` writes the same hooks into that
  project's settings. Both at once may record each event twice.
- The plugin copy of the hook is kept identical to `packages/hook/dena-hook.mjs`. After changing the
  hook, run `npm run sync:plugin`; the test suite fails if the copy is out of date.

## Uninstall

```
/plugin uninstall dena@dena
```

Dena's own data in `~/.dena` is not touched.
