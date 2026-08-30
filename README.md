# AutoJira

A project manager where you interact with a **graph of tickets** — and the AI does all the work underneath.

- **Graph, not lists.** Tickets are nodes; edges are dependencies. Drag between node handles to add a dependency (cycles are rejected).
- **Recursive.** Every ticket can hold its own subgraph (double-click a node or hit *Open*). The project itself is just the root graph.
- **AI does the work.** Every ticket has a ▶ Run button that hands the ticket to a Claude Code agent (the Claude Agent SDK harness — real file edits, bash, etc., in the workspace directory). **Run graph** executes the whole current graph in dependency order.
- **Human-review tickets.** Tickets typed *AI work + human review* stop after the AI finishes: test the result, send feedback (the agent resumes the same session and fixes it), then Approve. An in-flight graph run continues automatically after approval.
- **Non-blocking reviews.** Uncheck "blocks dependents" on a review ticket and dependents start as soon as the AI work is done: the next agent branches off in git (`autojira/<ticket>`), while you test — and get fixes on — the review ticket's branch in parallel. Agents commit once per ticket, so branches stay clean.
- **✨ Populate with AI.** Describe the project (or a ticket) in plain text and the AI generates the ticket graph with dependencies — one layer at a time; populate subgraphs later the same way.
- Done tickets get a green border + check; parent tickets show subgraph progress.

## Setup

```bash
npm install
npm run dev
```

Auth: both API routes go through the Claude Agent SDK. Locally it picks up your Claude Code login automatically. On a server, set **one** of:

- `CLAUDE_CODE_OAUTH_TOKEN` — subscription auth (Pro/Max/Team/Enterprise limits, no per-token billing). Generate with `claude setup-token`. Personal token: keep the deployment access-protected, since anyone using the app consumes your limits.
- `ANTHROPIC_API_KEY` — pay-per-token API billing.

Set the **workspace dir** in the toolbar to the repo/folder the agent should work in. Empty = a temp dir on the server (`AUTOJIRA_WORKSPACE` env overrides the default).

## Deploying to Vercel

Works out of the box (`maxDuration = 300` is set on both routes; add `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` in project env vars). Caveats of the serverless model, to solve in a later iteration:

- The graph is persisted in the browser (localStorage), not a database.
- The agent's workspace on Vercel is ephemeral (`/tmp`) — real work should target a git repo the agent clones/pushes, or run the app locally next to your repo.

## Architecture

- `lib/types.ts` — recursive ticket/graph model + graph helpers
- `lib/store.ts` — zustand store, persisted to localStorage
- `lib/runner.ts` — client-side orchestration: topological graph runs, review gating, feedback via session resume
- `app/api/agent/route.ts` — Claude Agent SDK run, streamed as NDJSON
- `app/api/populate/route.ts` — description → ticket graph (structured output)
- `components/` — React Flow canvas, ticket node, detail panel, toolbar
