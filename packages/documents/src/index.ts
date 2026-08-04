export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/documents",
  path: "packages/documents",
} as const);

export interface DocumentPackagePort {
  readonly workspace: typeof workspaceIdentity.name;
}

export type {
  DocumentFormat,
  DocumentIngestOptions,
  DocumentIngestResult,
  DocumentParser,
  HeadingNode,
  ImageReference,
  PageReference,
  SourceProvenance,
  TableNode,
} from './types.js';

export { DocumentIngestError } from './types.js';

export {
  DefaultDocumentIngestor,
  type DocumentIngestor,
} from './ingestor.js';

export { MarkdownParser } from './parsers/markdown-parser.js';
export { DocxParser } from './parsers/docx-parser.js';
export { PdfParser } from './parsers/pdf-parser.js';
export { HtmlParser } from './parsers/html-parser.js';
export { PptxParser } from './parsers/pptx-parser.js';
export { XlsxParser } from './parsers/xlsx-parser.js';
export { ImageParser } from './parsers/image-parser.js';
export { UnsupportedParser } from './parsers/unsupported-parser.js';
export { detectFormat } from './parsers/markdown-parser.js';
