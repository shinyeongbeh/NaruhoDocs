# Change Log

All notable changes to the "naruhodocs" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Added
- Centralized `LLMService` for all LLM interactions (chat, summarize, translate, analyze, generate_doc, visualization context, file reading).
- Model & temperature override plumbing across providers.
- Daily token / request usage tracking with stats command `naruhodocs.showLLMStats`.
- Session & stats persistence across reload (`workspaceState` snapshots).
- New commands: `Summarize Document`, `Translate Document`, `Show LLM Stats`.

### Changed
- Configuration changes to LLM settings now invalidate cached sessions to ensure updated models take effect.

### Fixed
- Visualization sidebar now persists the last rendered diagram across sidebar close/reopen via caching & readiness handshake.
- General chat history now reliably replays after the chat view is closed and reopened (added explicit resend on subsequent `chatViewReady` events to avoid blank history in the general thread).
- General thread history persistence: restored previously sent messages now hydrate underlying session (fixes empty raw history / flicker on reopen when only general thread affected).

### Planned
- True token accounting via provider metadata.
- Streaming responses for long generations.
- Test coverage expansion (overrides, persistence, rollover).