import { describe, expect, it } from 'vitest';
import { storeArtifact, retrieveArtifact, listArtifacts, deleteArtifact, createArtifact } from '../../../packages/multimodal/src/index.js';

describe('AH-MM-ARTIFACT-001: Store multimodal artifacts with provenance', () => {
  it('stores and retrieves artifacts', () => {
    const data = Buffer.from('test-image-data-' + Date.now());
    const artifact = createArtifact('image', 'image/png', data, { source: 'generated' });
    storeArtifact(artifact, data);
    const retrieved = retrieveArtifact(artifact.artifact_id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.artifact.content_hash).toBe(artifact.content_hash);
  });

  it('lists artifacts by type', () => {
    const data1 = Buffer.from('list-image-' + Date.now());
    const data2 = Buffer.from('list-audio-' + Date.now());
    const a1 = createArtifact('image', 'image/png', data1, { source: 'generated' });
    const a2 = createArtifact('audio', 'audio/wav', data2, { source: 'input' });
    storeArtifact(a1, data1);
    storeArtifact(a2, data2);
    const images = listArtifacts('image');
    expect(images.some(a => a.artifact_id === a1.artifact_id)).toBe(true);
    const audios = listArtifacts('audio');
    expect(audios.some(a => a.artifact_id === a2.artifact_id)).toBe(true);
  });

  it('deletes artifacts', () => {
    const data = Buffer.from('delete-test-' + Date.now());
    const artifact = createArtifact('image', 'image/png', data, { source: 'generated' });
    storeArtifact(artifact, data);
    expect(deleteArtifact(artifact.artifact_id)).toBe(true);
    expect(retrieveArtifact(artifact.artifact_id)).toBeUndefined();
  });

  it('records provenance', () => {
    const data = Buffer.from('prov-test-' + Date.now());
    const artifact = createArtifact('image', 'image/png', data, {
      source: 'edited',
      generator: 'test-generator',
      input_artifacts: ['input-1'],
    });
    expect(artifact.provenance.source).toBe('edited');
    expect(artifact.provenance.generator).toBe('test-generator');
  });
});
