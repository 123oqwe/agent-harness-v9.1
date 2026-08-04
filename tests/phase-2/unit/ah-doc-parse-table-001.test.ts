import { describe, expect, it } from 'vitest';
import { MarkdownParser } from '../../../packages/documents/src/index.js';

describe('AH-DOC-PARSE-TABLE-001: Parse table cells preserving structure', () => {
  const parser = new MarkdownParser();

  it('parses simple tables', () => {
    const md = '| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |\n';
    return parser.parse(Buffer.from(md, 'utf8'), 'test.md', {}).then(result => {
      expect(result.tables).toHaveLength(1);
      expect(result.tables[0]!.rows).toHaveLength(2);
      expect(result.tables[0]!.rows[0]).toEqual(['A', 'B', 'C']);
      expect(result.tables[0]!.rows[1]).toEqual(['1', '2', '3']);
    });
  });

  it('handles empty cells', () => {
    const md = '| A | B |\n|---|---|\n|  | x |\n';
    return parser.parse(Buffer.from(md, 'utf8'), 'test.md', {}).then(result => {
      expect(result.tables[0]!.rows[1]).toEqual(['', 'x']);
    });
  });

  it('handles multiple tables', () => {
    const md = '| A |\n|---|\n| 1 |\n\nText\n\n| B |\n|---|\n| 2 |\n';
    return parser.parse(Buffer.from(md, 'utf8'), 'test.md', {}).then(result => {
      expect(result.tables).toHaveLength(2);
    });
  });
});
