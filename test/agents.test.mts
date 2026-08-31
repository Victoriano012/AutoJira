import assert from "node:assert/strict";
import test from "node:test";
import {
  resumableSession,
  sessionProvider,
  tagSession,
} from "../lib/agent-session.ts";
import { MODEL_CHOICES, providerForModel } from "../lib/models.ts";
import { codexArgs } from "../lib/server/codex.ts";

test("settings expose only the requested Codex model family", () => {
  assert.deepEqual(
    MODEL_CHOICES.filter((model) => model.provider === "codex").map(
      (model) => model.value
    ),
    ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]
  );
  assert.equal(providerForModel("gpt-5.6-sol"), "codex");
  assert.equal(providerForModel("claude-sonnet-5"), "claude");
});

test("legacy sessions remain Claude sessions and providers never cross-resume", () => {
  assert.equal(sessionProvider("old-claude-id"), "claude");
  assert.deepEqual(resumableSession("old-claude-id", "claude-opus-5"), {
    stored: "old-claude-id",
    raw: "old-claude-id",
  });
  assert.equal(resumableSession("old-claude-id", "gpt-5.6-sol"), undefined);

  const codex = tagSession("codex", "thread-123");
  assert.equal(codex, "codex:thread-123");
  assert.equal(resumableSession(codex, "claude-opus-5"), undefined);
  assert.deepEqual(resumableSession(codex, "gpt-5.6-terra"), {
    stored: codex,
    raw: "thread-123",
  });
});

test("new Codex work runs through the CLI with the selected model and workspace", () => {
  const args = codexArgs({
    model: "gpt-5.6-sol",
    workspaceDir: "/tmp/autojira-test-workspace",
    writeAccess: true,
  });
  assert.deepEqual(args, [
    "exec",
    "--json",
    "--model",
    "gpt-5.6-sol",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--cd",
    "/tmp/autojira-test-workspace",
    "-",
  ]);
});

test("Codex planner resumes keep their thread and structured-output schema", () => {
  const args = codexArgs(
    {
      model: "gpt-5.6-luna",
      sessionId: "codex:thread-456",
      workspaceDir: "/tmp/autojira-test-workspace",
      writeAccess: false,
    },
    "/tmp/schema.json"
  );
  assert.deepEqual(args, [
    "exec",
    "resume",
    "thread-456",
    "--json",
    "--model",
    "gpt-5.6-luna",
    "--skip-git-repo-check",
    "--output-schema",
    "/tmp/schema.json",
    "-",
  ]);
});
