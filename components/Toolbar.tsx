"use client";

import { useEffect, useState } from "react";
import { autoLayout } from "@/lib/layout";
import { isGraphRunning, runGraph, stopGraph } from "@/lib/runner";
import { useStore } from "@/lib/store";
import { graphAtPath, isTicketDone, newTicket } from "@/lib/types";
import PopulateModal from "./PopulateModal";
import SettingsModal from "./SettingsModal";

export default function Toolbar() {
  const project = useStore((s) => s.project);
  const closeProject = useStore((s) => s.closeProject);
  const path = useStore((s) => s.path);
  const setProject = useStore((s) => s.setProject);
  const setPath = useStore((s) => s.setPath);
  const select = useStore((s) => s.select);
  const addTicket = useStore((s) => s.addTicket);
  const updateTicket = useStore((s) => s.updateTicket);

  const [showPopulate, setShowPopulate] = useState(false);
  const [running, setRunning] = useState(false);
  const [editingDir, setEditingDir] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    const iv = setInterval(() => setRunning(isGraphRunning(path)), 500);
    return () => clearInterval(iv);
  }, [path]);

  const graph = graphAtPath(project.graph, path);

  // Breadcrumb titles along the current path
  const crumbs: { id: string; title: string }[] = [];
  {
    let g = project.graph;
    for (const id of path) {
      const t = g.tickets.find((t) => t.id === id);
      if (!t) break;
      crumbs.push({ id, title: t.title });
      g = t.subgraph;
    }
  }

  const doneCount = graph?.tickets.filter(isTicketDone).length ?? 0;
  const total = graph?.tickets.length ?? 0;

  function handleAddTicket() {
    const t = newTicket({ position: null });
    addTicket(path, t);
    select(t.id);
  }

  function handleAutoLayout() {
    if (!graph) return;
    const positions = autoLayout(graph);
    for (const t of graph.tickets) {
      const p = positions.get(t.id);
      if (p) updateTicket(path, t.id, (x) => ({ ...x, position: p }));
    }
  }

  return (
    <header className="h-16 shrink-0 flex items-center gap-3 px-4 bg-white border-b border-zinc-200">
      <button
        className="shrink-0 text-base text-zinc-500 hover:text-zinc-900"
        onClick={closeProject}
        title="Back to your projects"
      >
        ← Projects
      </button>
      {path.length === 0 ? (
        <input
          className="bg-transparent text-lg font-semibold outline-none rounded px-1 focus:bg-zinc-100 flex-1 min-w-40"
          value={project.name}
          onChange={(e) => setProject({ name: e.target.value })}
          aria-label="Project name"
        />
      ) : (
        <nav className="flex items-center gap-1 text-base font-medium flex-1 min-w-40 overflow-hidden">
          <button
            className="text-zinc-500 hover:text-zinc-900 shrink-0"
            onClick={() => setPath([])}
            title={project.name}
          >
            {project.name}
          </button>
          {crumbs.map((c, i) => (
            <span key={c.id} className="flex items-center gap-1 min-w-0">
              <span className="text-zinc-400">/</span>
              {i === crumbs.length - 1 ? (
                <span className="truncate" title={c.title}>{c.title}</span>
              ) : (
                <button
                  className="text-zinc-500 hover:text-zinc-900 truncate"
                  onClick={() => setPath(path.slice(0, i + 1))}
                  title={c.title}
                >
                  {c.title}
                </button>
              )}
            </span>
          ))}
        </nav>
      )}

      <div className="ml-auto shrink-0 flex items-center gap-2">
        <button
          className="rounded-lg px-4 py-1.5 text-base leading-tight bg-zinc-200 hover:bg-zinc-300"
          onClick={handleAutoLayout}
          title="Auto-layout"
        >
          ⌗
        </button>
        <button
          className="rounded-lg px-4 py-1.5 text-base leading-tight bg-zinc-200 hover:bg-zinc-300"
          onClick={handleAddTicket}
        >
          + Ticket
        </button>
        <button
          className="rounded-lg px-4 py-1.5 text-base leading-tight bg-zinc-200 hover:bg-zinc-300"
          onClick={() => setShowPopulate(true)}
        >
          ✨ Populate with AI
        </button>
        {running ? (
          <button
            className="rounded-lg px-4 py-1.5 text-base leading-tight bg-red-100 hover:bg-red-200 text-red-700"
            onClick={() => stopGraph(path)}
          >
            ◼ Stop
          </button>
        ) : (
          <button
            className="rounded-lg px-4 py-1.5 text-base leading-tight bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
            onClick={() => void runGraph(path)}
            disabled={total === 0}
          >
            ▶ Run graph
          </button>
        )}
        {running && (
          <span className="text-sm text-emerald-600 animate-pulse">running…</span>
        )}
      </div>

      <div className="shrink-0 flex items-center gap-3">
        {total > 0 && (
          <span
            className={`text-sm rounded-full px-3 py-1 border ${
              doneCount === total
                ? "border-emerald-500 text-emerald-600"
                : "border-zinc-300 text-zinc-500"
            }`}
          >
            {doneCount}/{total} done
          </span>
        )}
        {editingDir ? (
          <input
            autoFocus
            className="w-80 rounded-lg bg-white border border-zinc-300 px-3 py-1.5 text-sm font-mono outline-none focus:border-zinc-500"
            placeholder="Workspace dir (server path, empty = temp)"
            value={project.workspaceDir}
            onChange={(e) => setProject({ workspaceDir: e.target.value })}
            onBlur={() => setEditingDir(false)}
            title="Directory on the server where the agent works"
          />
        ) : (
          /* unfocused: left-truncated so the end of the path stays visible
             (dir=rtl moves the ellipsis left; <bdi> keeps the path LTR) */
          <button
            className="w-80 rounded-lg bg-white border border-zinc-300 px-3 py-1.5 text-sm font-mono text-left cursor-text"
            onClick={() => setEditingDir(true)}
            onFocus={() => setEditingDir(true)}
            title="Directory on the server where the agent works"
          >
            {project.workspaceDir ? (
              <span dir="rtl" className="block truncate">
                <bdi>{project.workspaceDir}</bdi>
              </span>
            ) : (
              <span className="block truncate text-zinc-400">
                Workspace dir (server path, empty = temp)
              </span>
            )}
          </button>
        )}
        <button
          className="rounded-lg px-2 py-1.5 text-base leading-tight text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900"
          onClick={() => setShowSettings(true)}
          title="Settings"
        >
          ⚙
        </button>
      </div>

      {showPopulate && <PopulateModal onClose={() => setShowPopulate(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </header>
  );
}
