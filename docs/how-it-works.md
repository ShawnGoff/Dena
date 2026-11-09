# How Dena works

Dena turns recorded work into a guide in layers. Each layer is built from the one below it, so
anything Dena writes can be traced back to what actually happened.

## 1. Events: what was captured

Everything starts as **events**: a prompt you typed, a reply from the AI, a tool call, a file
change, a command and its result, a test run, a commit, a note the AI left about a decision.
Events come from several sources:

- **Claude Code transcripts**: prompts, replies, tool calls and edits.
- **Claude Code hooks** (optional): exit codes, timings and agent notes, as they happen.
- **The file watcher**: changes in the project folder, with diffs.
- **git**: commits and branch switches.

Events are never edited once stored. Secrets are removed before storage, and sensitive files are
recorded only by name. When a source cannot see something (for example, commands you run in your
own terminal), Dena records that as a known gap rather than pretending it saw everything.

**Correlation** links related events: an edit the AI made and the file change the watcher saw, a
command and the commit it created. Links say how strong they are: observed, inferred or weak.

## 2. Episodes: pieces of work

Dena groups events into **episodes**, usually one request from you and everything the AI did in
response. Episodes are numbered in order and grouped into chapters, one per work session. They are
rebuilt from events whenever needed, so they never drift from the record.

## 3. Writing a step

To explain an episode, Dena builds an **evidence packet**: a bounded, redacted view of that
episode's events, each item numbered (E1, E2, …). It is built to be lean: diffs are reduced to the
lines that changed, commands that only looked around fold into one line, a commit's diff is not
repeated when the same changes are already there, and when an episode is larger than the budget
the most useful evidence (the request, results, errors, notes, then the latest changes) is kept first. The model is asked to write a step as
**statements**, each citing the items it rests on and labelled with what kind of statement it is:

| Label | Meaning |
|---|---|
| Observed | Shown directly by the cited evidence |
| Inferred | A reasonable conclusion from the evidence, not shown outright |
| Agent said | What the AI said about its own reasoning (its account, not proof) |
| You said | Context you added yourself |
| Background | General knowledge, not a claim about the project |

A step is written as instructions: what you'll build, what you need first, numbered steps with the
real commands and code, how to check it works, and what went wrong. The parts Dena can count
itself, such as which files changed and what the tests reported, are filled in from the events
without a model.

## 4. Checking

Every statement is checked before it is shown: its references must exist; an "Agent said"
statement must cite something the AI said; a statement about test results must match the captured
outcome; code in a step should appear in the evidence. Small problems are fixed by weakening or
removing the statement (never by adding one), and anything left is shown on the page. Passing the
checks does not make a statement true, which is why the labels and the evidence links are always visible.

## 5. Pages and code

**Wiki pages** are written from numbered sources: facts Dena counted from events, statements from
explained steps, and the project's own files (its README, scripts and help text). Every source
leads back to events or a file.

**Code pages** split each source file into functions, classes, methods and types, and explain each
one separately. Explanations are stored under a fingerprint of the code, so after a change only
the functions whose code changed are explained again.

How a file is split depends on its language:

- **TypeScript and JavaScript**: read with the TypeScript compiler, so every function, class, method and type is found exactly.
- **C, C++, C#, Objective-C, Java, Kotlin, Scala, Groovy, Swift, Go, Rust, Zig, Dart, PHP, Solidity, Perl, PowerShell, R, shell scripts, Arduino and shaders (HLSL, GLSL, Godot, Unity)**: split by their braces into classes (shown without their methods' bodies), methods and functions.
- **Python, GDScript and Nim**: split by indentation.
- **Ruby, Crystal, Lua, Julia and Elixir**: split at each top-level definition and its `end`. Elixir modules are explained whole.
- **Everything else**: Haskell, OCaml, F#, Clojure, Erlang, Elm, Visual Basic, Pascal, Fortran, assembly, SQL, HTML, CSS and similar files are explained whole, or in parts of about 150 lines.

Code outside any function (imports, constants, top-level statements) becomes one "imports and setup" part. Apart from TypeScript and JavaScript, the splitting reads the code's shape rather than fully parsing it, so unusual code may be split less neatly; nothing is lost when that happens, it is only grouped differently.

**How the AI built this** and the **Activity** log are not written by a model at all: they are told
from the events.

## 6. Staying current

When new evidence arrives, Dena compares it with what each step or page was written from. A
**targeted update** keeps every statement whose evidence is unchanged, sends the model only the new
evidence and the statements that cite changed evidence, and shows the result as a proposal with
what was added, changed and removed. Nothing is applied until you choose. Your own edits are never
overwritten, and every version stays in the history.

## 7. Listening

The **Listen** button turns a page into spoken text without a model: it reads the title and summary,
then each section in order, saying "Dena infers that…" or "The AI said that…" for statements that
were not directly observed, numbering instructions, and pointing at code on screen instead of
reading it. Long text is split at sentence ends. The part being read is highlighted.

By default the browser's own voices speak. The optional **natural voice** is Kokoro, a small
speech model Dena's server runs in a child process on your computer (`packages/server/src/voice.ts`).
It is installed into `~/.dena/voice` only after you agree, speaks one short piece at a time while
the page prepares the next, and is stopped when idle. The page's policy allows playing the audio
the page itself fetched (`media-src blob:`) and nothing more.

## 8. Calling the model

Dena writes through your own Claude Code, with tools turned off so the model can only read what it
is given. Answers come back in one turn as JSON that Dena checks itself; if an answer does not fit,
Dena asks once more, saying what was wrong. Every call's real token use is recorded, and estimates
are learned from your recent calls.
