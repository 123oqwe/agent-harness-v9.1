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
  it('handles empty markdown', async () => {
    const result = await ingestor.ingest(Buffer.from('', 'utf8'), 'empty.md', {});
    expect(result.headings).toHaveLength(0);
    expect(result.text).toBe('');
  });

  it('handles markdown with code blocks', async () => {
    const md = '```js\nconst x = 1;\n```\n';
    const result = await ingestor.ingest(Buffer.from(md, 'utf8'), 'code.md', {});
    expect(result).toBeDefined();
  });

  it('handles markdown with links', async () => {
    const md = '[Link text](https://example.com)\n';
    const result = await ingestor.ingest(Buffer.from(md, 'utf8'), 'links.md', {});
    expect(result).toBeDefined();
  });


  it('handles empty markdown', async () => {
    const result = await ingestor.ingest(Buffer.from('', 'utf8'), 'empty.md', {});
    expect(result.text).toBe('');
  });

  it('handles markdown with only whitespace', async () => {
    const result = await ingestor.ingest(Buffer.from('   \n\n  ', 'utf8'), 'ws.md', {});
    expect(result).toBeDefined();
  });

  it('handles markdown with code blocks', async () => {
    const md = '```js\nconst x = 1;\n```\n';
    const result = await ingestor.ingest(Buffer.from(md, 'utf8'), 'code.md', {});
    expect(result.text).toContain('const x');
  });

  it('handles markdown with blockquotes', async () => {
    const md = '> This is a quote\n';
    const result = await ingestor.ingest(Buffer.from(md, 'utf8'), 'quote.md', {});
    expect(result.text).toContain('quote');
  });

  it('handles markdown with numbered lists', async () => {
    const md = '1. First\n2. Second\n3. Third\n';
    const result = await ingestor.ingest(Buffer.from(md, 'utf8'), 'list.md', {});
    expect(result.text).toContain('First');
    expect(result.text).toContain('Second');
  });

  it('handles markdown with links', async () => {
    const md = '[Link text](https://example.com)\n';
    const result = await ingestor.ingest(Buffer.from(md, 'utf8'), 'links.md', {});
    expect(result.text).toContain('Link text');
  });

  it('handles markdown with bold and italic', async () => {
    const md = '**bold** and *italic*\n';
    const result = await ingestor.ingest(Buffer.from(md, 'utf8'), 'format.md', {});
    expect(result.text).toContain('bold');
    expect(result.text).toContain('italic');
  });


  it('handles markdown with horizontal rules', async () => {
    const md = 'Content above\n---\nContent below\n';
    const result = await ingestor.ingest(Buffer.from(md, 'utf8'), 'hr.md', {});
    expect(result.text).toContain('above');
    expect(result.text).toContain('below');
  });

  it('handles markdown with inline code', async () => {
    const md = 'Use `npm install` to install.\n';
    const result = await ingestor.ingest(Buffer.from(md, 'utf8'), 'inline.md', {});
    expect(result.text).toContain('npm install');
  });

  it('handles markdown with nested formatting', async () => {
    const md = '**bold *and italic* text**\n';
    const result = await ingestor.ingest(Buffer.from(md, 'utf8'), 'nested.md', {});
    expect(result.text).toContain('bold');
  });

  it('handles markdown with reference links', async () => {
    const md = '[ref][1]\n[1]: https://example.com\n';
    const result = await ingestor.ingest(Buffer.from(md, 'utf8'), 'reflinks.md', {});
    expect(result.text).toContain('ref');
  });

  it('handles markdown with footnotes', async () => {
    const md = 'Text[^1]\n[^1]: Footnote\n';
    const result = await ingestor.ingest(Buffer.from(md, 'utf8'), 'footnotes.md', {});
    expect(result.text).toContain('Text');
  });

});
