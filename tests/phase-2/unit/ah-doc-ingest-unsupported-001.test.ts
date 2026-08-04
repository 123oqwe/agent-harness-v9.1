import { describe, expect, it } from 'vitest';
import { DefaultDocumentIngestor, DocumentIngestError } from '../../../packages/documents/src/index.js';

describe('AH-DOC-INGEST-UNSUPPORTED-001: Handle unsupported formats', () => {
  const ingestor = new DefaultDocumentIngestor();

  it('returns typed error for .xyz files', () => {
    const buf = Buffer.from('unknown data', 'utf8');
    return expect(ingestor.ingest(buf, 'file.xyz', {})).rejects.toThrow(DocumentIngestError);
  });

  it('returns typed error for .dat files', () => {
    const buf = Buffer.from('binary data', 'utf8');
    return expect(ingestor.ingest(buf, 'file.dat', {})).rejects.toThrow(DocumentIngestError);
  });

  it('error code is unsupported', () => {
    const buf = Buffer.from('unknown', 'utf8');
    return ingestor.ingest(buf, 'file.xyz', {}).catch(err => {
      expect(err).toBeInstanceOf(DocumentIngestError);
      expect((err as DocumentIngestError).code).toBe('unsupported');
    });
  });
});
