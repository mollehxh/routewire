import { spawnSync, type ChildProcess } from "node:child_process";

export function terminateProcessTree(child: ChildProcess): void {
  signalProcessTree(child, false);
}

export function forceTerminateProcessTree(child: ChildProcess): void {
  signalProcessTree(child, true);
}

function signalProcessTree(child: ChildProcess, force: boolean): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (result.status === 0) return;
  } else {
    try {
      process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
      return;
    } catch {
      // Fall through to terminating only the direct child.
    }
  }

  try {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    // The process may have exited between the status check and kill.
  }
}

export function shouldCreateProcessGroup(): boolean {
  return process.platform !== "win32";
}
