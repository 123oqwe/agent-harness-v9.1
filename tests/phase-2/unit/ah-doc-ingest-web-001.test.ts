import { describe, it, expect } from 'vitest';
import { HtmlParser } from '../../../packages/documents/src/parsers/html-parser.js';
import { DocumentIngestError } from '../../../packages/documents/src/types.js';

describe('AH-DOC-INGEST-WEB-001: Ingest HTML/webpage documents preserving structure', () => {
  const parser = new HtmlParser();
  const html = Buffer.from(`<!DOCTYPE html>
<html><head><title>Test Page</title></head><body>
<h1>Main Title</h1>
<p>Some paragraph text with <strong>bold</strong> and <em>italic</em>.</p>
<h2>Subsection</h2>
<table><tr><th>Name</th><th>Value</th></tr><tr><td>Alpha</td><td>100</td></tr></table>
<img src="https://example.com/image.png" alt="Example image" />
</body></html>`);

  it('reports html format and version metadata', () => {
    expect(parser.format).toBe('html');
    expect(parser.canHandle('html')).toBe(true);
    expect(parser.canHandle('pdf')).toBe(false);
  });

  it('extracts text content stripping tags and scripts', async () => {
    const result = await parser.parse(html, 'test.html', {});
    expect(result.text).toContain('Main Title');
    expect(result.text).toContain('bold');
    expect(result.text).toContain('Subsection');
    expect(result.text).not.toContain('<');
    expect(result.text).not.toContain('script');
  });

  it('extracts headings with correct levels', async () => {
    const result = await parser.parse(html, 'test.html', {});
    expect(result.headings).toHaveLength(2);
    expect(result.headings[0]).toMatchObject({ level: 1, text: 'Main Title' });
    expect(result.headings[1]).toMatchObject({ level: 2, text: 'Subsection' });
  });

  it('extracts table rows and cells', async () => {
    const result = await parser.parse(html, 'test.html', {});
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]!.rows).toHaveLength(2);
    expect(result.tables[0]!.rows[0]).toEqual(['Name', 'Value']);
    expect(result.tables[0]!.rows[1]).toEqual(['Alpha', '100']);
  });

  it('extracts image references with alt text', async () => {
    const result = await parser.parse(html, 'test.html', {});
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.ref).toBe('https://example.com/image.png');
    expect(result.images[0]!.alt).toBe('Example image');
  });

  it('records provenance with content hash and byte size', async () => {
    const result = await parser.parse(html, 'test.html', {});
    expect(result.provenance.source_path).toBe('test.html');
    expect(result.provenance.format).toBe('html');
    expect(result.provenance.content_hash).toHaveLength(64);
    expect(result.provenance.byte_size).toBe(html.byteLength);
  });

  it('strips script and style content', async () => {
    const htmlWithScript = Buffer.from(
      '<p>visible</p><script>alert("xss")</script><style>.x{color:red}</style>'
    );
    const result = await parser.parse(htmlWithScript, 'test.html', {});
    expect(result.text).toContain('visible');
    expect(result.text).not.toContain('alert');
    expect(result.text).not.toContain('color');
  });

  it('decodes HTML entities', async () => {
    const htmlWithEntities = Buffer.from('<p>5 &lt; 10 &amp; 20 &gt; 15</p>');
    const result = await parser.parse(htmlWithEntities, 'test.html', {});
    expect(result.text).toContain('5 < 10 & 20 > 15');
  });

  it('throws DocumentIngestError when content exceeds max_bytes', async () => {
    await expect(parser.parse(html, 'test.html', { max_bytes: 10 }))
      .rejects.toThrow(DocumentIngestError);
  });

  it('handles empty HTML', async () => {
    const result = await parser.parse(Buffer.from('', 'utf8'), 'empty.html', {});
    expect(result.text).toBe('');
  });

  it('handles HTML with only head', async () => {
    const html = Buffer.from('<html><head><title>Test</title></head><body></body></html>');
    const result = await parser.parse(html, 'head.html', {});
    expect(result).toBeDefined();
  });

  it('handles deeply nested elements', async () => {
    const html = Buffer.from('<div><div><div><p>Deep text</p></div></div></div>');
    const result = await parser.parse(html, 'nested.html', {});
    expect(result.text).toContain('Deep text');
  });

  it('handles HTML entities', async () => {
    const html = Buffer.from('<p>&lt;tag&gt; &amp; &quot;quote&quot;</p>');
    const result = await parser.parse(html, 'entities.html', {});
    expect(result.text).toContain('<tag>');
  });

  it('handles HTML comments', async () => {
    const html = Buffer.from('<p>Visible</p><!-- Comment -->');
    const result = await parser.parse(html, 'comments.html', {});
    expect(result.text).toContain('Visible');
    expect(result.text).not.toContain('Comment');
  });

  it('handles script and style tags', async () => {
    const html = Buffer.from('<script>var x = 1;</script><style>.cls { }</style><p>Content</p>');
    const result = await parser.parse(html, 'script.html', {});
    expect(result.text).toContain('Content');
  });

  it('handles HTML with attributes', async () => {
    const html = Buffer.from('<div class="container" id="main"><p>Text</p></div>');
    const result = await parser.parse(html, 'attrs.html', {});
    expect(result.text).toContain('Text');
  });

  it('handles malformed HTML gracefully', async () => {
    const html = Buffer.from('<p>Unclosed paragraph');
    const result = await parser.parse(html, 'malformed.html', {});
    expect(result.text).toContain('Unclosed');
  });


  it('handles HTML with inline styles', async () => {
    const html = Buffer.from('<p style="color: red">Styled text</p>');
    const result = await parser.parse(html, 'styled.html', {});
    expect(result.text).toContain('Styled text');
  });

  it('handles HTML with data attributes', async () => {
    const html = Buffer.from('<div data-id="123">Data</div>');
    const result = await parser.parse(html, 'data.html', {});
    expect(result.text).toContain('Data');
  });

  it('handles HTML5 semantic elements', async () => {
    const html = Buffer.from('<article><section><p>Semantic</p></section></article>');
    const result = await parser.parse(html, 'semantic.html', {});
    expect(result.text).toContain('Semantic');
  });

  it('handles self-closing tags', async () => {
    const html = Buffer.from('<p>Text<br/>More</p>');
    const result = await parser.parse(html, 'selfclose.html', {});
    expect(result.text).toContain('Text');
    expect(result.text).toContain('More');
  });

  it('handles CDATA sections', async () => {
    const html = Buffer.from('<p>Before</p><![CDATA[cdata content]]><p>After</p>');
    const result = await parser.parse(html, 'cdata.html', {});
    expect(result.text).toContain('Before');
  });

});
