import { describe, it, expect } from 'vitest';
import { parseDocument } from '../../ingestion/parse-document.js';

describe('AH-INGESTION-001: parse_document', () => {
  it('parses plain text with page breaks', () => {
    const result = parseDocument('Page 1\fPage 2\fPage 3', { path: 'doc.txt' });
    expect(result.sections.length).toBe(3);
    expect(result.sections[0].text).toBe('Page 1');
    expect(result.sections[2].text).toBe('Page 3');
  });

  it('respects max_pages', () => {
    const result = parseDocument('A\fB\fC\fD\fE', { path: 'doc.txt', max_pages: 2 });
    expect(result.sections.length).toBe(2);
  });

  it('returns source anchor for each section', () => {
    const result = parseDocument('Hello', { path: 'doc.txt' });
    expect(result.sections[0].source).toBe('doc.txt');
  });

  it('parses markdown by headers', () => {
    const md = '## Intro\nHello\n## Body\nWorld';
    const result = parseDocument(md, { path: 'doc.md', format: 'md' });
    expect(result.sections.length).toBe(2);
    expect(result.sections[0].text).toContain('Intro');
  });

  it('handles empty content', () => {
    const result = parseDocument('', { path: 'empty.txt' });
    expect(result.total_chars).toBe(0);
  });

  it('auto-detects format as txt when not specified', () => {
    const result = parseDocument('hello', { path: 'doc.txt' });
    expect(result.format).toBe('txt');
  });
});
