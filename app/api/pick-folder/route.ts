import { execFile } from "child_process";

/** Opens a native Finder folder picker on the machine running the server
 * (local-only app) and returns the chosen POSIX path. */
export async function POST() {
  return new Promise<Response>((resolve) => {
    execFile(
      "osascript",
      [
        "-e",
        'tell application "System Events" to activate', // bring dialog in front of the browser
        "-e",
        'POSIX path of (choose folder with prompt "Choose a project folder")',
      ],
      { timeout: 120_000 },
      (err, stdout) => {
        // osascript exits non-zero when the user cancels — not an error
        if (err || !stdout.trim()) resolve(Response.json({ canceled: true }));
        else resolve(Response.json({ path: stdout.trim() }));
      }
    );
  });
}
