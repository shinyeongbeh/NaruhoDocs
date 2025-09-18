# Verbose LLM Logging & Output Channel

## Overview
A configurable verbose logging system now provides transparent insight into every LLM request handled by the centralized `LLMService`. Logs are written to a dedicated VS Code Output Channel named `NaruhoDocs LLM` instead of using scattered `console.log` calls.

## Enabling
Set the VS Code setting:
- `naruhodocs.logging.verbose`: `true`

Settings Path: `File > Preferences > Settings > (search) NaruhoDocs`

Default value: `false` (no logs emitted).

## Log Line Format
Each request produces one structured line (wrapped if long):
```
[timestamp] task=<taskType> provider=<providerName> durationMs=<number> reqTokens≈<est> respTokens≈<est> totalTokens≈<est> session=<sessionId> status=ok
PROMPT: <truncated first N chars>
RESPONSE: <truncated first N chars>
```
Fields:
- `task`: One of `chat`, `summarize`, `translate`, `read_files`, `analyze`, `generate_doc`, `visualization_context`.
- `provider`: Resolved active provider (`ootb`, `byok`, `local`, etc.).
- `durationMs`: Milliseconds from dispatch to completion.
- `reqTokens` / `respTokens`: Heuristic token estimates (character-count / 4).
- `session`: Internal session identifier used by the service.
- `status`: Currently `ok`; reserved for future error / retry states.

## Design Goals
1. Zero noise unless explicitly enabled
2. Single routing point (no ad-hoc console logging in feature files)
3. Provider attribution always present
4. Lightweight heuristic metrics (no external billing API calls)
5. Safe truncation of large prompt/response bodies

## Implementation Highlights
- Output channel created in `extension.ts` during activation.
- Injected into `LLMService` via a setter (`setOutputChannel`).
- `LLMService.invokeTracked()` composes and writes the structured entry only if verbose mode is active.
- Verbose flag refreshed on configuration changes without requiring reload.
- All former `console.log` diagnostic statements in `src/**` removed or commented out to avoid duplication.

## When to Use
Enable verbose logging when:
- Debugging provider selection or routing
- Auditing prompts sent to the model
- Investigating latency or token growth over time
- Validating new task types use the shared pipeline

Disable it for normal daily usage to keep the Output panel quiet.

## Extending
When adding a new LLM task:
1. Assign a concise `task` name string
2. Ensure it flows through `LLMService.request()` / `invokeTracked()`
3. Confirm the log line includes the new task value
4. Avoid adding direct logging in feature modules—let the centralized logger handle it

## Error Logging
Errors still surface through standard error handling paths (e.g., user-facing messages or `console.error` where appropriate). Future enhancement may add `status=error` lines with stack summaries.

## Related Docs
- `CONSOLIDATED_LOGGING.md` (historical pre-output-channel cleanup)
- `IMPLEMENTATION_COMPLETE.md` (multi-provider architecture)

## Quick Toggle Suggestion
You can bind a keyboard shortcut to open Settings JSON and flip the flag, or implement a future command (e.g., `NaruhoDocs: Toggle Verbose LLM Logging`).

---
Last updated: 2025-09-18
