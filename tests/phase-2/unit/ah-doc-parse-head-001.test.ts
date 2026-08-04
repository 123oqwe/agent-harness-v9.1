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

  it('handles nested headings correctly', () => {
    const md = '# Top\n## Child 1\n### Grandchild\n## Child 2\n';
    return parser.parse(Buffer.from(md, 'utf8'), 'test.md', {}).then(result => {
      expect(result.headings).toHaveLength(4);
      expect(result.headings[0]!.level).toBe(1);
      expect(result.headings[1]!.level).toBe(2);
      expect(result.headings[2]!.level).toBe(3);
      expect(result.headings[3]!.level).toBe(2);
    });
  });
});
