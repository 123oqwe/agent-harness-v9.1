import { describe, expect, it } from 'vitest';
import { MarkdownParser, DefaultDocumentIngestor, DocumentIngestError } from '../../../packages/documents/src/index.js';

const md = `# Title

## Section A
Some text here.

| Col1 | Col2 |
|------|------|
| a    | b    |
| c    | d    |

![alt text](image.png)

### Subsection
More text.
`;

describe('AH-DOC-INGEST-MD-001: Ingest Markdown documents', () => {
  const parser = new MarkdownParser();

  it('parses heading hierarchy preserving levels', () => {
    const buf = Buffer.from(md, 'utf8');
    return parser.parse(buf, 'test.md', {}).then(result => {
      expect(result.headings).toHaveLength(3);
      expect(result.headings[0]!.level).toBe(1);
      expect(result.headings[0]!.text).toBe('Title');
      expect(result.headings[1]!.level).toBe(2);
      expect(result.headings[2]!.level).toBe(3);
    });
  });

  it('parses tables preserving structure', () => {
    const buf = Buffer.from(md, 'utf8');
    return parser.parse(buf, 'test.md', {}).then(result => {
      expect(result.tables).toHaveLength(1);
      expect(result.tables[0]!.rows).toHaveLength(3);
      expect(result.tables[0]!.rows[0]).toEqual(['Col1', 'Col2']);
      expect(result.tables[0]!.rows[2]).toEqual(['c', 'd']);
    });
  });

  it('parses image references with provenance', () => {
    const buf = Buffer.from(md, 'utf8');
    return parser.parse(buf, 'test.md', {}).then(result => {
      expect(result.images).toHaveLength(1);
      expect(result.images[0]!.ref).toBe('image.png');
      expect(result.images[0]!.alt).toBe('alt text');
    });
  });

  it('records source provenance with content hash', () => {
    const buf = Buffer.from(md, 'utf8');
    return parser.parse(buf, 'test.md', {}).then(result => {
      expect(result.provenance.format).toBe('md');
      expect(result.provenance.parser_name).toBe('markdown-native');
      expect(result.provenance.content_hash).toHaveLength(64);
      expect(result.provenance.byte_size).toBe(buf.length);
      expect(result.provenance.source_path).toBe('test.md');
    });
  });

  it('rejects files exceeding max bytes', () => {
    const buf = Buffer.alloc(100);
    return expect(parser.parse(buf, 'big.md', { max_bytes: 50 })).rejects.toThrow(DocumentIngestError);
  });
});

describe('AH-DOC-INGEST-MD-001: DefaultDocumentIngestor routing', () => {
  const ingestor = new DefaultDocumentIngestor();

  it('routes .md files to MarkdownParser', () => {
    const buf = Buffer.from('# Hello\n', 'utf8');
    return ingestor.ingest(buf, 'test.md', {}).then(result => {
      expect(result.provenance.format).toBe('md');
      expect(result.headings[0]!.text).toBe('Hello');
    });
  });
});
