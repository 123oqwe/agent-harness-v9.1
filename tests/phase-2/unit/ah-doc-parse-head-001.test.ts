import { describe, expect, it } from 'vitest';
import { MarkdownParser } from '../../../packages/documents/src/index.js';

describe('AH-DOC-PARSE-HEAD-001: Parse heading hierarchy preserving levels', () => {
  const parser = new MarkdownParser();

  it('preserves heading levels 1-6', () => {
    const md = '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n';
    return parser.parse(Buffer.from(md, 'utf8'), 'test.md', {}).then(result => {
      expect(result.headings).toHaveLength(6);
      for (let i = 0; i < 6; i++) {
        expect(result.headings[i]!.level).toBe(i + 1);
        expect(result.headings[i]!.text).toBe(`H${i + 1}`);
      }
    });
  });

  it('records heading positions', () => {
    const md = 'Intro text\n# Heading\nMore text\n';
    return parser.parse(Buffer.from(md, 'utf8'), 'test.md', {}).then(result => {
      expect(result.headings).toHaveLength(1);
      expect(result.headings[0]!.position).toBeGreaterThan(0);
    });
  });

  it('handles nested headings correctly', async () => {
    const md = '# Top\n## Child 1\n### Grandchild\n## Child 2\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'test.md', {});
    expect(result.headings).toHaveLength(4);
    expect(result.headings[0]!.level).toBe(1);
    expect(result.headings[1]!.level).toBe(2);
    expect(result.headings[2]!.level).toBe(3);
    expect(result.headings[3]!.level).toBe(2);
  });

  it('handles headings with trailing content', async () => {
    const md = '# Title with trailing spaces   \nContent\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'test.md', {});
    expect(result.headings).toHaveLength(1);
    expect(result.headings[0]!.text).toContain('Title');
  });

  it('handles content with no headings', async () => {
    const md = 'Just plain text without any headings.\nMore text.\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'test.md', {});
    expect(result.headings).toHaveLength(0);
  });

  it('handles heading text with formatting', async () => {
    const md = '# **Bold Title**\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'test.md', {});
    expect(result.headings).toHaveLength(1);
    expect(result.headings[0]!.text).toContain('Bold Title');
  });
  it('handles heading with only level 1', async () => {
    const md = '# Only H1\nContent\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'test.md', {});
    expect(result.headings).toHaveLength(1);
    expect(result.headings[0]!.level).toBe(1);
  });

  it('handles heading text with special characters', async () => {
    const md = '# Heading with @special #chars\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'test.md', {});
    expect(result.headings).toHaveLength(1);
    expect(result.headings[0]!.text).toContain('special');
  });


  it('handles empty document with no headings', async () => {
    const result = await parser.parse(Buffer.from('', 'utf8'), 'empty.md', {});
    expect(result.headings).toHaveLength(0);
  });

  it('handles document with only text and no headings', async () => {
    const result = await parser.parse(Buffer.from('Just text. No headings.', 'utf8'), 'text.md', {});
    expect(result.headings).toHaveLength(0);
  });

  it('handles mixed heading levels non-sequential', async () => {
    const md = '### H3\n# H1\n##### H5\n## H2\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'mixed.md', {});
    expect(result.headings).toHaveLength(4);
    expect(result.headings[0]!.level).toBe(3);
    expect(result.headings[1]!.level).toBe(1);
    expect(result.headings[2]!.level).toBe(5);
    expect(result.headings[3]!.level).toBe(2);
  });

  it('preserves heading text with special characters', async () => {
    const md = '# Heading with @special #chars!\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'special.md', {});
    expect(result.headings[0]!.text).toContain('@special');
  });

  it('preserves heading text with Unicode', async () => {
    const md = '# 中文标题\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'unicode.md', {});
    expect(result.headings[0]!.text).toBe('中文标题');
  });

  it('handles headings with leading/trailing whitespace', async () => {
    const md = '#   Spaced Heading   \n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'spaced.md', {});
    expect(result.headings).toHaveLength(1);
    expect(result.headings[0]!.text).toBeTruthy();
  });

  it('handles consecutive headings without text between', async () => {
    const md = '# H1\n## H2\n### H3\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'consecutive.md', {});
    expect(result.headings).toHaveLength(3);
  });


  it('handles heading with code span', async () => {
    const md = '# Heading with `code`\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'code.md', {});
    expect(result.headings).toHaveLength(1);
  });

  it('handles heading with link', async () => {
    const md = '# [Linked Heading](url)\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'link.md', {});
    expect(result.headings).toHaveLength(1);
  });

  it('handles deeply nested heading level 6', async () => {
    const md = '###### Deep heading\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'deep.md', {});
    expect(result.headings).toHaveLength(1);
    expect(result.headings[0]!.level).toBe(6);
  });

  it('handles heading at end of document without newline', async () => {
    const md = '# End heading';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'end.md', {});
    expect(result.headings).toHaveLength(1);
  });


  it('handles heading followed by paragraph', async () => {
    const md = '# Title\n\nParagraph text.\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'mixed.md', {});
    expect(result.headings).toHaveLength(1);
    expect(result.text).toContain('Paragraph');
  });

  it('handles heading with emoji', async () => {
    const md = '# Heading with emoji\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'emoji.md', {});
    expect(result.headings).toHaveLength(1);
  });

});
