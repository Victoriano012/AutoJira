import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { readProject, writeProject } from "../lib/projects-fs.ts";
import * as store from "../lib/server/project-store.ts";
import type { ProjectEvent } from "../lib/server/project-store.ts";
import { defaultProject, newTicket } from "../lib/types.ts";

/**
 * The server's project store, on a scratch project: what the live feed is
 * told when a run changes a status, when the project agent adds tickets, and
 * when either side of the conversation says something.
 */

const SCRATCH =
  "/private/tmp/claude-501/-Users-victor-Documents-personal-AutoProject/4fe223bd-0cee-4edf-931c-01648c66e1ed/scratchpad/store-events";

function scratchProject(name: string) {
  const dir = path.join(SCRATCH, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  writeProject(dir, {
    ...defaultProject(name, dir),
    tickets: [newTicket({ id: "a", title: "A", statusChangedAt: 1 })],
  });
  const events: ProjectEvent[] = [];
  const unsubscribe = store.subscribe(dir, (e) => events.push(e));
  return { dir, events, unsubscribe };
}

test("a status change stamps statusChangedAt and publishes it", () => {
  const { dir, events, unsubscribe } = scratchProject("status");
  try {
    const before = Date.now();
    store.updateTicket(dir, "a", (t) => ({ ...t, status: "running" }));
    const [e] = events;
    assert.equal(e.type, "ticket");
    if (e.type !== "ticket") return;
    assert.equal(e.id, "a");
    assert.equal(e.patch.status, "running");
    assert.ok((e.patch.statusChangedAt ?? 0) >= before);
    assert.equal(store.getProject(dir)!.tickets[0].statusChangedAt, e.patch.statusChangedAt);

    // A change that leaves the status alone does not re-stamp it.
    store.updateTicket(dir, "a", (t) => ({ ...t, resultSummary: "half way" }));
    const second = events[1];
    assert.equal(second.type, "ticket");
    if (second.type !== "ticket") return;
    assert.equal(second.patch.statusChangedAt, undefined);
    assert.equal(store.getProject(dir)!.tickets[0].statusChangedAt, e.patch.statusChangedAt);
  } finally {
    unsubscribe();
    store.forget(dir);
  }
});

test("adding tickets publishes them, with ids, todo and stamped", () => {
  const { dir, events, unsubscribe } = scratchProject("add");
  try {
    const before = Date.now();
    const added = store.addTickets(dir, [
      { title: "B", description: "Build B.", files: ["src/b.ts"] },
      { title: "C", description: "Build C." },
    ]);
    assert.equal(added.length, 2);
    const [e] = events;
    assert.equal(e.type, "tickets");
    if (e.type !== "tickets") return;
    assert.deepEqual(e.removed, []);
    assert.deepEqual(
      e.added.map((t) => t.title),
      ["B", "C"]
    );
    for (const t of e.added) {
      assert.ok(t.id);
      assert.equal(t.status, "todo");
      assert.deepEqual(t.log, []);
      assert.ok((t.statusChangedAt ?? 0) >= before);
    }
    assert.deepEqual(e.added[0].files, ["src/b.ts"]);
    // On the board, after the ticket that was already there — and on disk.
    assert.deepEqual(
      store.getProject(dir)!.tickets.map((t) => t.title),
      ["A", "B", "C"]
    );
    store.flush(dir);
    assert.equal(readProject(dir)!.tickets.length, 3);

    store.removeTickets(dir, [added[0].id]);
    const gone = events[1];
    assert.equal(gone.type, "tickets");
    if (gone.type !== "tickets") return;
    assert.deepEqual(gone.removed, [added[0].id]);
    assert.deepEqual(
      store.getProject(dir)!.tickets.map((t) => t.title),
      ["A", "C"]
    );
  } finally {
    unsubscribe();
    store.forget(dir);
  }
});

test("the conversation publishes what was appended", () => {
  const { dir, events, unsubscribe } = scratchProject("chat");
  try {
    const entries = [
      { kind: "user" as const, text: "Add a cart", ts: 1, mode: "panel" as const },
      { kind: "text" as const, text: "On it.", ts: 2, mode: "panel" as const },
    ];
    store.appendChat(dir, entries);
    assert.deepEqual(events, [{ type: "chat", entries }]);
    assert.deepEqual(store.getProject(dir)!.chat, entries);
    // Nothing to say, nothing said.
    store.appendChat(dir, []);
    assert.equal(events.length, 1);
  } finally {
    unsubscribe();
    store.forget(dir);
  }
});
