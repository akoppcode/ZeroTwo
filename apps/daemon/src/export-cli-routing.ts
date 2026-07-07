// Pure routing helper for the `od export` CLI, extracted so it can be unit
// tested without executing the CLI entrypoint (cli.ts runs argv dispatch on
// import). The only programmatic export route is the desktop vector PDF
// exporter at `/export/pdf` — NOT the generic `/export` route.
export function exportRoutePath(format: string): string {
  if (format !== 'pdf') {
    throw new Error(`unsupported export format: ${format}`);
  }
  return 'export/pdf';
}
