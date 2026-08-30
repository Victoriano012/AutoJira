"use client";

import {
  createProject,
  deleteProject,
  importProject,
  openProject,
  saveMetaPosition,
} from "@/lib/sync";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { memo, useCallback, useEffect, useState } from "react";

type ProjectNodeType = Node<{ name: string; onDelete: () => void }, "project">;

function ProjectNodeInner({ id, data }: NodeProps<ProjectNodeType>) {
  return (
    <div className="group relative w-64 rounded-xl border-2 border-zinc-300 bg-white p-3 shadow-lg shadow-zinc-900/10 hover:border-violet-400">
      <div className="truncate pr-5 text-sm font-semibold text-zinc-900" title={data.name}>
        {data.name}
      </div>
      <div className="mt-0.5 truncate font-mono text-[10px] text-zinc-400" title={id}>
        {id}
      </div>
      <button
        className="absolute right-2 top-2 text-[#d64545] opacity-0 hover:text-red-700 group-hover:opacity-100"
        title="Remove project (deletes only its .autojira folder, your files stay)"
        onClick={(e) => {
          e.stopPropagation();
          data.onDelete();
        }}
      >
        {/* Feather trash-2 silhouette, as used in FoodApp */}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <line x1="10" y1="11" x2="10" y2="17" />
          <line x1="14" y1="11" x2="14" y2="17" />
        </svg>
      </button>
    </div>
  );
}

const ProjectNode = memo(ProjectNodeInner);
const nodeTypes: NodeTypes = { project: ProjectNode };

function ProjectModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [importPath, setImportPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function run(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn(); // on success the project opens and this view unmounts
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
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
        <h2 className="text-lg font-semibold">New project</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Create one by name, or import an existing folder.
        </p>
        <div className="mt-4 flex gap-2">
          <input
            autoFocus
            className="flex-1 rounded-lg bg-zinc-50 border border-zinc-300 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
            placeholder="New project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) void run(() => createProject(name.trim()));
            }}
          />
          <button
            className="rounded-lg px-3 py-1.5 text-sm bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50"
            disabled={!name.trim() || busy}
            onClick={() => void run(() => createProject(name.trim()))}
          >
            Create
          </button>
        </div>
        <div className="mt-2 flex gap-2">
          <input
            className="flex-1 rounded-lg bg-zinc-50 border border-zinc-300 px-2 py-1.5 text-sm font-mono outline-none focus:border-zinc-500"
            placeholder="Import folder (e.g. ~/Documents/personal/my-repo)"
            value={importPath}
            onChange={(e) => setImportPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && importPath.trim())
                void run(() => importProject(importPath.trim()));
            }}
          />
          <button
            className="rounded-lg px-3 py-1.5 text-sm bg-zinc-200 hover:bg-zinc-300 disabled:opacity-50"
            disabled={!importPath.trim() || busy}
            onClick={() => void run(() => importProject(importPath.trim()))}
          >
            Import
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}

export default function ProjectPicker() {
  const [nodes, setNodes] = useState<ProjectNodeType[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showModal, setShowModal] = useState(false);

  const handleDelete = useCallback(async (id: string, name: string) => {
    if (
      !confirm(
        `Remove “${name}”? Only its .autojira data is deleted — the folder and your files stay.`
      )
    )
      return;
    await deleteProject(id);
    setNodes((nds) => nds.filter((n) => n.id !== id));
  }, []);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/projects");
    if (!res.ok) return;
    const rows: {
      id: string;
      name: string;
      metaPosition?: { x: number; y: number };
    }[] = (await res.json()).projects;
    setNodes(
      rows.map((r, i) => ({
        id: r.id,
        type: "project" as const,
        position: r.metaPosition ?? { x: (i % 3) * 300, y: Math.floor(i / 3) * 140 },
        data: { name: r.name, onDelete: () => void handleDelete(r.id, r.name) },
      }))
    );
    setLoaded(true);
  }, [handleDelete]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onNodesChange = useCallback(
    (changes: NodeChange<ProjectNodeType>[]) =>
      setNodes((nds) => applyNodeChanges(changes, nds)),
    []
  );

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="h-12 shrink-0 flex items-center px-4 bg-white border-b border-zinc-200">
        <span className="font-semibold">Projects</span>
        <button
          className="ml-auto rounded-lg px-3 py-1.5 text-sm bg-violet-600 hover:bg-violet-500 text-white"
          onClick={() => setShowModal(true)}
        >
          + Project
        </button>
      </header>
      <div className="relative flex-1 min-h-0">
        {loaded ? (
          <ReactFlow
            nodes={nodes}
            nodeTypes={nodeTypes}
            colorMode="light"
            fitView
            fitViewOptions={{ maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
            nodesConnectable={false}
            deleteKeyCode={null}
            zoomOnDoubleClick={false}
            onNodesChange={onNodesChange}
            onNodeDragStop={(_, node) => void saveMetaPosition(node.id, node.position)}
            onNodeDoubleClick={(_, node) => void openProject(node.id)}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} color="#d4d4d8" />
            <Controls />
          </ReactFlow>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500">
            Loading…
          </div>
        )}
        {loaded && nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-zinc-500">
            No projects yet — click “+ Project” to create or import one
          </div>
        )}
      </div>
      {showModal && <ProjectModal onClose={() => setShowModal(false)} />}
    </div>
  );
}
