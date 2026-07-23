/* eslint-disable */
/** AUTO-GENERATED from spec/contracts/memory-record.schema.json. Do not modify by hand. */

export interface MemoryRecord {
  memory_id: string;
  type: "episodic" | "semantic" | "procedural" | "preference" | "relationship" | "goal";
  content: {
    [k: string]: unknown;
  };
  provenance: {
    [k: string]: unknown;
  };
  created_at: string;
  ttl: string;
  trust_level: "untrusted" | "verified" | "trusted";
}
