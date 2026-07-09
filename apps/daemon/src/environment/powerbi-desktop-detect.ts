import { spawn } from "node:child_process";

/**
 * Detect the installed Power BI Desktop version on Windows (spec §3.1). Reads,
 * in order:
 *   1. The Store/MSIX install (registry Uninstall keys with DisplayName
 *      "Microsoft Power BI Desktop"), whose DisplayVersion is the app version.
 *   2. The per-machine / per-user Download-Center install version.
 * Returns a dotted version string (e.g. "2.155.756.0") or null if not found /
 * not on Windows.
 *
 * The registry read is done via `reg query` (no native module) so it works from
 * the packaged daemon without extra build steps. All failures resolve to null —
 * the Doctor treats null as "not installed" and surfaces install guidance.
 */

const UNINSTALL_ROOTS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];

function runReg(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn("reg", args, { windowsHide: true });
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? stdout : null));
  });
}

function firstVersionFrom(text: string): string | null {
  const match = text.match(/\b(\d+\.\d+\.\d+(?:\.\d+)?)\b/);
  return match?.[1] ?? null;
}

/** Find a Power BI Desktop uninstall subkey and read its DisplayVersion. */
async function versionFromUninstallKeys(): Promise<string | null> {
  for (const root of UNINSTALL_ROOTS) {
    // Find subkeys whose DisplayName is Power BI Desktop.
    const listing = await runReg(["query", root, "/s", "/f", "Power BI Desktop", "/d"]);
    if (!listing) continue;
    // The listing includes the matching key paths; query each for DisplayVersion.
    const keyPaths = listing
      .split(/\r?\n/)
      .filter((line) => line.startsWith("HK") && line.includes("Uninstall"))
      .map((line) => line.trim());
    for (const keyPath of keyPaths) {
      const value = await runReg(["query", keyPath, "/v", "DisplayVersion"]);
      const version = value ? firstVersionFrom(value) : null;
      if (version) return version;
    }
  }
  return null;
}

export async function detectPowerBiDesktopVersion(
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (platform !== "win32") return null;
  try {
    return await versionFromUninstallKeys();
  } catch {
    return null;
  }
}

/**
 * Detect a Microsoft Store (MSIX) install of Power BI Desktop. The Store build
 * lives under ACL-protected `C:\Program Files\WindowsApps\...` at a versioned
 * path, which the Desktop Bridge CLI cannot launch — it looks for the Download
 * Center (MSI) `PBIDesktop.exe`. So a Store-only install must be flagged
 * distinctly from "not installed". Uses `Get-AppxPackage` (no native module);
 * returns the Store package version, or null.
 */
export function detectPowerBiDesktopStoreVersion(
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "(Get-AppxPackage -Name Microsoft.MicrosoftPowerBIDesktop).Version",
      ],
      { windowsHide: true },
    );
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(firstVersionFrom(stdout)));
  });
}
