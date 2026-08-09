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


  it('handles multiple images in same document', async () => {
    const md = '![First](img1.png)\n![Second](img2.png)\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'multi.md', {});
    expect(result.images).toHaveLength(2);
    expect(result.images[0]!.ref).toBe('img1.png');
    expect(result.images[1]!.ref).toBe('img2.png');
  });

  it('handles image with URL reference', async () => {
    const md = '![Logo](https://example.com/logo.png)\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'url.md', {});
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.ref).toContain('https://');
  });

  it('handles image with special characters in alt text', async () => {
    const md = '![Alt @special #chars](img.png)\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'special.md', {});
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.alt).toContain('@special');
  });

  it('handles image with Unicode alt text', async () => {
    const md = '![图片说明](image.png)\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'unicode.md', {});
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.alt).toBe('图片说明');
  });

  it('handles images with relative paths', async () => {
    const md = '![Alt](../images/photo.png)\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'relative.md', {});
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.ref).toContain('images');
  });

  it('handles images with absolute paths', async () => {
    const md = '![Alt](/usr/share/images/photo.png)\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'absolute.md', {});
    expect(result.images).toHaveLength(1);
  });

  it('handles images with special file extensions', async () => {
    const md = '![Alt](photo.jpeg)\n![Alt2](animation.gif)\n![Alt3](icon.svg)\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'extensions.md', {});
    expect(result.images).toHaveLength(3);
  });


  it('handles image with title attribute', async () => {
    const md = '![Alt](image.png "Title text")\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'title.md', {});
    expect(result.images).toHaveLength(1);
  });

  it('handles image with spaces in path', async () => {
    const md = '![Alt](path with spaces/image.png)\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'spaces.md', {});
    expect(result.images).toHaveLength(1);
  });

  it('handles image at start of document', async () => {
    const md = '![Start](start.png)\nText after.\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'start.md', {});
    expect(result.images).toHaveLength(1);
  });

  it('handles image at end of document', async () => {
    const md = 'Text before.\n![End](end.png)\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'end.md', {});
    expect(result.images).toHaveLength(1);
  });

  it('handles image with data URI', async () => {
    const md = '![Alt](data:image/png;base64,iVBOR)\n';
    const result = await parser.parse(Buffer.from(md, 'utf8'), 'datauri.md', {});
    expect(result.images).toHaveLength(1);
  });

});
