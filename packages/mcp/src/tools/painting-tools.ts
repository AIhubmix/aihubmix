import { Tool } from '../types/index.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import fetch from 'node-fetch';
import {
  aihubmixMediaRegistry,
  buildVideoRequest,
  normalizeVideoResponse,
} from '@aihubmix/media-adapters';

// ─── Shared config ──────────────────────────────────────────────────────────

/** Base origin (no trailing slash, no `/v1`). Configurable via AIHUBMIX_BASE_URL. */
function getBaseUrl(): string {
  return (process.env.AIHUBMIX_BASE_URL?.trim() || 'https://aihubmix.com').replace(/\/+$/, '');
}

function requireApiKey(): string {
  const apiKey = process.env.AIHUBMIX_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new McpError(
      ErrorCode.InternalError,
      'AIHUBMIX_API_KEY environment variable is required. Please set your API key.'
    );
  }
  return apiKey.trim();
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function urlToInlineData(url: string): Promise<{ mimeType: string; data: string }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new McpError(ErrorCode.InternalError, `Failed to fetch reference image: ${response.status}`);
  }
  // content-type may carry params (e.g. "image/png; charset=utf-8") — keep only the media type.
  const mimeType = (response.headers.get('content-type') || 'image/png').split(';')[0].trim();
  const arrayBuffer = await response.arrayBuffer();
  const data = Buffer.from(arrayBuffer).toString('base64');
  return { mimeType, data };
}

// ─── Image generation ─────────────────────────────────────────────────────────

type ImageModelDef = { apiModel: string; label: string };

// Keys are friendly aliases; apiModel is the upstream wire name used in the URL.
// Mirrors the enabled image models in the aihubmix-video reference project.
const IMAGE_MODELS: Record<string, ImageModelDef> = {
  'nano-banana-pro': { apiModel: 'gemini-3-pro-image-preview', label: 'Nano Banana Pro (Gemini 3 Pro)' },
  'nano-banana-2': { apiModel: 'gemini-3.1-flash-image-preview', label: 'Nano Banana 2 (Gemini 3.1 Flash)' },
  'gpt-image-1.5': { apiModel: 'openai/gpt-image-1.5', label: 'GPT Image 1.5' },
  'gpt-image-1': { apiModel: 'openai/gpt-image-1', label: 'GPT Image 1' },
  'gpt-image-1-mini': { apiModel: 'openai/gpt-image-1-mini', label: 'GPT Image 1 Mini' },
  'dall-e-3': { apiModel: 'openai/dall-e-3', label: 'DALL·E 3' },
  'imagen-4.0-ultra': { apiModel: 'google/imagen-4.0-ultra-generate-001', label: 'Imagen 4.0 Ultra' },
  'imagen-4.0': { apiModel: 'google/imagen-4.0-generate-001', label: 'Imagen 4.0' },
  'imagen-4.0-fast': { apiModel: 'google/imagen-4.0-fast-generate-001', label: 'Imagen 4.0 Fast' },
  'imagen-3.0': { apiModel: 'google/imagen-3.0-generate-002', label: 'Imagen 3.0' },
  'flux-2-pro': { apiModel: 'bfl/flux-2-pro', label: 'FLUX 2 Pro' },
  'flux-2-flex': { apiModel: 'bfl/flux-2-flex', label: 'FLUX 2 Flex' },
  'ideogram-v3': { apiModel: 'ideogram/V3', label: 'Ideogram V3' },
  'seedream-5.0-lite': { apiModel: 'doubao/doubao-seedream-5.0-lite', label: 'Doubao Seedream 5.0 Lite' },
  'seedream-4.5': { apiModel: 'doubao/doubao-seedream-4-5', label: 'Doubao Seedream 4.5' },
  'seedream-4.0': { apiModel: 'doubao/doubao-seedream-4-0', label: 'Doubao Seedream 4.0' },
  'wan2.7-image-pro': { apiModel: 'bailian/wan2.7-image-pro', label: 'Wan 2.7 Image Pro' },
  'wan2.7-image': { apiModel: 'bailian/wan2.7-image', label: 'Wan 2.7 Image' },
  'wan2.6-image': { apiModel: 'bailian/wan2.6-t2i', label: 'Wan 2.6 Image' },
  'qwen-image-2.0-pro': { apiModel: 'bailian/qwen-image-2.0-pro', label: 'Qwen Image 2.0 Pro' },
  'qwen-image-2.0': { apiModel: 'bailian/qwen-image-2.0', label: 'Qwen Image 2.0' },
  'qwen-image-max': { apiModel: 'bailian/qwen-image-max', label: 'Qwen Image Max' },
  'qwen-image': { apiModel: 'qianfan/qwen-image', label: 'Qwen Image' },
};

