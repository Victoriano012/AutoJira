"use client";

import { useEffect, useState } from "react";
import {
  applyPopulated,
  PopulateResult,
  startPopulate,
} from "@/lib/populate-job";
import { useStore } from "@/lib/store";
import { contextChain, ticketAtPath, TicketGraph } from "@/lib/types";
import AttachmentEditor, { addFiles } from "./AttachmentEditor";
import ConfirmDialog from "./ConfirmDialog";

/** `result` reopens the modal on a populate that landed after it closed: the
 * job's own path and description, plus whatever still needs the person. */
export default function PopulateModal({
  onClose,
  result,
}: {
  onClose: () => void;
  result?: PopulateResult | null;
}) {
  const project = useStore((s) => s.project);
  const currentPath = useStore((s) => s.path);
  const setProject = useStore((s) => s.setProject);
  const updateTicket = useStore((s) => s.updateTicket);

  // A reopened modal belongs to the graph its job was fired for, which may no
  // longer be the one on screen.
  const path = result?.path ?? currentPath;
  const atRoot = path.length === 0;
  const currentTicket = atRoot
    ? null
    : ticketAtPath(project.graph, path.slice(0, -1), path[path.length - 1]);

  const [description, setDescription] = useState(
    result?.description ?? (atRoot ? project.description : currentTicket?.description ?? "")
  );
  const [error, setError] = useState<string | null>(result?.error ?? null);
  const [dragging, setDragging] = useState(false);
  const [pendingGraph, setPendingGraph] = useState<TicketGraph | null>(
    result?.graph ?? null
  );

  const attachments =
    (atRoot ? project.attachments : currentTicket?.attachments) ?? [];

  function setAttachments(attachments: typeof project.attachments) {
    if (atRoot) setProject({ attachments });
    else if (currentTicket)
      updateTicket(path.slice(0, -1), currentTicket.id, (t) => ({
        ...t,
        attachments,
      }));
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pendingGraph) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, pendingGraph]);

  // Fire and forget: the job runs in the background from here on, and the
  // toolbar is what shows it (see lib/populate-job.ts).
  function submit() {
    if (!description.trim()) return;
    setError(null);
    void startPopulate(path, {
      description,
      // inherited context: project + ancestors, minus the level being
      // described in the textarea itself
      chain: contextChain(project, path)
        .slice(0, -1)
        .map(({ title, description }) => ({ title, description })),
      attachments: contextChain(project, path)
        .flatMap((l) => l.attachments)
        .map(({ name, dataUrl }) => ({ name, dataUrl })),
    });
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white border border-zinc-200 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">✨ Populate with AI</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Describe the {atRoot ? "project" : `work for “${currentTicket?.title}”`};
          the AI will break it into a graph of tickets with dependencies.
        </p>
        <textarea
          className={`mt-4 w-full min-h-40 rounded-lg bg-zinc-50 border p-3 text-sm outline-none focus:border-zinc-500 ${
            dragging ? "border-violet-500 border-dashed bg-violet-50" : "border-zinc-300"
          }`}
          placeholder="What should be built? (drop files here to attach them as context)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void addFiles(attachments, e.dataTransfer.files).then(setAttachments);
          }}
          autoFocus
        />
        <div className="mt-3">
          <AttachmentEditor
            label={`Context files for the ${atRoot ? "project" : "ticket"}`}
            attachments={attachments}
            onChange={setAttachments}
          />
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="rounded-lg px-3 py-1.5 text-sm bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50"
            onClick={submit}
            disabled={!description.trim()}
          >
            Generate tickets
          </button>
          <button
            className="rounded-lg px-3 py-1.5 text-sm bg-zinc-200 hover:bg-zinc-300"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
      {pendingGraph && (
        <ConfirmDialog
          title="Replace current tickets?"
          message="This graph already has tickets — they will all be replaced by the newly generated ones."
          confirmLabel="Replace"
          danger
          onConfirm={() => {
            applyPopulated(path, description, pendingGraph);
            onClose();
          }}
          onCancel={() => setPendingGraph(null)}
        />
      )}
    </div>
  );
}
