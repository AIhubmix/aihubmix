# @aihubmix/mcp

## 1.1.0

### Minor Changes

- Add `video_generate` tool (SeeDance, Wan, Sora, Jimeng via `@aihubmix/media-adapters`) and refresh `image_generate` with the current 23-model set (Gemini native, GPT Image, Imagen, FLUX 2, Ideogram, Doubao Seedream, Wan, Qwen) with per-family request params. Base URL is now configurable via `AIHUBMIX_BASE_URL`, and media polling fails fast on fatal/auth errors instead of retrying until timeout.

## 1.0.0

### Major Changes

- 26a72d3: add mcp
