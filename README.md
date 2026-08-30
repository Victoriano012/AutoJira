# AutoJira

A project manager where you interact with a **graph of tickets** — and the AI does all the work underneath.

- **Graph, not lists.** Tickets are nodes; edges are dependencies. Drag between node handles to add a dependency (cycles are rejected).
- **Recursive.** Every ticket can hold its own subgraph (double-click a node or hit *Open*). The project itself is just the root graph.
- **AI does the work.** Every ticket has a ▶ Run button that hands the ticket to a Claude Code agent (the Claude Agent SDK harness — real file edits, bash, etc., in the workspace directory). **Run graph** executes the whole current graph in dependency order.
- **Human-review tickets.** Tickets typed *AI work + human review* stop after the AI finishes: test the result, send feedback (the agent resumes the same session and fixes it), then Approve. An in-flight graph run continues automatically after approval.
- **Non-blocking reviews.** Uncheck "blocks dependents" on a review ticket and dependents start as soon as the AI work is done: the next agent branches off in git (`autojira/<ticket>`), while you test — and get fixes on — the review ticket's branch in parallel. Agents commit once per ticket, so branches stay clean.
- **✨ Populate with AI.** Describe the project (or a ticket) in plain text and the AI generates the ticket graph with dependencies — one layer at a time; populate subgraphs later the same way.
- **Context files.** Attach files (PNGs, PDFs, anything) to the project or to any ticket; they are inherited by every subticket underneath and handed to the agent — both when populating graphs and when running tickets.
- **Projects are folders.** A new project creates a folder under `~/Documents/personal` (override with `AUTOJIRA_HOME`); the agent works right in it. Import any existing folder from the picker — its `.autojira` state is adopted, or created on the spot. Everything is autosaved to `<workspace>/.autojira/project.json`; no database, no login.
- Done tickets get a green border + check; parent tickets show subgraph progress.

## Setup

```bash
npm install
npm run dev
```

Agent auth: both agent routes go through the Claude Agent SDK. Locally it picks up your Claude Code login automatically. On a server, set **one** of:

- `CLAUDE_CODE_OAUTH_TOKEN` — subscription auth (Pro/Max/Team/Enterprise limits, no per-token billing). Generate with `claude setup-token`. Personal token: keep the deployment access-protected, since anyone using the app consumes your limits.
- `ANTHROPIC_API_KEY` — pay-per-token API billing.

The **workspace dir** in the toolbar defaults to the project's folder; change it to point the agent elsewhere.

AutoJira is designed to run **locally** — projects are folders on your machine and the agent edits them in place. A Vercel deployment builds and runs, but its filesystem is ephemeral, so it's only useful for demos.

## Architecture

- `lib/types.ts` — recursive ticket/graph model + graph helpers
- `lib/store.ts` — zustand store; `lib/sync.ts` autosaves to the server
- `lib/projects-fs.ts` — projects on disk: `<workspace>/.autojira/project.json`, imports registry in `~/.autojira/imports.json`
- `lib/runner.ts` — client-side orchestration: topological graph runs, review gating, feedback via session resume
- `app/api/agent/route.ts` — Claude Agent SDK run, streamed as NDJSON
- `app/api/populate/route.ts` — description → ticket graph (structured output)
- `components/` — React Flow canvas, ticket node, detail panel, toolbar