type ImageFamily =
  | 'gemini-native'
  | 'openai'
  | 'imagen'
  | 'qwen'
  | 'doubao'
  | 'flux'
  | 'ideogram'
  | 'bailian'
  | 'generic';

// Ported from the aihubmix-video reference (lib/server/image/create-image.ts).
function getImageFamily(apiModel: string): ImageFamily {
  if (apiModel.startsWith('gemini-')) return 'gemini-native';
  if (apiModel.startsWith('openai/')) return 'openai';
  if (apiModel.startsWith('google/imagen-')) return 'imagen';
  if (apiModel.startsWith('bailian/')) return 'bailian';
  if (apiModel.startsWith('qianfan/qwen-')) return 'qwen';
  if (apiModel.startsWith('doubao/')) return 'doubao';
  if (apiModel.startsWith('bfl/') || apiModel.startsWith('FLUX')) return 'flux';
  if (apiModel.startsWith('ideogram/')) return 'ideogram';
  return 'generic';
}

function normalizeSize(size?: string): string | undefined {
  if (!size) return size;
  return size.replace(/×/g, 'x').replace(/\s+/g, '');
}

/**
 * Shape the `input` object for the predictions endpoint per model family.
 * Mirrors buildPredictionsInput() in the reference project.
 */
function buildPredictionsInput(args: any, apiModel: string): Record<string, unknown> {
  const family = getImageFamily(apiModel);
  const prompt = String(args.prompt ?? '').trim();
  const input: Record<string, unknown> = { prompt };
  const size = normalizeSize(args.size);
  const ref =
    typeof args.input_reference === 'string' && args.input_reference.trim()
      ? args.input_reference.trim()
      : undefined;

  switch (family) {
    case 'openai':
      if (size) input.size = size;
      if (args.n) input.n = args.n;
      if (args.quality) input.quality = args.quality;
      if (args.moderation && !ref) input.moderation = args.moderation;
      if (args.background) input.background = args.background;
      if (args.output_format) input.output_format = args.output_format;
      if (args.input_fidelity && ref) input.input_fidelity = args.input_fidelity;
      if (ref) input.image = ref;
      return input;

    case 'imagen':
      if (args.n) input.sampleCount = args.n;
      if (args.aspect_ratio) input.aspectRatio = args.aspect_ratio;
      return input;

    case 'qwen':
      if (size) input.size = size;
      if (args.n) input.n = args.n;
      if (typeof args.watermark === 'boolean') input.watermark = args.watermark;
      if (typeof args.seed === 'number') input.seed = args.seed;
      if (ref) input.image = ref;
      return input;

    case 'doubao':
      if (size) input.size = size;
      if (typeof args.watermark === 'boolean') input.watermark = args.watermark;
      if (typeof args.seed === 'number') input.seed = args.seed;
      if (args.response_format) input.response_format = args.response_format;
      if (ref) input.image = ref;
      return input;

    case 'flux':
      if (args.aspect_ratio) input.aspect_ratio = args.aspect_ratio;
      if (typeof args.seed === 'number') input.seed = args.seed;
      if (ref) input.input_image = ref;
      return input;

    case 'ideogram':
      if (args.rendering_speed) input.rendering_speed = args.rendering_speed;
      if (args.aspect_ratio) input.aspect_ratio = args.aspect_ratio;
      return input;

    case 'bailian': {
      // Sizes: shorthand (1K/2K/4K) pass as-is; WxH format converts to W*H.
      if (size) {
        const isShorthand = /^[1-9]\d*[Kk]$/.test(size);
        input.size = isShorthand ? size : size.replace(/x/gi, '*');
      }
      if (args.n) input.n = args.n;
      if (typeof args.seed === 'number') input.seed = args.seed;
      if (typeof args.watermark === 'boolean') input.watermark = args.watermark;
      if (typeof args.thinking_mode === 'boolean') input.thinking_mode = args.thinking_mode;
      if (typeof args.prompt_extend === 'boolean') input.prompt_extend = args.prompt_extend;
      if (args.negative_prompt) input.negative_prompt = args.negative_prompt;
      if (ref) input.images = [ref];
      return input;
    }

    default:
      if (size) input.size = size;
      if (args.aspect_ratio) input.aspect_ratio = args.aspect_ratio;
      if (args.quality) input.quality = args.quality;
      if (args.n) input.n = args.n;
      if (ref) input.image = ref;
      return input;
  }
}

