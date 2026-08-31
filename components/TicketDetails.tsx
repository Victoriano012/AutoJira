"use client";

import { approveTicket, runTicket, stopTicket } from "@/lib/runner";
import { useStore } from "@/lib/store";
import {
  dependenciesOf,
  dependentsOf,
  graphAtPath,
  isTicketDone,
  isTicketRunning,
  Ticket,
  TicketStatus,
} from "@/lib/types";
import AttachmentEditor from "./AttachmentEditor";
import { PlayIcon, StopIcon } from "./icons";
import { useRunAck } from "./useRunAck";

const statusColor: Record<TicketStatus, string> = {
  todo: "bg-zinc-500",
  running: "bg-blue-400 animate-pulse",
  review: "bg-amber-400",
  done: "bg-emerald-400",
  error: "bg-red-400",
};

/** Header row of the ticket detail view: state dot, editable title, run/stop.
 * `children` adds panel-specific buttons after them. `path` is the graph that
 * contains the ticket. */
export function TicketDetailsHeader({
  ticket,
  path,
  children,
}: {
  ticket: Ticket;
  path: string[];
  children?: React.ReactNode;
}) {
  const updateTicket = useStore((s) => s.updateTicket);
  const runLabel = ticket.subgraph.tickets.length > 0 ? "Run subgraph" : "Run";
  // Brief acknowledgement of a run click, for tickets that settle back to
  // waiting immediately and would otherwise look unresponsive.
  const [acking, ack] = useRunAck();

  return (
    <>
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${statusColor[ticket.status]}`} />
      <input
        className="flex-1 min-w-0 bg-transparent font-medium outline-none rounded px-1 focus:bg-zinc-100"
        value={ticket.title}
        onChange={(e) =>
          updateTicket(path, ticket.id, (t) => ({ ...t, title: e.target.value }))
        }
      />
      {/* Stop belongs to the running state only: a parent still marked
          "running" with nothing working inside is waiting, so it gets play. */}
      {isTicketRunning(ticket) || acking ? (
        <button
          className="shrink-0 text-red-600 hover:text-red-500"
          title="Stop"
          onClick={() => stopTicket(path, ticket.id)}
        >
          <StopIcon size={16} />
        </button>
      ) : (
        <button
          className="shrink-0 text-emerald-600 hover:text-emerald-500"
          title={runLabel}
          onClick={() => {
            ack();
            void runTicket(path, ticket.id);
          }}
        >
          <PlayIcon size={16} />
        </button>
      )}
      {children}
    </>
  );
}

/** Body of the ticket detail view — type, status, description, context files,
 * dependencies. `path` is the graph that contains the ticket (dependencies are
 * edges of that graph). Caller supplies the scrolling wrapper. */
export default function TicketDetails({
  ticket,
  path,
}: {
  ticket: Ticket;
  path: string[];
}) {
  const project = useStore((s) => s.project);
  const updateTicket = useStore((s) => s.updateTicket);

  const graph = graphAtPath(project.graph, path);
  if (!graph) return null;

  const deps = dependenciesOf(graph, ticket.id);
  const dependents = dependentsOf(graph, ticket.id);

  return (
    <>
      <div className="flex items-center gap-2 text-sm">
        <select
          className="rounded-lg bg-white border border-zinc-300 px-2 py-1 text-sm outline-none"
          value={ticket.type}
          onChange={(e) =>
            updateTicket(path, ticket.id, (t) => ({
              ...t,
              type: e.target.value as typeof t.type,
            }))
          }
        >
          <option value="ai">🤖 AI</option>
          <option value="human_review">👤 Human review</option>
          <option value="subgraph">🧩 Subgraph</option>
        </select>
        {/* No status label — the node border + dot already show the state. */}
        <span className="ml-auto flex gap-1">
          {ticket.status !== "done" ? (
            <button
              className="rounded-full border border-emerald-600 px-2.5 py-1 text-xs text-emerald-700 hover:bg-emerald-600 hover:text-white"
              // Not a plain status write: a run parked on this human gate
              // resumes only through approveTicket.
              onClick={() => approveTicket(path, ticket.id)}
            >
              ✓ Mark done
            </button>
          ) : (
            <button
              className="cursor-pointer inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-white hover:border-violet-400 hover:text-violet-600 px-2.5 py-1 font-medium text-zinc-600 shadow-sm transition-colors"
              onClick={() =>
                updateTicket(path, ticket.id, (t) => ({ ...t, status: "todo" }))
              }
            >
              Reopen
            </button>
          )}
        </span>
      </div>

      {ticket.type === "human_review" && (
        <label className="flex items-start gap-2 text-xs text-zinc-600 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 accent-amber-500"
            checked={ticket.blocking !== false}
            onChange={(e) =>
              updateTicket(path, ticket.id, (t) => ({
                ...t,
                blocking: e.target.checked,
              }))
            }
          />
          <span>
            Blocks dependents until approved
            <span className="block text-zinc-400">
              Unchecked: dependents start right after the AI finishes, on a new
              git branch, while you review this one.
            </span>
          </span>
        </label>
      )}

      <textarea
        className="w-full min-h-28 rounded-lg bg-white border border-zinc-300 p-2 text-sm outline-none focus:border-zinc-500"
        placeholder="Describe what this ticket should accomplish…"
        value={ticket.description}
        onChange={(e) =>
          updateTicket(path, ticket.id, (t) => ({
            ...t,
            description: e.target.value,
          }))
        }
      />

      <AttachmentEditor
        label="Context files"
        attachments={ticket.attachments ?? []}
        onChange={(attachments) =>
          updateTicket(path, ticket.id, (t) => ({ ...t, attachments }))
        }
      />

      {deps.length > 0 && (
        <div className="text-xs text-zinc-600">
          <span className="text-sm font-medium text-zinc-700">Depends on</span>
          {deps.map((d) => (
            <div key={d.id} className="ml-1">
              {isTicketDone(d) ? "✓" : "○"} {d.title}
            </div>
          ))}
        </div>
      )}

      {dependents.length > 0 && (
        <div className="text-xs text-zinc-600">
          <span className="text-sm font-medium text-zinc-700">Required by</span>
          {dependents.map((d) => (
            <div key={d.id} className="ml-1">
              {isTicketDone(d) ? "✓" : "○"} {d.title}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** The project-root equivalent of TicketDetails — a project is just the
 * outermost "ticket", but it carries its own fields. */
export function ProjectDetails() {
  const description = useStore((s) => s.project.description);
  const workspaceDir = useStore((s) => s.project.workspaceDir);
  const attachments = useStore((s) => s.project.attachments);
  const setProject = useStore((s) => s.setProject);

  return (
    <>
      <textarea
        className="w-full min-h-28 rounded-lg bg-white border border-zinc-300 p-2 text-sm outline-none focus:border-zinc-500"
        placeholder="Describe what this project should accomplish…"
        value={description}
        onChange={(e) => setProject({ description: e.target.value })}
      />

      <label className="block">
        <span className="text-sm font-medium text-zinc-700">
          Workspace directory
        </span>
        <input
          className="mt-1 w-full rounded-lg bg-white border border-zinc-300 px-2 py-1.5 text-sm font-mono outline-none focus:border-zinc-500"
          placeholder="Server path where the agents work (empty = temp)"
          value={workspaceDir}
          onChange={(e) => setProject({ workspaceDir: e.target.value })}
          title="Directory on the server where the agents work"
        />
      </label>

      <AttachmentEditor
        label="Context files"
        attachments={attachments ?? []}
        onChange={(next) => setProject({ attachments: next })}
      />
    </>
  );
}
