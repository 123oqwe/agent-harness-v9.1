import { describe, expect, it } from 'vitest';
import { HtmlParser } from '../../../packages/documents/src/index.js';

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
  it('handles empty HTML', async () => {
    const result = await parser.parse(Buffer.from('', 'utf8'), 'empty.html', {});
    expect(result).toBeDefined();
  });

  it('handles HTML with links', async () => {
    const html = '<html><body><a href="https://example.com">Link</a></body></html>';
    const result = await parser.parse(Buffer.from(html, 'utf8'), 'links.html', {});
    expect(result).toBeDefined();
  });

  it('records provenance for HTML', async () => {
    const html = '<html><body><h1>Title</h1></body></html>';
    const result = await parser.parse(Buffer.from(html, 'utf8'), 'test.html', {});
    expect(result.provenance.format).toBe('html');
    expect(result.provenance.content_hash).toHaveLength(64);
  });

  it('handles empty HTML document', async () => {
    const result = await parser.parse(Buffer.from(''), 'empty.html', {});
    expect(result).toBeDefined();
  });

  it('extracts text from paragraphs', async () => {
    const html = Buffer.from('<p>First</p><p>Second</p>');
    const result = await parser.parse(html, 'paras.html', {});
    expect(result.text).toContain('First');
    expect(result.text).toContain('Second');
  });

  it('handles Unicode content', async () => {
    const html = Buffer.from('<p>中文内容</p>');
    const result = await parser.parse(html, 'unicode.html', {});
    expect(result.text).toContain('中文');
  });

  it('handles nested lists', async () => {
    const html = Buffer.from('<ul><li>Item 1<ul><li>Subitem</li></ul></li></ul>');
    const result = await parser.parse(html, 'lists.html', {});
    expect(result.text).toContain('Item 1');
  });

  it('handles blockquote elements', async () => {
    const html = Buffer.from('<blockquote>Quoted text</blockquote>');
    const result = await parser.parse(html, 'quote.html', {});
    expect(result.text).toContain('Quoted');
  });

  it('handles pre-formatted text', async () => {
    const html = Buffer.from('<pre>Line 1\nLine 2</pre>');
    const result = await parser.parse(html, 'pre.html', {});
    expect(result.text).toContain('Line 1');
  });


  it('handles HTML with inline styles', async () => {
    const html = Buffer.from('<p style="color: red">Styled</p>');
    const result = await parser.parse(html, 'styled.html', {});
    expect(result.text).toContain('Styled');
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
  });

  it('handles CDATA sections', async () => {
    const html = Buffer.from('<p>Before</p><![CDATA[cdata]]><p>After</p>');
    const result = await parser.parse(html, 'cdata.html', {});
    expect(result.text).toContain('Before');
  });

  it('handles very long HTML', async () => {
    const html = Buffer.from('<p>' + 'A'.repeat(10000) + '</p>');
    const result = await parser.parse(html, 'long.html', {});
    expect(result.text.length).toBeGreaterThan(1000);
  });

});