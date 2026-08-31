"use client";

import { useState, useSyncExternalStore } from "react";
import { autoLayout } from "@/lib/layout";
import {
  abortPopulate,
  clearPopulateResult,
  isPopulating,
  populateState,
  subscribePopulate,
} from "@/lib/populate-job";
import { isGraphRunning, runGraph, stopGraph, subscribeRuns } from "@/lib/runner";
import { useStore } from "@/lib/store";
import {
  dependenciesOf,
  graphAtPath,
  isTicketDone,
  isTicketWaiting,
  newTicket,
  satisfiesDependents,
} from "@/lib/types";
import ArrowLeftIcon from "./ArrowLeftIcon";
import GearIcon from "./GearIcon";
import HomeIcon from "./HomeIcon";
import { LayoutIcon, PlayIcon, PlusIcon, Spinner, StopIcon } from "./icons";
import Logo from "./Logo";
import PopulateModal from "./PopulateModal";
import { ackKey, ackTickets, useRunAck } from "./useRunAck";
import SettingsModal from "./SettingsModal";

export default function Toolbar() {
  const project = useStore((s) => s.project);
  const closeProject = useStore((s) => s.closeProject);
  const path = useStore((s) => s.path);
  const setProject = useStore((s) => s.setProject);
  const setPath = useStore((s) => s.setPath);
  const select = useStore((s) => s.select);
  const addTicket = useStore((s) => s.addTicket);
  const chatOpen = useStore((s) => s.chatOpen);
  const toggleChat = useStore((s) => s.toggleChat);
  const updateTicket = useStore((s) => s.updateTicket);

  const [showPopulate, setShowPopulate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // Pushed by the runner the moment a level starts or settles — a poll would
  // both lag and keep saying "running" for a run parked on a human gate.
  const runsHere = useSyncExternalStore(
    subscribeRuns,
    () => isGraphRunning(path),
    () => false
  );
  // Populating happens in the background now, so this row — not the modal —
  // is what shows it, and the modal comes back here when the result needs the
  // person (a confirmation, or an error).
  const populate = useSyncExternalStore(
    subscribePopulate,
    populateState,
    populateState
  );
  const populatingHere = isPopulating(path);

  // A run that parks on a human gate settles before the click is over, so the
  // button would never appear to react; hold the running look for a moment.
  const [acking, ack] = useRunAck();
  const running = runsHere || acking;

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

  // Where ← takes you: one layer up, or the meta-graph only from the root.
  const backLabel =
    path.length === 0
      ? "Projects"
      : path.length === 1
        ? project.name
        : (crumbs[path.length - 2]?.title ?? project.name);
  const goBack = () =>
    path.length === 0 ? closeProject() : setPath(path.slice(0, -1));

  const doneCount = graph?.tickets.filter(isTicketDone).length ?? 0;
  const total = graph?.tickets.length ?? 0;

  // Tickets this run can only park on again: they are already waiting on a
  // human, so nothing they render from will change and they need the beat of
  // Running feedback themselves.
  const waitingKeys = () =>
    (graph?.tickets ?? [])
      .filter((t) =>
        isTicketWaiting(t, dependenciesOf(graph!, t.id).every(satisfiesDependents))
      )
      .map((t) => ackKey(path, t.id));

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
      <Logo size={20} className="shrink-0 text-zinc-900" />
      <button
        className="shrink-0 text-zinc-500 hover:text-zinc-900"
        onClick={closeProject}
        title="All projects"
      >
        <HomeIcon />
      </button>
      <button
        className="shrink-0 text-zinc-500 hover:text-zinc-900"
        onClick={goBack}
        title={path.length === 0 ? "Back to your projects" : `Back to ${backLabel}`}
      >
        <ArrowLeftIcon />
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
          className="rounded-lg px-2 py-1.5 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900"
          onClick={handleAutoLayout}
          title="Auto-layout"
        >
          <LayoutIcon />
        </button>
        <button
          className="rounded-lg px-2 py-1.5 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900"
          onClick={handleAddTicket}
          title="New ticket"
        >
          <PlusIcon />
        </button>
        <button
          className="rounded-lg px-2 py-1.5 text-xl leading-none hover:bg-zinc-200 disabled:opacity-50"
          onClick={() => setShowPopulate(true)}
          disabled={isPopulating()}
          title={isPopulating() ? "Already populating with AI" : "Populate with AI"}
        >
          ✨
        </button>
        {running || populatingHere ? (
          // Same slot, violet when it is a populate rather than a run — the
          // two are told apart by colour, not by position.
          <button
            className={`rounded-lg px-2 py-1.5 hover:bg-zinc-200 ${
              running
                ? "text-red-600 hover:text-red-500"
                : "text-violet-600 hover:text-violet-500"
            }`}
            onClick={() => (running ? stopGraph(path) : abortPopulate())}
            title={running ? "Stop the run" : "Stop populating with AI"}
          >
            <StopIcon />
          </button>
        ) : (
          <button
            className="rounded-lg px-2 py-1.5 text-emerald-600 hover:bg-zinc-200 hover:text-emerald-500 disabled:opacity-50"
            onClick={() => {
              ack();
              ackTickets(waitingKeys());
              void runGraph(path);
            }}
            disabled={total === 0}
            title="Run graph"
          >
            <PlayIcon />
          </button>
        )}
        {/* Slot kept at icon size whether or not it holds the spinner, so the
            row doesn't shift when a run starts. */}
        <span
          className="h-5 w-5"
          title={
            running
              ? "Run in progress"
              : populatingHere
                ? "Populating with AI"
                : undefined
          }
        >
          {running ? (
            <Spinner className="h-5 w-5" />
          ) : (
            populatingHere && <Spinner className="h-5 w-5" color="border-violet-500" />
          )}
        </span>
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
        <button
          className={`rounded-lg px-2 py-1.5 text-xl leading-none ${
            chatOpen
              ? "bg-zinc-200 text-sky-600"
              : "text-sky-500 hover:bg-zinc-200 hover:text-sky-600"
          }`}
          onClick={toggleChat}
          title="Chat"
        >
          ✦
        </button>
        <button
          className="rounded-lg px-2 py-1.5 text-zinc-600 hover:bg-zinc-200 hover:text-zinc-900"
          onClick={() => setShowSettings(true)}
          title="Settings"
        >
          <GearIcon />
        </button>
      </div>

      {(showPopulate || populate.result) && (
        <PopulateModal
          result={populate.result}
          onClose={() => {
            setShowPopulate(false);
            clearPopulateResult();
          }}
        />
      )}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </header>
  );
}