// Poll a predictions-style polling URL until the task completes.
async function pollForCompletion(
  pollingUrl: string,
  apiKey: string,
  maxAttempts: number = 30
): Promise<any[]> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(pollingUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        const error: any = new Error(`Polling request failed with status ${response.status}`);
        // 4xx (auth/bad request) won't recover on retry — fail immediately.
        if (response.status >= 400 && response.status < 500) error.fatal = true;
        throw error;
      }

      const data = (await response.json()) as any;

      if (data.status === 'succeeded' || data.status === 'completed' || data.status === 'Ready') {
        return extractImageContents(data);
      } else if (data.status === 'failed') {
        const error: any = new Error(`Task failed: ${data.error || 'Unknown error'}`);
        error.fatal = true; // terminal state — do not retry
        throw error;
      }

      await sleep(2000);
    } catch (error: any) {
      if (attempt === maxAttempts - 1 || error?.fatal) {
        throw error;
      }
      await sleep(2000);
    }
  }

  return [];
}

// Extract MCP content items (base64 images + URLs) from an image API response.
function extractImageContents(data: any): any[] {
  const contents: any[] = [];
  const seen = new Set<string>();
  const addImage = (b64: string, mimeType = 'image/png') => {
    if (b64 && !seen.has(b64)) {
      seen.add(b64);
      contents.push({ type: 'image', data: b64, mimeType });
    }
  };
  const addUrl = (url: string) => {
    if (url && !seen.has(url)) {
      seen.add(url);
      contents.push({ type: 'text', text: url });
    }
  };
  const isHttpUrl = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\//.test(v);

  // Gemini-native inline image parts
  const geminiParts = [
    ...(data?.candidates || []).flatMap((c: any) => c?.content?.parts || []),
    ...(data?.response?.parts || data?.parts || []),
  ];
  for (const part of geminiParts) {
    const inline = part?.inlineData || part?.inline_data;
    if (inline && typeof inline.data === 'string') {
      addImage(inline.data, inline.mimeType || inline.mime_type || 'image/png');
    }
  }

  // OpenAI-style: data: [{ url } | { b64_json } | "https://..."]
  if (Array.isArray(data?.data)) {
    for (const item of data.data) {
      if (isHttpUrl(item)) addUrl(item);
      else if (isHttpUrl(item?.url)) addUrl(item.url);
      else if (typeof item?.b64_json === 'string') addImage(item.b64_json);
    }
  }

  // Predictions-style: output as array or object
  const out = data?.output;
  if (Array.isArray(out)) {
    for (const item of out) {
      if (isHttpUrl(item)) addUrl(item);
      else if (isHttpUrl(item?.url)) addUrl(item.url);
      else if (typeof item?.bytesBase64 === 'string') addImage(item.bytesBase64);
    }
  }
  if (Array.isArray(out?.b64_json)) {
    for (const item of out.b64_json) {
      if (typeof item?.bytesBase64 === 'string') addImage(item.bytesBase64);
    }
  }
  if (Array.isArray(out?.urls)) {
    for (const url of out.urls) if (typeof url === 'string') addUrl(url);
  }
  if (isHttpUrl(out?.url)) addUrl(out.url);
  if (isHttpUrl(data?.url)) addUrl(data.url);
  if (isHttpUrl(data?.image_url)) addUrl(data.image_url);

  // images: [{ url } | { b64_json } | "https://..."]
  if (Array.isArray(data?.images)) {
    for (const item of data.images) {
      if (isHttpUrl(item)) addUrl(item);
      else if (isHttpUrl(item?.url)) addUrl(item.url);
      else if (typeof item?.b64_json === 'string') addImage(item.b64_json);
    }
  }

  return contents;
}

