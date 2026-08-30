"use client";

import { useEffect } from "react";

/** Small in-app replacement for window.confirm: named action button
 * (never "OK"), Cancel, Esc to dismiss, Enter to confirm. */
export default function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-zinc-900/30"
      onClick={(e) => {
        e.stopPropagation(); // may be nested in another modal's overlay
        onCancel();
      }}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-1 whitespace-pre-wrap break-all text-sm text-zinc-600">
          {message}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            autoFocus
            className={`rounded-lg px-3 py-1.5 text-sm text-white ${
              danger
                ? "bg-red-600 hover:bg-red-500"
                : "bg-violet-600 hover:bg-violet-500"
            }`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
          <button
            className="rounded-lg px-3 py-1.5 text-sm bg-zinc-200 hover:bg-zinc-300"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
