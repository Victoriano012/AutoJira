"use client";

import { useEffect, useState } from "react";
import { createProject, deleteProject, openProject } from "@/lib/sync";

interface Row {
  id: string;
  name: string;
  updated_at: string;
}

export default function ProjectPicker() {
  const [projects, setProjects] = useState<Row[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const res = await fetch("/api/projects");
    if (res.ok) setProjects((await res.json()).projects);
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await createProject(name.trim());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="w-full max-w-md rounded-2xl bg-white border border-zinc-200 p-6 shadow-sm">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Your projects</h2>
          <a
            className="text-xs text-zinc-400 hover:text-zinc-700"
            href="/api/auth/signout"
          >
            Sign out
          </a>
        </div>
        <div className="mt-3 space-y-1">
          {projects === null && <p className="text-sm text-zinc-500">Loading…</p>}
          {projects?.length === 0 && (
            <p className="text-sm text-zinc-500">No projects yet — create one below.</p>
          )}
          {projects?.map((p) => (
            <div
              key={p.id}
              className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-zinc-100"
            >
              <button
                className="flex-1 min-w-0 truncate text-left text-sm font-medium"
                onClick={() => void openProject(p.id)}
              >
                {p.name}
              </button>
              <span className="shrink-0 text-[10px] text-zinc-400">
                {new Date(p.updated_at).toLocaleDateString()}
              </span>
              <button
                className="shrink-0 text-zinc-300 hover:text-red-500 opacity-0 group-hover:opacity-100"
                title="Delete project"
                onClick={async () => {
                  if (confirm(`Delete project “${p.name}”?`)) {
                    await deleteProject(p.id);
                    void refresh();
                  }
                }}
              >
                🗑
              </button>
            </div>
          ))}
        </div>
        <div className="mt-4 flex gap-2">
          <input
            className="flex-1 rounded-lg bg-zinc-50 border border-zinc-300 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
            placeholder="New project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
            }}
          />
          <button
            className="rounded-lg px-3 py-1.5 text-sm bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50"
            disabled={!name.trim() || busy}
            onClick={() => void create()}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
