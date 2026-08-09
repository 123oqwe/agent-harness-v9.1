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

  it('handles multiple tables separated by text', async () => {
    const md = '| A |\n|---|\n| 1 |\n\nText\n\n| B |\n|---|\n| 2 |\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'test.md', {});
    expect(result.tables).toHaveLength(2);
    expect(result.tables[0]!.rows[0]).toEqual(['A']);
    expect(result.tables[1]!.rows[0]).toEqual(['B']);
  });

  it('handles tables with varying column counts', async () => {
    const md = '| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |\n| 4 | 5 |\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'test.md', {});
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]!.rows).toHaveLength(3);
  });

  it('handles single-column tables', async () => {
    const md = '| Header |\n|---|\n| Value |\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'test.md', {});
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]!.rows[0]).toEqual(['Header']);
    expect(result.tables[0]!.rows[1]).toEqual(['Value']);
  });

  it('handles tables with no data rows', async () => {
    const md = '| A | B |\n|---|---|\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'test.md', {});
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]!.rows[0]).toEqual(['A', 'B']);
  });
  it('handles tables with alignment markers', async () => {
    const md = '| A | B |\n|:--|--:|\n| 1 | 2 |\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'test.md', {});
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]!.rows[0]).toEqual(['A', 'B']);
  });

  it('handles tables with long cell content', async () => {
    const longText = 'x'.repeat(100);
    const md = `| A | B |\n|---|---|\n| ${longText} | short |\n`;
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'test.md', {});
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]!.rows[1]![0]).toContain(longText);
  });


  it('handles empty table', async () => {
    const md = '| A | B |\n|---|---|\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'empty_table.md', {});
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]!.rows).toHaveLength(1);
  });

  it('handles table with single column', async () => {
    const md = '| A |\n|---|\n| 1 |\n| 2 |\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'single_col.md', {});
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]!.rows[0]).toEqual(['A']);
  });

  it('handles table with many columns', async () => {
    const md = '| A | B | C | D | E |\n|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 |\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'wide.md', {});
    expect(result.tables[0]!.rows[0]).toHaveLength(5);
  });

  it('handles table with empty cells', async () => {
    const md = '| A | B |\n|---|---|\n| 1 |  |\n|  | 2 |\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'empty_cells.md', {});
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]!.rows).toHaveLength(3);
  });

  it('handles multiple tables in same document', async () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |\n\nSome text.\n\n| C | D |\n|---|---|\n| 3 | 4 |\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'multi_table.md', {});
    expect(result.tables).toHaveLength(2);
  });

  it('preserves cell content with special characters', async () => {
    const md = '| A | B |\n|---|---|\n| @hello | #world |\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'special.md', {});
    expect(result.tables[0]!.rows[1]![0]).toContain('@hello');
  });

  it('preserves cell content with Unicode', async () => {
    const md = '| A | B |\n|---|---|\n| 中文 | 日本語 |\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'unicode.md', {});
    expect(result.tables[0]!.rows[1]![0]).toBe('中文');
  });


  it('handles table with long cell content', async () => {
    const md = '| A | B |\n|---|---|\n| ' + 'x'.repeat(100) + ' | short |\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'long.md', {});
    expect(result.tables[0]!.rows[1]![0]).toHaveLength(100);
  });

  it('handles table with numbers', async () => {
    const md = '| Count | Price |\n|---|---|\n| 42 | 9.99 |\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'numbers.md', {});
    expect(result.tables[0]!.rows[1]![0]).toBe('42');
  });

  it('handles table with alignment markers', async () => {
    const md = '| A | B | C |\n|:---|:---:|---:|\n| 1 | 2 | 3 |\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'align.md', {});
    expect(result.tables).toHaveLength(1);
  });

  it('handles table with many rows', async () => {
    const rows = ['| A | B |', '|---|---|'];
    for (let i = 0; i < 10; i++) rows.push('| ' + i + ' | ' + (i * 2) + ' |');
    const md = rows.join('\n') + '\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'many_rows.md', {});
    expect(result.tables[0]!.rows).toHaveLength(11);
  });


  it('handles table with pipe in cell content', async () => {
    const md = '| A | B |\n|---|---|\n| a\\|b | c |\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'pipe.md', {});
    expect(result.tables).toHaveLength(1);
  });

  it('handles table followed by text', async () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |\n\nText after table.\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'table_text.md', {});
    expect(result.tables).toHaveLength(1);
    expect(result.text).toContain('Text after');
  });

});
