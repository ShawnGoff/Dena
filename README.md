# Dena

**Development Explained, Not Assumed.**

Understand how things get built. Dena records the work you do with an AI coding assistant
(Claude Code) and turns it into a guide people can learn from: step-by-step instructions for each
piece of work, pages that explain the project and its code, and a plain record of what the AI did.

Everything Dena writes is tied to the evidence it came from (your prompts, the AI's edits, commands,
test runs and commits), and every statement says how sure it is. **AI-written text can be wrong**;
Dena labels it so you can check, and never invents history it did not capture.

> **Status:** early, local-first, single-user. Tested on macOS with Node 22. It runs entirely on
> your computer; nothing is uploaded anywhere except the text Dena sends to Claude when it writes.

## What you get

- **Guide**: one step per piece of work, written as instructions you can follow: what you'll
  build, what you need first, numbered steps with the real commands and code, how to check it
  works, and what went wrong along the way. The story of how the AI did it is folded underneath.
- **Wiki**: pages on the project: an overview, a **product guide** (what it does and how to use
  it), **Build it yourself** (one tutorial for the whole project), the architecture, and one page per
  component. Each ends with *What you can learn here* and *How the AI built this*.
- **Code**: a page per source file, explained function by function. When code changes, only the
  changed functions are explained again.
- **Activity**: what the AI did, session by session, in plain language. No AI is used to write it.
- **Timeline**, **Memory** (problems and fixes, decisions, concepts) and **Search** over everything
  captured.
- **Keeping it current**: when new work arrives, Dena keeps every statement whose evidence did not
  change, rewrites only the rest, and shows you what it added, changed and removed before applying it.
- **Export**: the whole guide as Markdown, or as a single HTML page you can share.

## Requirements

