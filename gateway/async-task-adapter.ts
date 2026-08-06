import type { GatewayProviderRuntime, ProviderDispatchContext } from './model-gateway.js';
import type {
  ProviderRequest, ParsedResponse, Usage, ToolCall,
  HealthStatus, DataPolicyResult, ProviderError, StreamEvent,
} from './scripted-provider.js';
import type { ModelBinding } from './capability-registry.js';
import type { KeyVault } from './key-vault.js';

export interface AsyncTaskConfig {
  submitEndpoint: string;
  pollEndpoint: (taskId: string) => string;
  pollIntervalMs: number;
  maxPollAttempts: number;
  buildSubmitBody: (binding: ModelBinding, request: ProviderRequest) => Record<string, unknown>;
  parseTaskId: (raw: unknown) => string;
  parseTaskStatus: (raw: unknown) => { status: string; progress: number; videoUrl?: string; duration?: number };
}

function extractPrompt(request: ProviderRequest): string {
  const userMsg = request.messages.find(m => m.role === 'user');
  if (userMsg) return userMsg.content;
  return request.messages.map(m => m.content).join('\n');
}

function seedanceSubmitBody(binding: ModelBinding, request: ProviderRequest): Record<string, unknown> {
  const prompt = extractPrompt(request);
  return {
    model: binding.model_id,
    content: [{ type: 'text', text: prompt }],
    parameters: {
      resolution: '720p',
      duration: 5,
      fps: 30,
      aspect_ratio: '16:9',
    },
  };
}

function seedanceParseTaskId(raw: unknown): string {
  const data = raw as Record<string, unknown>;
  const id = data['id'] ?? data['task_id'];
  if (typeof id !== 'string' || id.length === 0) throw new Error('Seedance: no task_id in submit response');
  return id;
}

function seedanceParseTaskStatus(raw: unknown): { status: string; progress: number; videoUrl?: string; duration?: number } {
  const data = raw as Record<string, unknown>;
  const status = (data['status'] ?? data['task_status'] ?? 'unknown') as string;

  let progress = 0;
  if (status === 'queued') progress = 0;
  else if (status === 'running' || status === 'processing') {
    progress = typeof data['progress'] === 'number'
      ? data['progress']
      : typeof data['progress'] === 'string'
        ? parseInt(data['progress'], 10) || 50
        : 50;
  } else if (status === 'succeeded' || status === 'success') {
    progress = 100;
  } else if (status === 'failed' || status === 'error') {
    progress = 0;
  }

  let videoUrl: string | undefined;
  let duration: number | undefined;

  // Seedance returns content.video_url or content.url or content[0].url
  const content = data['content'] as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
  if (content) {
    if (Array.isArray(content)) {
      const first = content[0];
      if (first) {
        videoUrl = (first['video_url'] ?? first['url']) as string | undefined;
        duration = first['duration'] as number | undefined;
      }
    } else {
      videoUrl = (content['video_url'] ?? content['url']) as string | undefined;
      duration = content['duration'] as number | undefined;
    }
  }
  // Fallback: top-level video_url
  if (!videoUrl) videoUrl = data['video_url'] as string | undefined;
  if (!duration) duration = data['duration'] as number | undefined;

  return { status, progress, ...(videoUrl !== undefined ? { videoUrl } : {}), ...(duration !== undefined ? { duration } : {}) };
}

export function getSeedanceTaskConfig(binding: ModelBinding): AsyncTaskConfig {
  return {
    submitEndpoint: `${binding.api_base}/contents/generations/tasks`,
    pollEndpoint: (taskId: string) => `${binding.api_base}/contents/generations/tasks/${taskId}`,
    pollIntervalMs: 3000,
    maxPollAttempts: 200, // 10 min max at 3s intervals
    buildSubmitBody: seedanceSubmitBody,
    parseTaskId: seedanceParseTaskId,
    parseTaskStatus: seedanceParseTaskStatus,
  };
}

