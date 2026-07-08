// Directory names that should not be listed or watched for folder-backed
// projects. These are generated, installed, or cache trees that add file
// descriptor pressure without adding useful design context.
export const IGNORED_PROJECT_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'vendor',
  '.od',
  // Internal live-artifact storage: watching it holds directory handles that
  // race the atomic rename in live-artifacts/store.ts on Windows (EPERM).
  '.live-artifacts',
  'debug',
  'dist',
  'build',
  '.build',
  'deriveddata',
  'target',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.output',
  'out',
  'coverage',
  '.gradle',
  '.swiftpm',
  '.tmp',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.tox',
  '.ruff_cache',
].map((name) => name.toLowerCase()));

export function isIgnoredProjectDirName(name: unknown): boolean {
  const normalized = String(name).toLowerCase();
  return (
    IGNORED_PROJECT_DIR_NAMES.has(normalized) ||
    normalized.startsWith('deriveddata-')
  );
}
