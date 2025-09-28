# Removal Plan: Eliminate OOTB (Out-of-the-Box) LLM Provider

Date: 2025-09-28  
Status: Implemented (Code changes applied; doc/tests & CHANGELOG follow-ups pending)  
Author: Automated assistant

## 1. Objective
Completely remove the legacy `ootb` (Out-of-the-Box Gemini) provider from the codebase, configuration, documentation, and user-facing UI. After removal the product will support only:

* `byok` (User-facing label: Cloud (API Key)) – user-supplied API key to a remote LLM (Gemini today; future remote vendors possible). Internal id retained as `byok` for backward compatibility; only display strings now say “Cloud (API Key)”.
* `local` (UI Label: Local (Runtime)) – locally hosted models via Ollama / LM Studio / compatible backends

## 2. Rationale
The OOTB provider depended on an implicit environment key and added conditional logic, branching, and support burden:
* Increased complexity in `LLMProviderManager`, `LLMService`, status bar display, and model resolution.
* Extra default branching everywhere (`'ootb'` fallbacks) obscures intent.
* Documentation and testing surface widened without meaningful user differentiation from BYOK.
* Removal simplifies onboarding: users explicitly choose Cloud (enter a key) or Local (run a runtime).
* Reduces risk surface around silent auth failures and ambiguous rate-limit semantics.

## 3. High-Level Strategy
1. Immediate hard removal (no deprecation phase) with automatic migration for legacy settings.
2. Safe fallback: if `naruhodocs.llm.provider == 'ootb'` migrate to `byok` if an API key exists else `local`.
3. New default provider becomes `byok` (Cloud (API Key)). On first activation if no key is present, prompt once; fallback to Local upon skip.
4. Remove `OOTBProvider` implementation & references.
5. Update configuration schema (`package.json`) and docs.
6. Add CHANGELOG entry (Breaking Changes section).
7. Add migration & activation-time key prompt tests.

## 4. Affected Areas (Inventory)
| Area | Files / Elements |
|------|------------------|
| Provider implementation | `src/llm-providers/ootb.ts` |
| Provider registration | `src/llm-providers/manager.ts` (set, import, error handling) |
| Default provider fallback strings | `extension.ts`, `LLMService.ts`, `ModelConfigManager.ts` (scaffold), status bar logic |
| Config schema / settings | `package.json` (`naruhodocs.llm.provider` enum/default, wording) |
| Model config scaffolding | `ModelConfigManager.scaffoldIfMissing()` (ootb block) |
| UI selection lists | Provider QuickPicks (`extension.ts`) + task override command |
| Documentation | `README.md`, `LLM_PROVIDER_IMPLEMENTATION_GUIDE.md`, `IMPLEMENTATION_COMPLETE.md`, `CENTRALIZED_LLM_SERVICE.md`, `TEST_LLM_PROVIDERS.md`, `VERBOSE_LOGGING.md` |
| Instructions | `.github/instructions/llm-providers.instructions.md` (reference removal) |
| Tests | Any assuming default `ootb`; need migration & prompt tests |

## 5. Detailed Step-by-Step Plan

### 5.1 Preparatory (Schema & UX Decisions)
1. Confirm **Cloud (API Key)** as the *display name* for `byok`; retain internal id `byok` to avoid migrations in settings / models.json.
2. Confirm **Local (Runtime)** label for `local`.
3. Set new configuration default: `naruhodocs.llm.provider = 'byok'`.
4. Activation-time key prompt ensures new default does not silently fail (Section 5.3.1).
5. Fallback precedence for legacy or incomplete configuration:
   * If provider was `ootb` → migrate to `byok` if key present else `local`.
   * If provider is `byok` with no key after prompt → switch to `local`.

### 5.2 Code Removal & Refactor
1. Delete `src/llm-providers/ootb.ts`.
2. In `src/llm-providers/manager.ts`:
   * Remove `OOTBProvider` import + registration.
   * Add migration logic: if loaded provider string is `ootb` call migration helper (see 5.3) to derive new provider.
   * Remove `'ootb'` handling branch in `handleProviderError`.
3. In `LLMService.ts`:
   * Change any default parameter `get(..., 'ootb')` to `get(..., 'byok')`.
   * Initialize local variable defaults with `'byok'`.
   * Ensure model resolution still: Cloud fallback `'gemini-2.0-flash'`; Local fallback `'gemma3:1b'` (or file-based resolution).