async function performJsonRequest(apiKey: string, url: string, body: Record<string, unknown>): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  });

  if (response.status === 401 || response.status === 403) {
    throw new McpError(ErrorCode.InternalError, 'Invalid API Key.');
  }
  if (!response.ok) {
    const errorText = await response.text();
    throw new McpError(
      ErrorCode.InternalError,
      `API request failed with status ${response.status}: ${errorText}`
    );
  }
  return response.json();
}

async function createGeminiNativeImage(apiKey: string, apiModel: string, args: any): Promise<any> {
  const baseUrl = getBaseUrl();
  const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [
    { role: 'user', parts: [{ text: String(args.prompt || '') }] },
  ];

  if (typeof args.input_reference === 'string' && args.input_reference.trim()) {
    const inline = await urlToInlineData(args.input_reference.trim());
    contents[0].parts.push({ inlineData: { mimeType: inline.mimeType, data: inline.data } });
  }

  const size = normalizeSize(args.size);
  const body = {
    contents,
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        ...(args.aspect_ratio ? { aspectRatio: args.aspect_ratio } : {}),
        ...(size ? { imageSize: size } : {}),
      },
    },
    ...(args.google_search ? { tools: [{ googleSearch: {} }] } : {}),
  };

  const response = await fetch(`${baseUrl}/gemini/v1beta/models/${apiModel}:generateContent`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  });

  if (response.status === 401 || response.status === 403) {
    throw new McpError(ErrorCode.InternalError, 'Invalid API Key.');
  }
  if (!response.ok) {
    const errorText = await response.text();
    throw new McpError(
      ErrorCode.InternalError,
      `API request failed with status ${response.status}: ${errorText}`
    );
  }
  return response.json();
}

// ─── Video generation ─────────────────────────────────────────────────────────

// Friendly key → registry id (upstream apiModel) from @aihubmix/media-adapters.
const VIDEO_MODELS: Record<string, string> = {
  'seedance-2.0': 'doubao-seedance-2-0-260128',
  'seedance-2.0-fast': 'doubao-seedance-2-0-fast-260128',
  'wan-2.7': 'wan2.7-t2v',
  'wan-2.6': 'wan2.6-t2v',
  'wan-2.5': 'wan2.5-t2v-preview',
  'sora-2': 'sora-2',
  'sora-2-pro': 'sora-2-pro',
  'jimeng-3.0-pro': 'jimeng-3.0-pro',
  'jimeng-3.0': 'jimeng-3.0-1080p',
};

const TERMINAL_DONE = ['completed', 'complete', 'succeeded', 'success', 'done', 'finished'];
const TERMINAL_FAILED = ['failed', 'error', 'cancelled', 'canceled', 'rejected'];

// ─── Tool definitions ─────────────────────────────────────────────────────────

