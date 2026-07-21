/** Shared UI state types: loading, empty, error, success, approval. */
// @ts-nocheck

export type UiState = 'idle' | 'loading' | 'success' | 'error' | 'empty' | 'approval';

export interface UiResult<T> { state: UiState; data?: T | undefined; error?: string | undefined; approval_required?: boolean | undefined }