4. In `extension.ts`:
   * Replace `.get<string>('llm.provider', 'ootb')` with `'byok'`.
   * Insert early migration + key prompt prior to calling `llmManager.initializeFromConfig()`.
   * Remove OOTB from provider QuickPick + adjust icons: Cloud → `key`, Local → `server-environment`.
   * Update `naruhodocs.addModelTaskOverride` provider list (remove ootb).
   * Update status bar generation logic (drop robot icon scenario).
5. In `ModelConfigManager.ts`:
   * Remove `ootb` provider block from scaffold.
   * While parsing an existing models.json that still contains `ootb`, leave it untouched (non-blocking) or optionally log a one-time info message (not required for MVP removal).
6. In `package.json`:
   * Remove `"ootb"` from enum for `naruhodocs.llm.provider`.
   * Set default to `"byok"`.
   * Update descriptions to mention: `Cloud (API Key)` / `Local (Runtime)`.
7. In `.github/instructions/llm-providers.instructions.md` & related docs: remove OOTB references and clarify new naming.
8. Delete or update examples referencing OOTB in docs & guides.

### 5.3 Migration Logic (Legacy `ootb`)
Helper inside provider manager or activation flow:
```ts
function migrateLegacyProvider(config: vscode.WorkspaceConfiguration): string {
  const raw = config.get<string>('llm.provider', 'byok');
  if (raw !== 'ootb') return raw;
  const hasKey = !!(config.get<string>('llm.apiKey') || '').trim();
  const target = hasKey ? 'byok' : 'local';
  config.update('llm.provider', target, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`NaruhoDocs: 'ootb' provider removed. Switched to '${target === 'byok' ? 'Cloud (API Key)' : 'Local (Runtime)'}'.`);
  return target;
}
```

### 5.3.1 Activation-Time Key Prompt (Cloud Default Safety Net)
Executed after legacy migration but before provider initialization if current provider is `byok` and no key set.
```ts
async function ensureCloudApiKey(config: vscode.WorkspaceConfiguration): Promise<void> {
  const provider = config.get<string>('llm.provider', 'byok');
  if (provider !== 'byok') return;
  const existing = (config.get<string>('llm.apiKey') || '').trim();
  if (existing) return; // already configured
  const entered = await vscode.window.showInputBox({
    title: 'Cloud (API Key) Provider',
    prompt: 'Enter API key for Cloud provider (Gemini). Leave blank to switch to Local (Runtime).',
    password: true,
    ignoreFocusOut: true
  });
  if (entered && entered.trim()) {
    await config.update('llm.apiKey', entered.trim(), vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage('Cloud (API Key) provider configured.');
    return;
  }
  await config.update('llm.provider', 'local', vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage('No key provided. Switched to Local (Runtime). You can change this later in Settings.');
}
```
Call order in activation:
1. Read config.
2. Run `migrateLegacyProvider`.
3. Run `ensureCloudApiKey`.
4. Initialize provider manager.

### 5.4 Documentation Updates
Update or remove OOTB references in:
* `README.md` – provider list, setup, environment variable notes.
* `LLM_PROVIDER_IMPLEMENTATION_GUIDE.md` – remove entire OOTB section; renumber remaining.
* `IMPLEMENTATION_COMPLETE.md` – remove OOTB checklist bullet.
* `CENTRALIZED_LLM_SERVICE.md` – provider enumeration.
* `TEST_LLM_PROVIDERS.md` – remove OOTB scenario; add migration test mention.
* `VERBOSE_LOGGING.md` – list only Cloud (API Key) / Local (Runtime).
Add CHANGELOG entry under Breaking Changes summarizing: removal of OOTB, new default provider = Cloud (API Key), activation-time key prompt, fallback to Local if skipped.

### 5.5 Tests
1. Update any tests expecting `'ootb'` default to `'byok'`.
2. New test file `test/ProviderMigration.test.ts` (suggested cases):
   * Case A: config provider = `ootb`, api key present → expect updated to `byok` and no error.
   * Case B: config provider = `ootb`, no key → expect updated to `local`.
   * Case C: config provider = `byok`, no key, simulate prompt cancel → expect provider becomes `local`.
   * Case D: config provider = `byok`, key present → initialization uses Cloud path.
3. If mocking VS Code APIs, stub `showInputBox` return values for prompt simulation.

