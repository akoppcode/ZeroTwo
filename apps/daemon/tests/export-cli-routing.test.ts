import { describe, expect, it } from 'vitest';

import {
  buildExportCliResultEnvelope,
  buildExportCliRequestBody,
} from '../src/export-cli-request.js';
import { exportRoutePath } from '../src/export-cli-routing.js';

describe('exportRoutePath', () => {
  it('routes pdf to the desktop vector /export/pdf path, not the generic /export route', () => {
    expect(exportRoutePath('pdf')).toBe('export/pdf');
    expect(exportRoutePath('pdf')).not.toBe('export');
  });

  it('rejects unsupported formats', () => {
    expect(() => exportRoutePath('pptx')).toThrow(/unsupported export format/);
    expect(() => exportRoutePath('image')).toThrow(/unsupported export format/);
  });
});

describe('buildExportCliResultEnvelope', () => {
  it('emits path plus the deprecated out alias for JSON output', () => {
    const result = buildExportCliResultEnvelope({
      path: '/tmp/page.pdf',
      bytes: 123,
      format: 'pdf',
    });
    expect(result).toEqual({
      ok: true,
      path: '/tmp/page.pdf',
      out: '/tmp/page.pdf',
      bytes: 123,
      format: 'pdf',
    });
  });

  it('omits bytes when the byte size is unknown', () => {
    const result = buildExportCliResultEnvelope({
      path: '/tmp/page.pdf',
      format: 'pdf',
    });
    expect(result).toEqual({
      ok: true,
      path: '/tmp/page.pdf',
      out: '/tmp/page.pdf',
      format: 'pdf',
    });
  });
});

describe('buildExportCliRequestBody', () => {
  it('serializes fileName and omits title unless provided', () => {
    expect(buildExportCliRequestBody({ fileName: 'index.html' })).toEqual({
      fileName: 'index.html',
    });
    expect(buildExportCliRequestBody({ fileName: 'index.html', title: 'Landing' })).toEqual({
      fileName: 'index.html',
      title: 'Landing',
    });
  });
});