- macOS (Linux should work but is untested; Windows is untested).
- [Node.js](https://nodejs.org) 20 or newer.
- [Claude Code](https://claude.com/claude-code), signed in. Dena uses *your* Claude Code to write,
  with your Claude account by default, so writing uses your plan's usage rather than API credits.
  If the `claude` command is not on your PATH, Dena finds the copy bundled with the Claude desktop
  app, or you can point `DENA_CLAUDE_BIN` at it.
- git (optional): commits and branch switches are captured when the project is a git repository.

## Getting started

```bash
git clone https://github.com/ShawnGoff/Dena.git
cd Dena
npm install
npm run build:web
npm link
```

`npm link` makes the `dena` command available in any folder (`npm unlink -g dena` removes it).
Keep the cloned folder where it is: the command runs Dena from there. Without `npm link`, run
commands from the Dena folder as `npm run -s dena -- <command>` instead.

Register the project you want to document (any folder you work on with Claude Code). In the app,
use **+ Add project** on the left, or pick it from **Worked in recently**, the folders where Dena
noticed you using Claude Code. From the command line:

```bash
dena init ~/code/my-app
dena import-claude my-app
dena import-git my-app
```

Adding a project imports its past from what is already on your computer: the conversations Claude
Code still has, and the full git history. No AI is used. Claude Code deletes conversations after
30 days by default, so to keep a longer history, add `"cleanupPeriodDays": 3650` to
`~/.claude/settings.json`. Dena doesn't record new projects by itself: add a project, then press
**Start recording** on its page.

Optionally, turn on live capture from Claude Code. Dena shows exactly what it will add to the
folder's Claude Code settings and writes nothing until you add `--yes`:

```bash
dena hooks install my-app
dena hooks install my-app --yes
```

Start Dena and open it in your browser:

```bash
dena serve --open
```

In the page, press **Start recording**, then work with Claude Code as usual. Dena captures as you
go: transcripts, file changes, git, and (with hooks) exit codes and timings. When there is work to
look at, open **Guide**, pick a step and press **Explain**.

The link carries a key that keeps other web pages out. It stays the same each time Dena starts, so
you can bookmark it; `dena open` opens it whenever Dena is running, and `dena serve --new-key`
replaces the key.

### Keep it running in the background (macOS)

With `dena serve`, recording stops when you close that terminal. To have Dena start when you log
in and keep running, add it as a login item. Dena shows exactly what it will add and writes nothing
until you add `--yes`:

```bash
dena service install
dena service install --yes
dena open
```

Projects you left recording carry on recording. `dena service status` shows whether it is running,
the log is in `~/.dena/logs/server.log`, and `dena service uninstall` removes it.

## Usage and cost

Dena only calls a model when you ask it to write something, and it shows an estimate first.

- **Choose the model** in the settings box on the left of Guide, Wiki or Code. Haiku is the
  cheapest and works well. If you don't choose, Dena uses your Claude Code default model. A
  different model can be used for a single run with *change for this run*.
- **Depth**: *Concise* (the default) writes shorter steps with far fewer tokens than *Thorough*.
- Steps that changed nothing (a question, "yes, go ahead") and steps that only saved work in git
  ("commit, merge, push") are written from the facts, without a model.
- **Explain remaining steps…** in the Guide explains every step not explained yet, in as few calls
  as possible, after showing the estimate.
- **Budget for big jobs** ("Stop at about …" where a big job starts: remaining steps, a folder, the
  tutorial's "explain first", the update queue; or `dena config <project> max-tokens 100k`): the run
  stops before going over, keeps every finished step, and the next run carries on where it stopped.
  Use it to spread a big job over several days. It does not change how steps are written.
- Updates still waiting when Dena stopped never resume on their own; Overview asks first.
- Dena sends the model only what a step can teach from: the changed lines of each diff (not the
  surrounding code), commands that did something (commands that only looked around become one
  line), and the most useful evidence first when an episode is large.
- Updates are targeted: only the statements whose evidence changed are sent again.
- Writing the whole-project tutorial, or explaining a whole folder of code (*Explain folder…* in
  the Code tab), covers a lot at once, so it always asks first and shows the estimate.
- Every call's real token use is recorded. Estimates are ranges learned from your recent calls.

As a rough guide on Haiku: a concise step takes about 5–10k tokens, a wiki page about 14k, and a
code file of a few hundred lines about 8k.

## Privacy and safety

- Dena's data lives in `~/.dena` (set `DENA_HOME` to put it elsewhere). It is never committed or uploaded.
- The local server listens on `127.0.0.1` only and needs the key in its link. The key is kept in
  `~/.dena/server-key`, readable only by you.
- Secrets that look like API keys, tokens or passwords are removed before anything is stored or
  sent. Files such as `.env`, private keys and credential files are never read; their changes are
  recorded only as "a sensitive file changed".
- When Dena writes, it sends the redacted evidence for that one step or page to Claude through your
  own Claude Code, with tools turned off: the model cannot read files or run anything.
- Exports contain your project's history. Read one before you share it.

## What Dena can and can't see

It captures Claude Code's transcripts, file changes in the project folder, git history, and (with
hooks) the results of the AI's commands. It does **not** see commands you run yourself in other
terminals, and it sees file changes but not always who made them; it says "likely the AI" only when
the evidence connects a change to one of the AI's commands. Known gaps are listed in *About this guide*.

## Command line

Run any command as `dena <command>` (or `npm run -s dena -- <command>` from the Dena folder). The most useful:

| Command | What it does |
|---|---|
| `init <dir>` | Register a project folder |
| `serve [--open]` | Start the web interface (recording starts from there) |
| `open` | Open the running Dena in your browser |
| `service install [--yes]` | Keep Dena running in the background on macOS (a login item) |
| `record <project>` | Record from the terminal instead, until Ctrl-C |
| `hooks install <project> [--yes]` | Live capture from Claude Code (shows the change first) |
| `episodes <project>` | List the pieces of work Dena found |
| `explain <project> <n> [--model M]` | Explain one step |
| `guide build <project> [--yes]` | Explain many steps in as few calls as possible (estimate first) |
| `wiki <project> [page]` | List or write wiki pages (`overview`, `product`, `tutorial`, `architecture`, `component:<folder>`) |
| `code <project> [file] [--explain]` | List source files, or explain one |
| `log <project>` | What the AI did, session by session |
| `export <project> [--html] [--out FILE]` | The whole guide as Markdown, or as one shareable HTML page |
| `config <project> [key value]` | Model, depth, sign-in and spending cap |

`dena help` lists everything.

## How it works

See [docs/how-it-works.md](docs/how-it-works.md) for the evidence model, how statements are
checked, and how the guide stays current.

## Development

```bash
npm test            # all tests (vitest)
npm run typecheck   # TypeScript, server and web
npm run build:web   # rebuild the web interface after changing apps/web
```

The code is an npm workspace: `packages/core` (event store), `packages/adapters` (capture),
`packages/engine` (episodes, writing, checks, exports), `packages/server` (local API),
`packages/cli`, `packages/hook` (the Claude Code hook) and `apps/web` (the interface).
