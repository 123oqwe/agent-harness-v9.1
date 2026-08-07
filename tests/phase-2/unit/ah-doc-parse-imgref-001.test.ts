import { describe, expect, it } from 'vitest';
import { MarkdownParser } from '../../../packages/documents/src/index.js';

describe('AH-DOC-PARSE-IMGREF-001: Parse image references with provenance', () => {
  const parser = new MarkdownParser();

  it('parses markdown image syntax with alt and ref', async () => {
    const md = '![Alt text](path/to/image.png)\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'test.md', {});
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.alt).toBe('Alt text');
    expect(result.images[0]!.ref).toBe('path/to/image.png');
  });

  it('handles empty alt text', async () => {
    const md = '![](image.jpg)\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'test.md', {});
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.alt).toBe('');
  });

  it('handles multiple images', async () => {
    const md = '![First](a.png)\n![Second](b.png)\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'test.md', {});
    expect(result.images).toHaveLength(2);
    expect(result.images[0]!.alt).toBe('First');
    expect(result.images[1]!.alt).toBe('Second');
  });

  it('records source_path for each image', async () => {
    const md = '![Test](images/test.png)\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'doc.md', {});
    expect(result.images[0]!.source_path).toBe('images/test.png');
  });

  it('handles URLs as image references', async () => {
    const md = '![Logo](https://example.com/logo.png)\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'test.md', {});
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.ref).toBe('https://example.com/logo.png');
  });

  it('handles images with title attribute', async () => {
    const md = '![Alt](image.png "Title")\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'test.md', {});
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.alt).toBe('Alt');
  });

  it('handles no images in content', async () => {
    const md = '# Heading\n\nSome text without images.\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'test.md', {});
    expect(result.images).toHaveLength(0);
  });
  it('handles images with special characters in alt text', async () => {
    const md = '![Alt with @#$%^&*](image.png)\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'test.md', {});
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.alt).toContain('Alt');
  });

  it('handles images with relative and absolute paths', async () => {
    const md = '![Rel](./images/a.png)\n![Abs](/abs/path/b.png)\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'test.md', {});
    expect(result.images).toHaveLength(2);
    expect(result.images[0]!.ref).toContain('images/a.png');
    expect(result.images[1]!.ref).toContain('/abs/path/b.png');
  });

});
