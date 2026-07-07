import type { ExportFormat, ExportResult } from "@open-design/contracts";

export interface ExportCliRequestOptions {
  fileName: string;
  title?: string;
}

export function buildExportCliRequestBody(options: ExportCliRequestOptions): Record<string, unknown> {
  return {
    fileName: options.fileName,
    ...(options.title ? { title: options.title } : {}),
  };
}

export function buildExportCliResultEnvelope(options: {
  bytes?: number;
  format: ExportFormat;
  path: string;
}): ExportResult {
  return {
    ok: true,
    path: options.path,
    out: options.path,
    ...(options.bytes !== undefined ? { bytes: options.bytes } : {}),
    format: options.format,
  };
}