export const paintingTools: Record<string, Tool> = {
  image_generate: {
    description:
      'Generate images with AIHubMix. Models: nano-banana-pro / nano-banana-2 (Google Gemini native, aspect_ratio + size 1K/2K/4K, google_search); ' +
      'gpt-image-1.5 / gpt-image-1 / gpt-image-1-mini / dall-e-3 (OpenAI, size + n + quality + background + output_format); ' +
      'imagen-4.0-ultra / imagen-4.0 / imagen-4.0-fast / imagen-3.0 (Google Imagen, aspect_ratio + n); ' +
      'flux-2-pro / flux-2-flex (Black Forest Labs, aspect_ratio + seed); ideogram-v3 (rendering_speed + aspect_ratio); ' +
      'seedream-5.0-lite / seedream-4.5 / seedream-4.0 (Doubao, size 1K/2K/4K + watermark + seed); ' +
      'wan2.7-image-pro / wan2.7-image / wan2.6-image (Alibaba Wan, size + aspect_ratio + n + seed + thinking_mode + prompt_extend + negative_prompt); ' +
      'qwen-image-2.0-pro / qwen-image-2.0 / qwen-image-max / qwen-image (Alibaba Qwen, size + n + seed). ' +
      'Pass an optional input_reference (image URL) for image-to-image on models that support it.',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          enum: Object.keys(IMAGE_MODELS),
          default: 'nano-banana-pro',
          description: 'Image model to use',
        },
        prompt: { type: 'string', description: 'Text prompt (all models)' },
        size: {
          type: 'string',
          description: 'Output size. OpenAI: 1024x1024/1024x1536/1536x1024/auto. Doubao/Wan: 1K/2K/4K or WxH. Qwen: WxH.',
        },
        aspect_ratio: {
          type: 'string',
          description: 'Aspect ratio, e.g. 1:1, 16:9, 9:16, 4:3, 3:4 (Gemini/Imagen/Flux/Ideogram/Wan)',
        },
        n: { type: 'integer', minimum: 1, maximum: 12, description: 'Number of images (OpenAI/Imagen/Qwen/Wan)' },
        quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'], description: 'Image quality (OpenAI)' },
        moderation: { type: 'string', enum: ['auto', 'low'], description: 'Content moderation (OpenAI)' },
        background: { type: 'string', enum: ['transparent', 'opaque', 'auto'], description: 'Background (OpenAI)' },
        output_format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Output format (OpenAI)' },
        input_fidelity: { type: 'string', enum: ['low', 'high'], description: 'Fidelity to reference (OpenAI edits)' },
        response_format: { type: 'string', enum: ['url', 'base64_json'], description: 'Response format (Doubao)' },
        rendering_speed: { type: 'string', enum: ['QUALITY', 'SPEED'], description: 'Rendering speed (Ideogram)' },
        negative_prompt: { type: 'string', description: 'Negative prompt (Wan/Qwen bailian)' },
        prompt_extend: { type: 'boolean', description: 'Automatic prompt rewriting (Wan/Qwen bailian)' },
        thinking_mode: { type: 'boolean', description: 'Thinking mode (Wan 2.7 series)' },
        google_search: { type: 'boolean', description: 'Google Search grounding (Gemini native)' },
        watermark: { type: 'boolean', description: 'Add watermark (Doubao/Wan/Qwen)' },
        seed: { type: 'integer', description: 'Random seed for reproducibility' },
        input_reference: { type: 'string', description: 'Reference image URL for image-to-image (supported models only)' },
      },
      required: ['prompt', 'model'],
    },
    async execute(args: any): Promise<any> {
      const apiKey = requireApiKey();
      const modelKey = args.model || 'nano-banana-pro';
      const def = IMAGE_MODELS[modelKey];
      if (!def) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unknown image model: ${modelKey}. Available: ${Object.keys(IMAGE_MODELS).join(', ')}`
        );
      }
      if (!args.prompt || typeof args.prompt !== 'string' || args.prompt.trim().length === 0) {
        throw new McpError(ErrorCode.InvalidParams, 'Prompt is required and must be a non-empty string');
      }

      const baseUrl = getBaseUrl();
      const family = getImageFamily(def.apiModel);

      try {
        const data =
          family === 'gemini-native'
            ? await createGeminiNativeImage(apiKey, def.apiModel, args)
            : await performJsonRequest(apiKey, `${baseUrl}/v1/models/${def.apiModel}/predictions`, {
                input: buildPredictionsInput(args, def.apiModel),
              });

        const contents = extractImageContents(data);

        // Async fallback: some models (e.g. FLUX 2) return a polling URL first.
        if (contents.length === 0) {
          const out = data?.output;
          const pollingUrl = Array.isArray(out)
            ? out.find((item: any) => item?.polling_url)?.polling_url
            : out?.polling_url;
          if (pollingUrl) {
            try {
              contents.push(...(await pollForCompletion(pollingUrl, apiKey)));
            } catch (error) {
              contents.push({
                type: 'text',
                text: `Polling URL: ${pollingUrl} (Error: ${error instanceof Error ? error.message : String(error)})`,
              });
            }
          }
        }

        if (contents.length === 0) {
          const taskId = data?.id;
          contents.push({
            type: 'text',
            text: taskId
              ? `Task submitted (status: ${data?.status || 'unknown'}). Task ID: ${taskId}`
              : `No image found in response: ${JSON.stringify(data).slice(0, 500)}`,
          });
        }

        return { content: contents, isError: false };
      } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(
          ErrorCode.InternalError,
          `Unexpected error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  },

  video_generate: {
    description:
      'Generate videos with AIHubMix (async: submits a task then polls until ready). Models: ' +
      'seedance-2.0 / seedance-2.0-fast (ByteDance SeeDance, 4-15s, resolution 480p/720p, aspect_ratio, watermark, seed, camera_fixed, generate_audio, image-to-video); ' +
      'wan-2.7 / wan-2.6 / wan-2.5 (Alibaba Wan, size WxH; wan-2.6/2.5 support image-to-video); ' +
      'sora-2 / sora-2-pro (OpenAI Sora, 4/8/12s, size 720x1280…1792x1024, image-to-video); ' +
      'jimeng-3.0-pro / jimeng-3.0 (ByteDance Jimeng, 5/10s, image-to-video). ' +
      'Returns the task id, status, and an authenticated download URL. Generation can take several minutes.',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          enum: Object.keys(VIDEO_MODELS),
          default: 'seedance-2.0',
          description: 'Video model to use',
        },
        prompt: { type: 'string', description: 'Text prompt describing the video' },
        seconds: { type: 'integer', description: 'Duration in seconds (snapped to the model’s supported range)' },
        size: { type: 'string', description: 'Pixel size WxH (Sora/Wan/Jimeng), e.g. 1280x720' },
        aspect_ratio: { type: 'string', description: 'Aspect ratio, e.g. 16:9, 9:16 (SeeDance ratio)' },
        resolution: { type: 'string', enum: ['480p', '720p', '1080p'], description: 'Resolution token (SeeDance)' },
        watermark: { type: 'boolean', description: 'Add watermark (SeeDance)' },
        seed: { type: 'integer', description: 'Random seed (SeeDance)' },
        camera_fixed: { type: 'boolean', description: 'Fix the camera (SeeDance)' },
        generate_audio: { type: 'boolean', description: 'Generate audio track (SeeDance)' },
        input_reference: { type: 'string', description: 'Reference image URL for image-to-video (supported models only)' },
      },
      required: ['prompt', 'model'],
    },
    async execute(args: any): Promise<any> {
      const apiKey = requireApiKey();
      const modelKey = args.model;
      const registryId = VIDEO_MODELS[modelKey];
      if (!registryId) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unknown video model: ${modelKey}. Available: ${Object.keys(VIDEO_MODELS).join(', ')}`
        );
      }
      if (!args.prompt || typeof args.prompt !== 'string' || args.prompt.trim().length === 0) {
        throw new McpError(ErrorCode.InvalidParams, 'Prompt is required and must be a non-empty string');
      }

      const cap = aihubmixMediaRegistry.get(registryId);
      if (!cap) {
        throw new McpError(ErrorCode.InternalError, `Video model not found in registry: ${registryId}`);
      }

      const baseUrl = getBaseUrl();
      const apiBase = `${baseUrl}/v1`;

      // Optional image-to-video: fetch the reference URL to a data URL.
      let imageRef: { dataUrl: string } | undefined;
      if (typeof args.input_reference === 'string' && args.input_reference.trim()) {
        if (!cap.caps.includes('i2v') && !cap.apiModelI2V) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `${cap.label || modelKey} does not support input_reference (image-to-video)`
          );
        }
        const inline = await urlToInlineData(args.input_reference.trim());
        imageRef = { dataUrl: `data:${inline.mimeType};base64,${inline.data}` };
      }

      const built = buildVideoRequest(cap, {
        prompt: args.prompt.trim(),
        ...(typeof args.seconds === 'number' ? { durationSeconds: args.seconds } : {}),
        ...(args.aspect_ratio ? { aspectRatio: args.aspect_ratio } : {}),
        ...(args.size ? { size: args.size } : {}),
        ...(args.resolution ? { resolution: args.resolution } : {}),
        ...(typeof args.watermark === 'boolean' ? { watermark: args.watermark } : {}),
        ...(typeof args.seed === 'number' ? { seed: args.seed } : {}),
        ...(typeof args.camera_fixed === 'boolean' ? { cameraFixed: args.camera_fixed } : {}),
        ...(typeof args.generate_audio === 'boolean' ? { generateAudio: args.generate_audio } : {}),
        ...(imageRef ? { imageRef } : {}),
      });

      try {
        // Submit
        const submitResponse = await fetch(`${apiBase}${built.pathSuffix}`, {
          method: 'POST',
          headers: authHeaders(apiKey),
          body: JSON.stringify(built.body),
        });
        if (submitResponse.status === 401 || submitResponse.status === 403) {
          throw new McpError(ErrorCode.InternalError, 'Invalid API Key.');
        }
        if (!submitResponse.ok) {
          const errorText = await submitResponse.text();
          throw new McpError(
            ErrorCode.InternalError,
            `Video request failed with status ${submitResponse.status}: ${errorText}`
          );
        }

        let last = normalizeVideoResponse(await submitResponse.json());
        const taskId = last.id;
        if (!taskId) {
          throw new McpError(ErrorCode.InternalError, 'No task ID in video submit response');
        }

        // Poll until terminal or timeout
        const timeoutMs = Number(process.env.AIHUBMIX_VIDEO_POLL_TIMEOUT_MS) || 480000;
        const intervalMs = 3000;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const status = String(last.status || '').toLowerCase();
          if (TERMINAL_DONE.includes(status) || TERMINAL_FAILED.includes(status)) break;
          await sleep(intervalMs);
          try {
            const pollResponse = await fetch(`${apiBase}/videos/${taskId}`, {
              method: 'GET',
              headers: authHeaders(apiKey),
            });
            if (!pollResponse.ok) {
              // Auth errors won't recover — stop instead of polling until timeout.
              if (pollResponse.status === 401 || pollResponse.status === 403) {
                throw new McpError(ErrorCode.InternalError, 'Invalid API Key.');
              }
              continue; // transient — keep polling
            }
            last = normalizeVideoResponse(await pollResponse.json());
          } catch (error) {
            if (error instanceof McpError) throw error;
            // transient network error — keep polling
          }
        }

        const status = String(last.status || '').toLowerCase();
        const completed = TERMINAL_DONE.includes(status);
        const failed = TERMINAL_FAILED.includes(status);
        const contentUrl = `${apiBase}/videos/${taskId}/content`;

        const lines: string[] = [
          `Model: ${modelKey} (${built.wireModel})`,
          `Task ID: ${taskId}`,
          `Status: ${last.status || 'unknown'}`,
        ];
        if (completed) {
          if (last.url) lines.push(`Video URL: ${last.url}`);
          lines.push(`Download (send header "Authorization: Bearer <AIHUBMIX_API_KEY>"): ${contentUrl}`);
        } else if (failed) {
          lines.push(`Error: ${last.error || 'generation failed'}`);
        } else {
          lines.push(
            `Still processing after ${Math.round(timeoutMs / 1000)}s. Check status: GET ${apiBase}/videos/${taskId}`
          );
        }

        return { content: [{ type: 'text', text: lines.join('\n') }], isError: failed };
      } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(
          ErrorCode.InternalError,
          `Unexpected error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  },
};
