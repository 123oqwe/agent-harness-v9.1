import { describe, expect, it } from 'vitest';
import { DefaultDocumentIngestor, DocumentIngestError } from '../../../packages/documents/src/index.js';

describe('AH-DOC-INGEST-UNSUPPORTED-001: Handle unsupported formats', () => {
  const ingestor = new DefaultDocumentIngestor();

  it('returns typed error for .xyz files', async () => {
    const buf = Buffer.from('unknown data', 'utf8');
    await expect(ingestor.ingest(buf, 'file.xyz', {})).rejects.toThrow(DocumentIngestError);
  });

  it('returns typed error for .dat files', async () => {
    const buf = Buffer.from('binary data', 'utf8');
    await expect(ingestor.ingest(buf, 'file.dat', {})).rejects.toThrow(DocumentIngestError);
  });

  it('returns typed error for .bin files', async () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    await expect(ingestor.ingest(buf, 'file.bin', {})).rejects.toThrow(DocumentIngestError);
  });

  it('returns typed error for no extension', async () => {
    const buf = Buffer.from('no extension', 'utf8');
    await expect(ingestor.ingest(buf, 'README', {})).rejects.toThrow(DocumentIngestError);
  });

  it('error code is unsupported', async () => {
    const buf = Buffer.from('unknown', 'utf8');
    try {
      await ingestor.ingest(buf, 'file.xyz', {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DocumentIngestError);
      expect((err as DocumentIngestError).code).toBe('unsupported');
    }
  });

  it('error message includes the file extension', async () => {
    const buf = Buffer.from('data', 'utf8');
    try {
      await ingestor.ingest(buf, 'file.xyz', {});
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('.xyz');
    }
  });
  it('error is an instance of Error', async () => {
    try {
      await ingestor.ingest(Buffer.from('data'), 'file.xyz', {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('handles various unsupported extensions', async () => {
    for (const ext of ['.xyz', '.dat', '.bin', '.abc', '.zzz']) {
      await expect(ingestor.ingest(Buffer.from('x'), `file${ext}`, {})).rejects.toThrow(DocumentIngestError);
    }
  });

});