export function createAsyncTaskAdapter(
  binding: ModelBinding,
  keyVault: KeyVault,
): GatewayProviderRuntime {
  const config = getSeedanceTaskConfig(binding);
  const provider_type = 'openai' as const; // Seedance uses Bearer auth like OpenAI

  async function submitTask(request: ProviderRequest): Promise<string> {
    const key = keyVault.getKey(binding.provider);
    if (!key) throw new Error(`No API key for ${binding.provider}`);
    const body = config.buildSubmitBody(binding, request);
    const resp = await fetch(config.submitEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      if (resp.status === 429) throw new Error(`HTTP 429 rate limited (do not retry): ${errText.slice(0, 300)}`);
      throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 300)}`);
    }
    const raw = await resp.json();
    return config.parseTaskId(raw);
  }

  async function pollTask(taskId: string): Promise<{ status: string; progress: number; videoUrl?: string; duration?: number }> {
    const key = keyVault.getKey(binding.provider);
    if (!key) throw new Error(`No API key for ${binding.provider}`);
    const resp = await fetch(config.pollEndpoint(taskId), {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Poll HTTP ${resp.status}: ${errText.slice(0, 200)}`);
    }
    const raw = await resp.json();
    return config.parseTaskStatus(raw);
  }

  const adapter = {
    provider_type,

    normalizeRequest(request: ProviderRequest): unknown {
      return config.buildSubmitBody(binding, request);
    },

    async resolve(request: ProviderRequest, _context?: ProviderDispatchContext): Promise<unknown> {
      // Submit task
      const taskId = await submitTask(request);

      // Poll until completion
      for (let attempt = 0; attempt < config.maxPollAttempts; attempt++) {
        const result = await pollTask(taskId);

        if (result.status === 'succeeded' || result.status === 'success') {
          if (!result.videoUrl) throw new Error('Seedance: task succeeded but no video_url returned');
          return {
            id: taskId,
            status: 'succeeded',
            content: { video_url: result.videoUrl, ...(result.duration !== undefined ? { duration: result.duration } : {}) },
            video_url: result.videoUrl,
            duration: result.duration,
          };
        }

        if (result.status === 'failed' || result.status === 'error') {
          throw new Error(`Seedance task ${taskId} failed`);
        }

        // Still running — wait and retry
        await new Promise<void>(r => setTimeout(r, config.pollIntervalMs));
      }

      throw new Error(`Seedance task ${taskId} timed out after ${config.maxPollAttempts * config.pollIntervalMs / 1000}s`);
    },

    parseResponse(raw: unknown): ParsedResponse {
      const data = raw as Record<string, unknown>;
      const videoUrl = (data['video_url'] ?? data['videoUrl']) as string | undefined;
      const duration = data['duration'] as number | undefined;
      const taskId = data['id'] as string | undefined;

      if (!videoUrl) throw new Error('Seedance: no video_url in completed task response');

      return {
        content: videoUrl,
        stop_reason: 'stop',
        usage: { input_tokens: 0, output_tokens: 0 },
        model: binding.model_id,
        ...(taskId !== undefined ? { task_id: taskId } : {}),
        task_status: 'succeeded',
        task_progress: 100,
        media_url: videoUrl,
        media_type: 'video' as const,
        ...(duration !== undefined ? { duration_seconds: duration } : {}),
      } as unknown as ParsedResponse;
    },

    normalizeToolCall(_raw: unknown): ToolCall {
      throw new Error('async_task providers do not support tool calls');
    },

    async *streamEvents(request: ProviderRequest): AsyncIterable<StreamEvent> {
      // Submit task
      const taskId = await submitTask(request);
      let lastProgress = -1;

      // Poll and yield progress events
      for (let attempt = 0; attempt < config.maxPollAttempts; attempt++) {
        const result = await pollTask(taskId);

        // Yield progress if changed
        if (result.progress !== lastProgress) {
          lastProgress = result.progress;
          yield { type: 'task_progress', progress: result.progress, task_id: taskId, status: result.status };
        }

        if (result.status === 'succeeded' || result.status === 'success') {
          if (!result.videoUrl) throw new Error('Seedance: task succeeded but no video_url');
          yield {
            type: 'media_complete',
            media_url: result.videoUrl,
            media_type: 'video' as const,
            ...(result.duration !== undefined ? { duration_seconds: result.duration } : {}),
            usage: { input_tokens: 0, output_tokens: 0 },
          };
          return;
        }

        if (result.status === 'failed' || result.status === 'error') {
          throw new Error(`Seedance task ${taskId} failed`);
        }

        await new Promise<void>(r => setTimeout(r, config.pollIntervalMs));
      }

      throw new Error(`Seedance task ${taskId} timed out`);
    },

    mapError(raw: unknown): ProviderError {
      if (raw instanceof Error) {
        const msg = raw.message;
        if (/401|auth|unauthorized/i.test(msg)) return { kind: 'auth', retryable: false, detail: msg };
        if (/429|rate/i.test(msg)) return { kind: 'rate_limited', retryable: false, detail: msg };
        if (/timeout|timed out/i.test(msg)) return { kind: 'timeout', retryable: true, detail: msg };
        if (/500|502|503|504|server/i.test(msg)) return { kind: 'server', retryable: true, detail: msg };
        if (/400|invalid/i.test(msg)) return { kind: 'invalid_request', retryable: false, detail: msg };
        if (/failed/i.test(msg)) return { kind: 'server', retryable: false, detail: msg };
        return { kind: 'unknown', retryable: false, detail: msg };
      }
      return { kind: 'unknown', retryable: false, detail: String(raw) };
    },

    meterUsage(_response: ParsedResponse): Usage {
      return { input_tokens: 0, output_tokens: 0 };
    },

    checkHealth(): HealthStatus {
      return keyVault.hasProvider(binding.provider) ? 'healthy' : 'down';
    },

    validateDataPolicy(_request: ProviderRequest): DataPolicyResult {
      return { allowed: true };
    },
  };

  return adapter as unknown as GatewayProviderRuntime;
}
