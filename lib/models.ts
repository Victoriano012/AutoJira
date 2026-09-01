export type ModelProvider = "claude" | "codex";

export interface ModelChoice {
  value: string;
  label: string;
  provider: ModelProvider;
}

/** Model used when the user hasn't picked one. Shared by the server-side config
 * reader and the client-side Settings modal, so both agree on the default. */
export const DEFAULT_MODEL = "claude-fable-5-1";

/** Models exposed by the two locally authenticated coding-agent CLIs. */
export const MODEL_CHOICES: readonly ModelChoice[] = [
  { value: DEFAULT_MODEL, label: "Fable 5.1 (default)", provider: "claude" },
  { value: "claude-opus-5", label: "Opus 5", provider: "claude" },
  { value: "claude-sonnet-5", label: "Sonnet 5", provider: "claude" },
  {
    value: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    provider: "claude",
  },
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", provider: "codex" },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", provider: "codex" },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "codex" },
] as const;

/** Claude model IDs are the only special case. Other configured model IDs are
 * intentionally sent through Codex so a user can add a newer Codex model to
 * ~/.autoproject/config.json before this list catches up. */
export function providerForModel(model: string): ModelProvider {
  return model.startsWith("claude-") ? "claude" : "codex";
}
