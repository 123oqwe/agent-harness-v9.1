import { describe, expect, it } from 'vitest';
import { HtmlParser, DocumentIngestError } from '../../../packages/documents/src/index.js';

const html = `<!DOCTYPE html>
<html><head><title>Test</title></head><body>
<h1>Main Title</h1>
<p>Some paragraph text.</p>
<h2>Subsection</h2>
<table>
<tr><th>Name</th><th>Value</th></tr>
<tr><td>A</td><td>1</td></tr>
<tr><td>B</td><td>2</td></tr>
</table>
<img src="photo.png" alt="A photo" />
</body></html>`;

describe('AH-DOC-INGEST-WEB-001: Ingest webpages with content extraction', () => {
  const parser = new HtmlParser();

  it('extracts text content from HTML', () => {
    const buf = Buffer.from(html, 'utf8');
    return parser.parse(buf, 'page.html', {}).then(result => {
      expect(result.text).toContain('Main Title');
      expect(result.text).toContain('Some paragraph text');
    });
  });

  it('parses headings from HTML', () => {
    const buf = Buffer.from(html, 'utf8');
    return parser.parse(buf, 'page.html', {}).then(result => {
      expect(result.headings).toHaveLength(2);
      expect(result.headings[0]!.level).toBe(1);
      expect(result.headings[0]!.text).toBe('Main Title');
      expect(result.headings[1]!.level).toBe(2);
    });
  });

  it('parses tables from HTML', () => {
    const buf = Buffer.from(html, 'utf8');
    return parser.parse(buf, 'page.html', {}).then(result => {
      expect(result.tables).toHaveLength(1);
      expect(result.tables[0]!.rows).toHaveLength(3);
      expect(result.tables[0]!.rows[0]).toEqual(['Name', 'Value']);
    });
  });

  it('parses image references from HTML', () => {
    const buf = Buffer.from(html, 'utf8');
    return parser.parse(buf, 'page.html', {}).then(result => {
      expect(result.images).toHaveLength(1);
      expect(result.images[0]!.ref).toBe('photo.png');
      expect(result.images[0]!.alt).toBe('A photo');
    });
  });

  it('strips script and style tags', () => {
    const htmlWithScript = '<script>var x=1;</script><style>.a{}</style><p>visible</p>';
    const buf = Buffer.from(htmlWithScript, 'utf8');
    return parser.parse(buf, 'test.html', {}).then(result => {
      expect(result.text).not.toContain('var x');
      expect(result.text).not.toContain('.a{}');
      expect(result.text).toContain('visible');
    });
  });

  it('records provenance', () => {
    const buf = Buffer.from(html, 'utf8');
    return parser.parse(buf, 'page.html', {}).then(result => {
      expect(result.provenance.format).toBe('html');
      expect(result.provenance.parser_name).toBe('html-native');
    });
  });
});
