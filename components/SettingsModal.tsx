"use client";

import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";

const MODELS = [
  { value: "claude-fable-5", label: "Fable (default)" },
  { value: "claude-opus-5", label: "Opus" },
  { value: "claude-sonnet-5", label: "Sonnet" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku" },
];

/** App-wide settings. Add future settings as more labeled rows below. */
export default function SettingsModal({ onClose }: { onClose: () => void }) {
  // Per-project setting; absent when settings opens from the meta-graph.
  const projectId = useStore((s) => s.projectId);
  const workspaceDir = useStore((s) => s.project.workspaceDir);
  const setProject = useStore((s) => s.setProject);

  const [model, setModel] = useState("claude-fable-5");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch("/api/config")
      .then((res) => res.json())
      .then((cfg: { model?: string }) => setModel(cfg.model || "claude-fable-5"))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/30"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-xl"
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
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
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
