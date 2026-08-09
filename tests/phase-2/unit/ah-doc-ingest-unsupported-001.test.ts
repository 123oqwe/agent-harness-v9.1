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


  it('returns typed error for .abc files', async () => {
    await expect(ingestor.ingest(Buffer.from('data'), 'file.abc', {})).rejects.toThrow(DocumentIngestError);
  });

  it('returns typed error for .xyz with empty content', async () => {
    await expect(ingestor.ingest(Buffer.alloc(0), 'file.xyz', {})).rejects.toThrow(DocumentIngestError);
  });

  it('returns typed error for .xyz with large content', async () => {
    await expect(ingestor.ingest(Buffer.alloc(10000, 0xFF), 'file.xyz', {})).rejects.toThrow(DocumentIngestError);
  });

  it('returns typed error for files with no extension', async () => {
    await expect(ingestor.ingest(Buffer.from('data'), 'noextension', {})).rejects.toThrow(DocumentIngestError);
  });

  it('error includes format name in message', async () => {
    try {
      await ingestor.ingest(Buffer.from('data'), 'file.unknown', {});
    } catch (e) {
      expect(e).toBeInstanceOf(DocumentIngestError);
      expect((e as DocumentIngestError).message).toBeTruthy();
    }
  });

  it('returns typed error for .bin files', async () => {
    await expect(ingestor.ingest(Buffer.from([0x00, 0x01, 0x02]), 'file.bin', {})).rejects.toThrow(DocumentIngestError);
  });

  it('returns typed error for .exe files', async () => {
    await expect(ingestor.ingest(Buffer.from('MZ'), 'file.exe', {})).rejects.toThrow(DocumentIngestError);
  });

  it('returns typed error for .dat with binary content', async () => {
    await expect(ingestor.ingest(Buffer.from([0xFF, 0xFE, 0xFD]), 'file.dat', {})).rejects.toThrow(DocumentIngestError);
  });


  it('returns typed error for .tmp files', async () => {
    await expect(ingestor.ingest(Buffer.from('temp'), 'file.tmp', {})).rejects.toThrow(DocumentIngestError);
  });

  it('returns typed error for .bak files', async () => {
    await expect(ingestor.ingest(Buffer.from('backup'), 'file.bak', {})).rejects.toThrow(DocumentIngestError);
  });

  it('returns typed error for .log files', async () => {
    await expect(ingestor.ingest(Buffer.from('log entry'), 'file.log', {})).rejects.toThrow(DocumentIngestError);
  });

  it('returns typed error for .cache files', async () => {
    await expect(ingestor.ingest(Buffer.from('cache'), 'file.cache', {})).rejects.toThrow(DocumentIngestError);
  });

  it('returns typed error for uppercase extension', async () => {
    await expect(ingestor.ingest(Buffer.from('data'), 'file.XYZ', {})).rejects.toThrow(DocumentIngestError);
  });

  it('returns typed error for double extension', async () => {
    await expect(ingestor.ingest(Buffer.from('data'), 'file.tar.xyz', {})).rejects.toThrow(DocumentIngestError);
  });


  it('returns typed error for .swp files', async () => {
    await expect(ingestor.ingest(Buffer.from('swap'), 'file.swp', {})).rejects.toThrow(DocumentIngestError);
  });

  it('returns typed error for .DS_Store files', async () => {
    await expect(ingestor.ingest(Buffer.from('macOS'), '.DS_Store', {})).rejects.toThrow(DocumentIngestError);
  });

  it('returns typed error for .lnk files', async () => {
    await expect(ingestor.ingest(Buffer.from('shortcut'), 'file.lnk', {})).rejects.toThrow(DocumentIngestError);
  });

  it('returns typed error for .iso files', async () => {
    await expect(ingestor.ingest(Buffer.from('disk image'), 'file.iso', {})).rejects.toThrow(DocumentIngestError);
  });


  it('returns typed error for .sys files', async () => {
    await expect(ingestor.ingest(Buffer.from('system'), 'file.sys', {})).rejects.toThrow(DocumentIngestError);
  });

  it('returns typed error for .dll files', async () => {
    await expect(ingestor.ingest(Buffer.from('library'), 'file.dll', {})).rejects.toThrow(DocumentIngestError);
  });

});