### 5.6 Cleanup & Validation
1. Delete `src/llm-providers/ootb.ts` and grep to confirm no `OOTBProvider` references remain.
2. Type check and build (`tsc` + esbuild watch) – ensure no unresolved imports.
3. Run test suite.
4. Manual smoke in VS Code:
   * Old settings containing `ootb` migrate properly.
   * With no API key: prompted; on cancel fallback to Local.
   * Status bar shows model + appropriate icon.
   * Provider QuickPick shows only Cloud (API Key) / Local (Runtime).

## 6. Risk Assessment & Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| User still has `ootb` set | Initialization error | Migration helper auto-updates setting + info message |
| User confused by new default | Support noise | Activation prompt + CHANGELOG + README update |
| Tests referencing `ootb` break | CI failure | Systematic grep & targeted test updates |
| Models config includes `ootb` | Mild confusion | Treat as inert; optionally add doc note; no hard failure |
| Missing key on first run | Non-functional cloud path | Prompt then auto fallback to Local |

## 7. Sequencing / PR Strategy
Single PR recommended (atomic). Include:
* Code removal & migration logic
* Default + schema change
* Docs & instructions sweep
* Tests
* CHANGELOG update

## 8. Acceptance Criteria
* `ootb.ts` removed; no `OOTBProvider` symbol in repo.
* Config enum for `naruhodocs.llm.provider` lists only `byok`, `local`; default = `byok`.
* Activation-time key prompt implemented; fallback to Local when skipped.
* Legacy `ootb` setting migrates to Cloud (API Key) or Local (Runtime) with user notification.
* Status bar & QuickPick reflect new labels consistently.
* All tests (including new migration/prompt tests) pass.
* CHANGELOG records removal & default change.

## 9. Follow-Up (Optional Enhancements)
* Add provider capability introspection (e.g., reasoning tokens, streaming support) for dynamic UI badges.
* Expand Cloud provider abstraction to support multiple remote vendors under the same `byok` id with sub-selection.
* Telemetry (future) to evaluate proportion of fallback events (prompt cancellations).

## 10. Implementation Checklist (Condensed)
```
[x] Remove file: src/llm-providers/ootb.ts
[x] Add migrateLegacyProvider + ensureCloudApiKey flow
[x] Update provider defaults (byok) & schema enum
[x] Adjust manager, service, extension, model config scaffold
[x] Update labels in QuickPicks and status bar
[~] Docs & instructions sweep (README updated; remaining guides still reference OOTB historically)
[ ] Add ProviderMigration.test.ts
[ ] Update CHANGELOG (Breaking Changes entry)
[x] Build & run existing tests / type & lint checks
```

---
This document is the authoritative blueprint for removing the OOTB provider and establishing Cloud (API Key) as the new default with a safe activation-time key prompt.

## 11. Implementation Summary (Applied 2025-09-28)
The following changes have been committed to the codebase:
* Deleted `src/llm-providers/ootb.ts`.
* Updated `src/llm-providers/manager.ts` to remove OOTB registration and add legacy provider migration mapping `ootb -> byok|local`.
* Added activation-time migration & API key prompt logic in `src/extension.ts` (migrate first, then prompt, fallback to local on skip).
* Changed default provider fallback strings from `'ootb'` to `'byok'` across `extension.ts`, `LLMService.ts`, and model config handling.
* Removed `ootb` from model config scaffold in `ModelConfigManager.ts`; legacy entries are ignored/stripped.
* Updated `package.json` configuration: enum now only `byok`, `local`; default `byok`.
* Revised `README.md` to reflect only Cloud (API Key) and Local (Runtime) providers.
* Verified type check and lint pass; existing tests unaffected (no references to `ootb`).

## 12. Next Steps (Outstanding Items)
* Write `test/ProviderMigration.test.ts` covering migration + prompt flows.
* Update `docs/CHANGELOG.md` (or root `CHANGELOG.md`) with Breaking Change entry.
* Sweep remaining docs (`LLM_PROVIDER_IMPLEMENTATION_GUIDE.md`, `IMPLEMENTATION_COMPLETE.md`, `CENTRALIZED_LLM_SERVICE.md`, `TEST_LLM_PROVIDERS.md`, `VERBOSE_LOGGING.md`) to either remove obsolete OOTB references or add a historical note.
* Update `.github/instructions/llm-providers.instructions.md` to remove OOTB references and describe current provider set.
* Optionally add telemetry (future) or metrics around migration path usage.

---
End of document.