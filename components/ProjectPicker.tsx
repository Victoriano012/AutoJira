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
import ConfirmDialog from "./ConfirmDialog";
import TrashIcon from "./TrashIcon";

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
        title="Remove project (hide from this view, or erase from the computer)"
        onClick={(e) => {
          e.stopPropagation();
          data.onDelete();
        }}
      >
        <TrashIcon />
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
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function browse() {
    if (picking) return;
    setPicking(true);
    try {
      const res = await fetch("/api/pick-folder", { method: "POST" });
      const data = await res.json();
      if (data.path) setImportPath(data.path);
    } finally {
      setPicking(false);
    }
  }

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
            disabled={picking}
            title="Pick a folder with Finder"
            onClick={() => void browse()}
          >
            {picking ? "Choosing…" : "Browse…"}
          </button>
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

function DeleteModal({
  id,
  name,
  onClose,
  onDone,
}: {
  id: string;
  name: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmErase, setConfirmErase] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !confirmErase) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, confirmErase]);

  async function del(mode: "hide" | "erase") {
    if (busy) return;
    setBusy(true);
    await deleteProject(id, mode);
    onDone();
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
        <h2 className="text-lg font-semibold">Remove “{name}”?</h2>
        <div className="mt-4 flex items-center gap-2">
          <button
            className="mr-auto rounded-lg px-3 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="rounded-lg px-3 py-1.5 text-sm border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50"
            disabled={busy}
            onClick={() => setConfirmErase(true)}
          >
            Delete from computer
          </button>
          <button
            autoFocus
            className="rounded-lg px-3 py-1.5 text-sm bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50"
            disabled={busy}
            onClick={() => void del("hide")}
          >
            Delete
          </button>
        </div>
      </div>
      {confirmErase && (
        <ConfirmDialog
          title="Erase from computer?"
          message={`The folder\n${id}\nand everything inside it will be permanently deleted. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => void del("erase")}
          onCancel={() => setConfirmErase(false)}
        />
      )}
    </div>
  );
}

export default function ProjectPicker() {
  const [nodes, setNodes] = useState<ProjectNodeType[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(
    null
  );

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
        data: { name: r.name, onDelete: () => setPendingDelete({ id: r.id, name: r.name }) },
      }))
    );
    setLoaded(true);
  }, []);

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
      <header className="h-20 shrink-0 flex items-center gap-3 px-4 bg-white border-b border-zinc-200">
        <span className="text-3xl font-semibold">Projects</span>
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
      {pendingDelete && (
        <DeleteModal
          id={pendingDelete.id}
          name={pendingDelete.name}
          onClose={() => setPendingDelete(null)}
          onDone={() => {
            setNodes((nds) => nds.filter((n) => n.id !== pendingDelete.id));
            setPendingDelete(null);
          }}
        />
      )}
    </div>
  );
}
