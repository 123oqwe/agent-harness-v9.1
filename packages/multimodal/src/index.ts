export const workspaceIdentity = Object.freeze({
  name: "@agent-harness/multimodal",
  path: "packages/multimodal",
} as const);

export interface MultimodalPackagePort {
  readonly workspace: typeof workspaceIdentity.name;
}

export type { MultimodalArtifact, MultimodalProvenance } from './types.js';
export { MultimodalUnavailableError, createArtifact, computeContentHash } from './types.js';

export { generateImage, type ImageGenInput } from './image-gen.js';
export { editImage, type ImageEditInput } from './image-edit.js';
export { understandImage, verifyGeneratedContent, type VisionInput } from './vision.js';
export { generateSpeech, transcribeAudio, type SpeechGenInput, type TranscribeInput } from './speech.js';
export { storeArtifact, retrieveArtifact, listArtifacts, deleteArtifact, getArtifactCount } from './artifact-store.js';
