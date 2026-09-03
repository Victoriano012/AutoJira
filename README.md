# AutoProject

A project manager where you talk to **one agent per project** — and the AI does all the work underneath.

- **A board, not a graph.** Each project is a flat board with four columns: *Blocked*, *Working*, *Ready for review*, *Done*. Cards are ordered by arrival; there are no dependencies, subgraphs or manual layout. (The earlier graph-of-tickets design lives on the `graph-era` branch.)
- **One project agent.** The bottom bar talks to a single persistent Claude session per project, in one of two modes:
  - **Panel** (default). Describe what should change; the agent turns it into a few large tickets through an in-process MCP tool (`add_tickets`) and records lasting preferences ("always use pnpm") as **project notes** (`set_notes`), which are injected into every ticket prompt. Cards appear live mid-turn.
  - **Act.** The chat sheet slides up over the board and the agent does the work itself in the workspace, spawning *worker* (parallel coding) and *scout* (read-only) subagents as it sees fit. Both modes share one transcript.
  - Toggle with the toolbar button or **Ctrl+M**; swipe back leaves act mode, then the project.
- **Tickets run themselves.** A new ticket starts right away as its own agent session (real file edits, bash, one commit per ticket); two tickets that list the same file run one after another. Every ticket ends in *Ready for review*: test it, send feedback (the agent resumes the same session), then approve or reject. ▶ in the toolbar re-runs whatever is left, including failed tickets.
- **Context files.** Attach files (PNGs, PDFs, anything) to the project in Settings or to any ticket; both are handed to the ticket's agent. Project description, notes and workspace dir are edited in Settings too.
- **Projects are folders.** A new project creates a folder under `~/Documents/personal` (override with `AUTOPROJECT_HOME`); the agent works right in it. Import any existing folder from the picker — its `.autoproject` state is adopted, or created on the spot (older graph-shaped files are migrated). Everything is autosaved to `<workspace>/.autoproject/project.json`; no database, no login.

## Setup

```bash
npm install
npm run dev
```

Choose the agent model in **Settings**. Claude models run through the Claude Agent SDK, GPT-5.6 models through the Codex CLI, and Gemini 3.7 Flash / 3.1 Pro through the local Antigravity CLI (`agy`); AutoProject does not call any provider's model API directly. The board MCP tool and act-mode subagents are Claude-only — with Codex or Gemini the panel turn falls back to structured output and act mode works alone. Claude runs are capped at a 200k-token context.

For Claude, the app picks up your local login automatically. On a server, set **one** of:

- `CLAUDE_CODE_OAUTH_TOKEN` — subscription auth (Pro/Max/Team/Enterprise limits, no per-token billing). Generate with `claude setup-token`. Personal token: keep the deployment access-protected, since anyone using the app consumes your limits.
- `ANTHROPIC_API_KEY` — pay-per-token API billing.

For Codex, install the CLI and sign in once with your ChatGPT/Codex account:

```bash
npm install -g @openai/codex
codex login
```

AutoProject reuses that saved CLI login. If `codex` is not on the server process's `PATH`, set `AUTOPROJECT_CODEX_PATH` to the executable path.

For Gemini, install the Antigravity CLI (`agy`) and authenticate. AutoProject reuses the terminal's active `agy` login. If `agy` is not on the server process's `PATH`, set `AUTOPROJECT_AGY_PATH` to the executable path.

AutoProject is designed to run **locally** — projects are folders on your machine and the agent edits them in place. A Vercel deployment builds and runs, but its filesystem is ephemeral, so it's only useful for demos.

## Architecture

- `lib/types.ts` — flat project/ticket model, board columns, file-claim helpers
- `lib/store.ts` — zustand store (incl. the panel/act mode); `lib/sync.ts` autosaves and follows the server's SSE feed
- `lib/run-state.ts` — who owns what: the server owns the ticket set and run fields, the browser the user-edited ones
- `lib/projects-fs.ts` — projects on disk: `<workspace>/.autoproject/project.json`, imports registry in `~/.autoproject/imports.json`
- `lib/server/project-store.ts` — in-memory projects + event bus behind the feed
- `lib/server/runs.ts` — ticket scheduling (file claims, auto-run), review gating, feedback via session resume
- `lib/server/project-agent.ts` — the project agent: one resumed session, panel/act preambles, worker/scout subagents
- `lib/server/board-tools.ts` — the in-process MCP server (`add_tickets`, `set_notes`) and the structured-output fallback
- `lib/server/agent.ts` — provider-neutral agent runner; dispatches to Claude, Codex (`codex.ts`) or Gemini (`gemini.ts`)
- `app/api/agent`, `app/api/runs`, `app/api/projects` — agent turns, ticket runs + SSE stream, project CRUD
- `components/` — project picker (meta graph), board, act sheet, bottom bar, toolbar, settings
