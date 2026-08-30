"use client";

import { Attachment } from "@/lib/types";

const MAX_SIZE = 3 * 1024 * 1024; // stored in localStorage — keep files small

function fileToAttachment(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () =>
      resolve({
        id: crypto.randomUUID(),
        name: file.name,
        mediaType: file.type || "application/octet-stream",
        dataUrl: r.result as string,
      });
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export default function AttachmentEditor({
  attachments,
  onChange,
  label = "Context files",
}: {
  attachments: Attachment[];
  onChange: (attachments: Attachment[]) => void;
  label?: string;
}) {
  async function add(list: FileList | null) {
    if (!list) return;
    const next = [...attachments];
    for (const f of Array.from(list)) {
      if (f.size > MAX_SIZE) {
        alert(`"${f.name}" is over 3 MB — attachments are stored in the browser, keep them small.`);
        continue;
      }
      next.push(await fileToAttachment(f));
    }
    onChange(next);
  }

  return (
    <div className="text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="text-zinc-500">{label}</span>
        <label className="cursor-pointer rounded bg-zinc-200 hover:bg-zinc-300 px-2 py-0.5 text-zinc-700">
          + Add file
          <input
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              void add(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      {attachments.map((a) => (
        <div key={a.id} className="mt-1 flex items-center gap-2">
          <span className="min-w-0 truncate text-zinc-700">📎 {a.name}</span>
          <button
            className="shrink-0 text-zinc-400 hover:text-red-500"
            title="Remove"
            onClick={() => onChange(attachments.filter((x) => x.id !== a.id))}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
