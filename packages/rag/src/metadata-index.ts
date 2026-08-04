import type { RagChunk } from './types.js';

export class MetadataIndex {
  private readonly chunkMeta = new Map<string, RagChunk>();
  private readonly fieldIndex = new Map<string, Map<string, Set<string>>>();

  addChunk(chunk: RagChunk): void {
    this.chunkMeta.set(chunk.chunk_id, chunk);
    for (const [key, value] of Object.entries(chunk.metadata)) {
      if (!this.fieldIndex.has(key)) this.fieldIndex.set(key, new Map());
      const fieldMap = this.fieldIndex.get(key)!;
      const strValue = String(value);
      if (!fieldMap.has(strValue)) fieldMap.set(strValue, new Set());
      fieldMap.get(strValue)!.add(chunk.chunk_id);
    }
    // Also index source_hash and page
    this.indexField('source_hash', chunk.source_hash, chunk.chunk_id);
    if (chunk.page !== undefined) {
      this.indexField('page', String(chunk.page), chunk.chunk_id);
    }
  }

  removeChunk(chunkId: string): void {
    const chunk = this.chunkMeta.get(chunkId);
    if (!chunk) return;
    for (const [key, value] of Object.entries(chunk.metadata)) {
      const fieldMap = this.fieldIndex.get(key);
      if (fieldMap) {
        const set = fieldMap.get(String(value));
        if (set) {
          set.delete(chunkId);
          if (set.size === 0) fieldMap.delete(String(value));
        }
      }
    }
    this.chunkMeta.delete(chunkId);
  }

  filter(filters: Readonly<Record<string, unknown>>): Set<string> {
    let result: Set<string> | undefined;
    for (const [key, value] of Object.entries(filters)) {
      const fieldMap = this.fieldIndex.get(key);
      const matching = fieldMap?.get(String(value)) ?? new Set<string>();
      if (result === undefined) {
        result = new Set(matching);
      } else {
        result = new Set([...result].filter(id => matching.has(id)));
      }
    }
    return result ?? new Set(this.chunkMeta.keys());
  }

  getChunk(chunkId: string): RagChunk | undefined {
    return this.chunkMeta.get(chunkId);
  }

  getChunkIds(): readonly string[] {
    return [...this.chunkMeta.keys()];
  }

  private indexField(field: string, value: string, chunkId: string): void {
    if (!this.fieldIndex.has(field)) this.fieldIndex.set(field, new Map());
    const fieldMap = this.fieldIndex.get(field)!;
    if (!fieldMap.has(value)) fieldMap.set(value, new Set());
    fieldMap.get(value)!.add(chunkId);
  }
}
