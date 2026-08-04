import { describe, expect, it } from 'vitest';
import { MarkdownParser } from '../../../packages/documents/src/index.js';

describe('AH-DOC-PARSE-IMGREF-001: Parse image references with provenance', () => {
  const parser = new MarkdownParser();

  it('parses markdown image syntax', () => {
    const md = '![Alt text](path/to/image.png)\n';
    return parser.parse(Buffer.from(md, 'utf8'), 'test.md', {}).then(result => {
      expect(result.images).toHaveLength(1);
      expect(result.images[0]!.alt).toBe('Alt text');
      expect(result.images[0]!.ref).toBe('path/to/image.png');
    });
  });

  it('handles empty alt text', () => {
    const md = '![](image.jpg)\n';
    return parser.parse(Buffer.from(md, 'utf8'), 'test.md', {}).then(result => {
      expect(result.images).toHaveLength(1);
      expect(result.images[0]!.alt).toBe('');
    });
  });

  it('handles multiple images', () => {
    const md = '![First](a.png)\n![Second](b.png)\n';
    return parser.parse(Buffer.from(md, 'utf8'), 'test.md', {}).then(result => {
      expect(result.images).toHaveLength(2);
    });
  });
});
