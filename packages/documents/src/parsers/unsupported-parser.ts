/**
 * Unsupported format handler — AH-DOC-INGEST-UNSUPPORTED-001.
 *
 * Returns a typed DocumentIngestError for any format that no registered
 * parser can handle. Never returns a success result.
 */
import type { DocumentFormat, DocumentIngestOptions, DocumentIngestResult, DocumentParser } from '../types.js';
import { DocumentIngestError } from '../types.js';

const PARSER_VERSION = '1.0.0';
const PARSER_NAME = 'unsupported-handler';

export class UnsupportedParser implements DocumentParser {
  readonly format: DocumentFormat = 'unsupported';
  readonly version = PARSER_VERSION;
  readonly name = PARSER_NAME;

  canHandle(format: DocumentFormat): boolean {
    return format === 'unsupported';
  }

  async parse(
    _content: Buffer,
    source_path: string,
    _options: DocumentIngestOptions,
  ): Promise<DocumentIngestResult> {
    throw new DocumentIngestError(
      `unsupported document format for path: ${source_path}`,
      'unsupported',
    );
  }
}
