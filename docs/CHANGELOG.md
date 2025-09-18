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

### Planned
- True token accounting via provider metadata.
- Streaming responses for long generations.
- Test coverage expansion (overrides, persistence, rollover).