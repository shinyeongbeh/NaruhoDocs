# Centralized LLM Service

This document describes the new unified `LLMService` layer introduced to centralize all interactions with Large Language Models within NaruhoDocs.

## Goals

1. Single entry-point for every LLM request (chat, summarization, file reading, translation, analysis, doc generation, visualization context injection).
2. Easy future model/provider switching based on task type (e.g. faster model for summaries, higher-quality for generation).
3. Consistent system prompts and session reuse with cache keys.
4. Backward-compatible fallback to legacy `createChat()` if provider initialization fails.

## Location

`src/managers/LLMService.ts`

## Key Concepts

- `LLMService.getOrCreate(manager)` returns a singleton bound to the current `LLMProviderManager`.
- Sessions are cached by a logical key (e.g. thread id, `summarize:<docId>`, `translate:<lang>`).
- A `modelPolicy` map associates each task type with temperature and optional model hint (extensible later to actually pick different provider models).

## Supported Request Types

| Type | Description |
|------|-------------|
| `chat` | General conversational turns inside threads |
| `summarize` | Summarize large content blocks (docs, selections) |
| `read_files` | Provide overview / extraction across multiple files |
| `analyze` | Architecture / structural / focused analysis prompts |
| `translate` | Translation while preserving formatting |
| `generate_doc` | Rich documentation / markdown generation |
| `visualization_context` | Inject diagram/visualization context (stored via an ACK pattern) |

All requests implement the discriminated union `LLMRequest` and return an `LLMResponse` with a `type` and `content`.

## Basic Usage

```ts
import { LLMService } from './managers/LLMService';
import { LLMProviderManager } from './llm-providers/manager';

const service = LLMService.getOrCreate(llmProviderManager);

// Chat
const reply = await service.request({
  type: 'chat',
  sessionId: threadId,
  prompt: 'Explain this file structure briefly.'
});

// Summarize
const summary = await service.request({
  type: 'summarize',
  content: documentText,
  targetId: documentUri.toString()
});
```

## Session Reuse

`getSession(key, systemMessage, options)` returns or creates a `ChatSession`. Reuse reduces token usage and preserves conversation context. Use `forceNew: true` to discard previous context.

## Extending

1. Add a new literal to `LLMTaskType`.
2. Add interface describing the request payload.
3. Extend the `LLMRequest` union.
4. Implement a handler (`handleX`) and add a case in `request()` switch.
5. (Optional) Add a policy entry in `modelPolicy`.

## Migration Notes

Legacy direct calls to `llmManager.createChatSession()` or `createChat()` in new features should be replaced with `LLMService`. Existing code has been partially migrated (e.g. `ThreadManager`). Remaining places can be updated incrementally without breaking functionality.

## Overrides (Model & Temperature)

Each task type has a base policy (`modelPolicy`) declaring a default temperature and optional `modelHint`.
You can override per-session when calling `getSession()` using:

```ts
await service.getSession('my-key', 'System Prompt', {
  taskType: 'analyze',
  temperatureOverride: 0.15,
  modelOverride: 'gemini-2.0-flash'
});
```

Internally this flows through the provider's `createChatSession(systemMessage, { model, temperature })` so all providers (OOTB, BYOK, Local) honor it.

## Token / Rate Tracking

`LLMService` tracks daily (UTC) usage:

| Metric | Description |
|--------|-------------|
| `requests` | Number of handled LLM requests (all task types) |
| `estimatedInputTokens` | Heuristic tokens for prompts (chars / 4) |
| `estimatedOutputTokens` | Heuristic tokens for model responses |
| `perTask` | Map of counts by task type |

Retrieve via:

```ts
const stats = service.getStats();
```

User command: `NaruhoDocs: Show LLM Stats` (`naruhodocs.showLLMStats`).

The heuristic is intentionally lightweight; swap in provider-native token counters later if desired.

## Persistence

On activation, the extension calls `restoreState()`; on deactivation it calls `saveState()`. Stored keys:

| Storage Key | Purpose |
|-------------|---------|
| `llmService.sessionSnapshots` | Truncated recent history for each cached session (last ~12 messages) |
| `llmService.statsSnapshot` | Daily stats (only restored if same UTC day) |

Limitations:
- System message isn't yet directly rehydrated from sessions (pending richer `ChatSession` API). A fallback system message is injected if missing.
- History truncation prevents unbounded workspaceState growth.

## Configuration Change Handling

When LLM-related settings change (`naruhodocs.llm.*`), the extension:
1. Reinitializes the provider manager.
2. Clears all cached `LLMService` sessions (`clearAllSessions()`).
3. Updates the chat provider so new sessions use the updated provider/model.

## Adding New Task Types (Recap)
Follow the earlier Extending section; also add the new type to the stats initialization (per-task counts) and optionally to the persistence serializer (automatic if using the shared map).

## Future Improvements

- Provider-aware true token usage (replace heuristic with model API metadata).
- Optional soft/hard quota enforcement (warning banner when near limit).
- Pluggable tool registry keyed by task type.
- Richer session snapshot (explicit system message, temperature/model used, full message roles).
- Streaming support for large generation tasks.

## Testing

Planned coverage (some pending):

| Test Area | Status |
|-----------|--------|
| Session reuse & keying | Implemented |
| Request type routing | Implemented |
| Overrides (model / temperature) | Pending additional assertions |
| Token stats accumulation | Pending |
| Daily rollover | Pending |
| Persistence round-trip | Pending |
| Config change session reset | Pending |

Add/extend tests in `src/test/LLMService.test.ts` as new behaviors stabilize.

---
Questions or improvements: open an issue and tag with `llm-service`.
