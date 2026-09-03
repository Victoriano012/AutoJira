"use client";

import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import {
  DEFAULT_MODEL,
  MODEL_CHOICES,
  type ModelProvider,
} from "@/lib/models";
import AttachmentEditor from "./AttachmentEditor";
import StatsModal from "./StatsModal";

const PROVIDERS: { value: ModelProvider; label: string }[] = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "gemini", label: "Gemini" },
];

/** App-wide settings, plus the open project's own fields. Add future settings
 * as more labeled rows below. */
export default function SettingsModal({ onClose }: { onClose: () => void }) {
  // Per-project settings; absent when settings opens from the meta-graph.
  const projectId = useStore((s) => s.projectId);
  const description = useStore((s) => s.project.description);
  const workspaceDir = useStore((s) => s.project.workspaceDir);
  const attachments = useStore((s) => s.project.attachments);
  const notes = useStore((s) => s.project.notes);
  const setProject = useStore((s) => s.setProject);

  const [model, setModel] = useState(DEFAULT_MODEL);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showStats, setShowStats] = useState(false);

  useEffect(() => {
    void fetch("/api/config")
      .then((res) => res.json())
      .then((cfg: { model?: string }) => setModel(cfg.model || DEFAULT_MODEL))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    // Escape belongs to whichever view is on top: the stats view closes back to
    // settings, not straight out of both.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !showStats) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, showStats]);

  async function save() {
    if (busy) return;
    setBusy(true);
    await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    onClose();
  }

  // The stats view takes over the whole overlay rather than stacking on it, so
  // one backdrop click or Escape means one thing. Settings keeps its state.
  if (showStats) return <StatsModal onClose={() => setShowStats(false)} />;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/30"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">Settings</h2>
        <div className="mt-4 space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-zinc-700">Model</span>
            <select
              className="mt-1 w-full rounded-lg bg-zinc-50 border border-zinc-300 px-2 py-1.5 text-sm outline-none focus:border-zinc-500 disabled:opacity-50"
              value={model}
              disabled={!loaded}
              onChange={(e) => setModel(e.target.value)}
            >
              {PROVIDERS.map((provider) => (
                <optgroup key={provider.value} label={provider.label}>
                  {MODEL_CHOICES.filter(
                    (modelChoice) => modelChoice.provider === provider.value
                  ).map((modelChoice) => (
                    <option key={modelChoice.value} value={modelChoice.value}>
                      {modelChoice.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-medium text-zinc-700">Context length</span>
            <select
              className="mt-1 w-full rounded-lg bg-zinc-50 border border-zinc-300 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
              defaultValue="200k"
            >
              <option value="200k">200k</option>
            </select>
          </label>
          {/* The project's own fields autosave like everything else the person
            * types (browser-owned, see lib/run-state.ts); Save below is for the
            * app-wide settings only. */}
          {projectId && (
            <label className="block">
              <span className="text-sm font-medium text-zinc-700">
                Project description
              </span>
              <textarea
                className="mt-1 w-full min-h-28 rounded-lg bg-zinc-50 border border-zinc-300 p-2 text-sm outline-none focus:border-zinc-500"
                placeholder="Describe what this project should accomplish…"
                value={description}
                onChange={(e) => setProject({ description: e.target.value })}
              />
            </label>
          )}
          {projectId && (
            <label className="block">
              <span className="text-sm font-medium text-zinc-700">
                Workspace directory
              </span>
              <input
                className="mt-1 w-full rounded-lg bg-zinc-50 border border-zinc-300 px-2 py-1.5 text-sm font-mono outline-none focus:border-zinc-500"
                placeholder="Server path where the agents work (empty = temp)"
                value={workspaceDir}
                onChange={(e) => setProject({ workspaceDir: e.target.value })}
                title="Directory on the server where the agents work"
              />
            </label>
          )}
          {projectId && (
            <AttachmentEditor
              label="Context files"
              attachments={attachments ?? []}
              onChange={(next) => setProject({ attachments: next })}
            />
          )}
          {projectId && (
            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-zinc-700">
                  Standing instructions
                </span>
                <button
                  className="cursor-pointer inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-white hover:border-violet-400 hover:text-violet-600 px-2.5 py-1 text-xs font-medium text-zinc-600 shadow-sm transition-colors"
                  title="Something every ticket's agent must know"
                  onClick={() => setProject({ notes: [...notes, ""] })}
                >
                  <span className="text-sm leading-none">＋</span> Add
                </button>
              </div>
              {notes.map((note, i) => (
                <div key={i} className="mt-1 flex items-center gap-2">
                  <input
                    className="min-w-0 flex-1 rounded-lg bg-zinc-50 border border-zinc-300 px-2 py-1 text-sm outline-none focus:border-zinc-500"
                    placeholder="Always use pnpm"
                    value={note}
                    onChange={(e) =>
                      setProject({
                        notes: notes.map((n, j) => (j === i ? e.target.value : n)),
                      })
                    }
                  />
                  <button
                    className="shrink-0 text-xs text-zinc-400 hover:text-red-500"
                    title="Remove"
                    onClick={() => setProject({ notes: notes.filter((_, j) => j !== i) })}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          {projectId && (
            <div>
              <span className="text-sm font-medium text-zinc-700">Stats</span>
              <button
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-zinc-50 px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100"
                onClick={() => setShowStats(true)}
                title="Tickets, time, cost and rejections for this project"
              >
                See project stats…
              </button>
            </div>
          )}
        </div>
        <div className="mt-6 flex items-center gap-2">
          <button
            className="mr-auto rounded-lg px-3 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            autoFocus
            className="rounded-lg px-3 py-1.5 text-sm bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50"
            disabled={!loaded || busy}
            onClick={() => void save()}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
