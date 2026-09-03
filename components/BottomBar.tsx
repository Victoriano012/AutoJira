"use client";

import { useState, useSyncExternalStore } from "react";
import { agentBusy, sendToAgent, stopAgent, subscribeRuns } from "@/lib/runner";
import { useStore } from "@/lib/store";
import ChatInput from "./ChatInput";
import { StopSquare } from "./icons";
import RequestStack from "./RequestStack";

/** Unsent text, per project, kept outside React so a remount can't eat it.
 * sessionStorage: it belongs to this tab, and nothing here needs a server. */
const DRAFT_KEY = "autoproject-board-draft:";
function readDraft(key: string) {
  try {
    return sessionStorage.getItem(DRAFT_KEY + key) ?? "";
  } catch {
    return "";
  }
}
function writeDraft(key: string, value: string) {
  try {
    if (value) sessionStorage.setItem(DRAFT_KEY + key, value);
    else sessionStorage.removeItem(DRAFT_KEY + key);
  } catch {
    // Private mode or a blocked store: the draft just isn't durable.
  }
}

/** The one input bar under the view, talking to the project agent in whichever
 * mode is showing: on the board it plans tickets, over the chat it does the
 * work. It sits outside the sliding sheet, so switching modes leaves it put. */
export default function BottomBar() {
  const projectId = useStore((s) => s.projectId) ?? "";
  const mode = useStore((s) => s.mode);
  const busy = useSyncExternalStore(subscribeRuns, agentBusy, () => false);

  // The draft outlives the input: a remount — a reload, a dev-server refresh —
  // brings back what was typed.
  const [draft, setDraftState] = useState(() => readDraft(projectId));
  const setDraft = (v: string) => {
    setDraftState(v);
    writeDraft(projectId, v);
  };

  // On the board a message queues behind the one being worked on — the stack
  // above the bar shows where it stands — so the bar never closes there. Over
  // the chat there is no stack, so it waits for the turn instead.
  const closed = busy && mode === "act";

  async function send() {
    const text = draft.trim();
    if (!text || closed) return;
    setDraft("");
    // Never reached the server: the words are still the person's to send again.
    if (!(await sendToAgent(mode, text))) setDraft(text);
  }

  /** Words handed back by a dropped request go into the box, after any typing. */
  const takeBack = (text: string) =>
    setDraft(draft.trim() ? `${draft.trim()} ${text}` : text);

  return (
    <div className="shrink-0" style={{ margin: "0 5px 5px" }}>
      {/* The chat sheet has its own transcript; the stack is the board's. */}
      {mode === "panel" && <RequestStack onDropped={takeBack} />}
      <div className="flex items-center gap-2">
        <ChatInput
          value={draft}
          onChange={setDraft}
          onSend={send}
          disabled={closed}
          placeholder={
            mode === "act"
              ? "What should be done?"
              : "What should be changed? AI will turn it into tickets and get to work"
          }
          sendTitle={mode === "act" ? "Send" : "Send — AI will turn it into tickets"}
        />
        {/* Stopping a board request is its row's ✕; the bar's square is the chat's. */}
        {closed && <StopSquare onClick={stopAgent} title="Stop the agent" />}
      </div>
    </div>
  );
}
