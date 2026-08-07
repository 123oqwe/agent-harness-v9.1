import { describe, expect, it, beforeEach } from 'vitest';
import { storeArtifact, retrieveArtifact, listArtifacts, deleteArtifact, getArtifactCount, clearAllArtifacts } from '../../../packages/multimodal/src/artifact-store.js';
import { createArtifact, computeContentHash } from '../../../packages/multimodal/src/types.js';
import { Buffer } from 'node:buffer';

describe('AH-MM-ARTIFACT-001: Store multimodal artifacts with provenance', () => {
  beforeEach(() => clearAllArtifacts());

  it('stores and retrieves artifacts', () => {
    const data = Buffer.from('test-image-data');
    const artifact = createArtifact('image', 'image/png', data, { source: 'generated' });
    storeArtifact(artifact, data);
    const retrieved = retrieveArtifact(artifact.artifact_id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.artifact.content_hash).toBe(artifact.content_hash);
  });

  it('lists artifacts by type', () => {
    const data1 = Buffer.from('list-image');
    const data2 = Buffer.from('list-audio');
    const a1 = createArtifact('image', 'image/png', data1, { source: 'generated' });
    const a2 = createArtifact('audio', 'audio/wav', data2, { source: 'input' });
    storeArtifact(a1, data1);
    storeArtifact(a2, data2);
    const images = listArtifacts('image');
    expect(images.some(a => a.artifact_id === a1.artifact_id)).toBe(true);
    expect(images.every(a => a.type === 'image')).toBe(true);
    const audios = listArtifacts('audio');
    expect(audios.some(a => a.artifact_id === a2.artifact_id)).toBe(true);
  });

  it('lists all artifacts when no type filter', () => {
    const d1 = Buffer.from('all-1');
    const d2 = Buffer.from('all-2');
    storeArtifact(createArtifact('image', 'image/png', d1, { source: 'generated' }), d1);
    storeArtifact(createArtifact('audio', 'audio/wav', d2, { source: 'input' }), d2);
    const all = listArtifacts();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it('deletes artifacts', () => {
    const data = Buffer.from('delete-test');
    const artifact = createArtifact('image', 'image/png', data, { source: 'generated' });
    storeArtifact(artifact, data);
    expect(deleteArtifact(artifact.artifact_id)).toBe(true);
    expect(retrieveArtifact(artifact.artifact_id)).toBeUndefined();
  });

  it('returns false when deleting non-existent artifact', () => {
    expect(deleteArtifact('nonexistent-id-12345')).toBe(false);
  });

  it('returns undefined when retrieving non-existent artifact', () => {
    expect(retrieveArtifact('missing-id-67890')).toBeUndefined();
  });

  it('records provenance', () => {
    const data = Buffer.from('prov-test');
    const artifact = createArtifact('image', 'image/png', data, {
      source: 'edited',
      generator: 'test-generator',
      input_artifacts: ['input-1'],
    });
    expect(artifact.provenance.source).toBe('edited');
    expect(artifact.provenance.generator).toBe('test-generator');
    expect(artifact.provenance.input_artifacts).toEqual(['input-1']);
  });

  it('computes correct content hash', () => {
    const data = Buffer.from('hash-verify');
    const artifact = createArtifact('image', 'image/png', data, { source: 'generated' });
    expect(artifact.content_hash).toBe(computeContentHash(data));
    expect(artifact.byte_size).toBe(data.length);
  });

  it('prevents mutation of stored data via retrieval copy', () => {
    const data = Buffer.from('immutable-test');
    const artifact = createArtifact('image', 'image/png', data, { source: 'generated' });
    storeArtifact(artifact, data);
    const retrieved1 = retrieveArtifact(artifact.artifact_id);
    retrieved1!.data.write('X', 0);
    const retrieved2 = retrieveArtifact(artifact.artifact_id);
    expect(retrieved2!.data.toString()).not.toContain('X');
  });

  it('overwrites existing artifact when same ID is stored again', () => {
    const data = Buffer.from('same-data');
    const artifact = createArtifact('image', 'image/png', data, { source: 'generated' });
    storeArtifact(artifact, data);
    // Store again with same artifact_id (same data -> same hash)
    const artifact2 = createArtifact('image', 'image/png', data, { source: 'edited' });
    storeArtifact(artifact2, data);
    const retrieved = retrieveArtifact(artifact.artifact_id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.artifact.provenance.source).toBe('edited');
    expect(getArtifactCount()).toBe(1);
  });

  it('tracks artifact count correctly', () => {
    expect(getArtifactCount()).toBe(0);
    const d = Buffer.from('count-test');
    const a = createArtifact('image', 'image/png', d, { source: 'generated' });
    storeArtifact(a, d);
    expect(getArtifactCount()).toBe(1);
    deleteArtifact(a.artifact_id);
    expect(getArtifactCount()).toBe(0);
  });

  it('clears all artifacts', () => {
    const d = Buffer.from('clear-test');
    storeArtifact(createArtifact('image', 'image/png', d, { source: 'generated' }), d);
    clearAllArtifacts();
    expect(getArtifactCount()).toBe(0);
    expect(listArtifacts().length).toBe(0);
  });
});
