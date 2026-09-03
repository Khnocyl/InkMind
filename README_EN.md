<div align="center">

<img src="public/icon.png" alt="InkMind Logo" width="96" height="96" />

# InkMind

**Local-first AI Longform Novel Writing Studio**

React 19 + Vite Frontend · Express Backend LLM Proxy · Project Data 100% Persisted Locally in IndexedDB

[中文文档](README.md) · [Download & Install](#download--installation) · [Core Capabilities](#core-capabilities) · [Quick Start](#quick-start) · [License](#license)

</div>

---

## Download & Installation

For writers and novelists without programming background, you can directly download the desktop installer without installing Node.js:

Pre-built binaries are available on the [Releases page](https://github.com/Khnocyl/InkMind/releases):

- **Windows**: Download `InkMind-x.x.x-win-x64-Setup.exe`. If Windows Defender or SmartScreen prompts "Unknown Publisher", click **"More info" → "Run anyway"** (as an open-source project, expensive commercial EV certificates are not currently purchased; the code is 100% transparent and safe).
- **In-App Updates**: Built-in update checker available in the sidebar under "Settings → General & Appearance → About & Check Updates". Click "Check for Updates" to query the latest official GitHub Releases.
- **macOS / Linux**: v1.0.0 primarily targets Windows. Native packages for macOS and Linux are in progress; users on these platforms can run from source via `npm start`.

---

## Core Capabilities

- **Strict Six-Stage Writing Pipeline** (Proprietary Multi-Agent Orchestration): Planner (Beats & Scenes) → Writer (Streaming Prose) → Validator (Deterministic Verification) → Auditor (Logic/Style/Pattern Checks) → Reviser (Targeted Fix Band) → Settler (Memory Writeback).
- **Longform Memory System**: Fact Ledger (`factLedger`), persistent facts and foreshadowing debt, chapter recaps, and span digests injected before drafting based on semantic relevance.
- **Consistency Defenses**: Post-draft flaw audits (character state, combat power, timeline, continuity, props, narrative perspective) + machine pattern checks + cross-chapter audit sampling + memory conflict detection.
- **Cost & Rate Control**: Bring Your Own Key (BYOK, multi-profile support), monthly budget gates, usage analytics dashboard, and automatic graceful fallback to local conservative drafts upon LLM failure.
- **Engineering Reliability**: Streaming draft backups, gzip project snapshots, automatic schema migrations, cross-tab write locks, and coalesced disk writes.

---

## Quick Start (Developers)

Requires Node.js 20+.

```bash
npm install

# Development mode (server watch + Vite HMR)
npm run dev
# Open in browser (default: http://localhost:5173)

# Or: build + single-process production server (Express serves dist)
npm start
# Open http://localhost:3001

# Or: build desktop installer
npm run electron:dist
# Generated in release-electron/ (Windows x64 Setup installer)
```

**First Use**: Go to the "Settings" tab to configure your LLM Base URL, API Key, and Model Name (supports DeepSeek, OpenAI, Kimi, GLM, SiliconFlow, and other OpenAI-compatible services). Keys are encrypted locally with AES-256-GCM and never exposed to the frontend or source code.

---

## Privacy Notice

- All novel data (chapters, world-building, memory ledgers) is saved in **local browser IndexedDB** and never uploaded to any remote server.
- During generation, draft prompts are sent to your configured LLM endpoint. Using unofficial third-party aggregators implies trusting that provider; warnings are displayed in settings for non-official endpoints.
- Optional vector embeddings only call your configured embedding endpoint; when unconfigured, the system automatically falls back to local TF-IDF search without interrupting your workflow.

---

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Development mode (server watch + Vite) |
| `npm start` | Production single-process server (http://localhost:3001) |
| `npm run build:exe` | Standalone executable server build (release/inkmind.exe) |
| `npm run electron:dist` | Package Windows desktop installer (release-electron/) |
| `npm run build` | Full TypeScript typecheck + frontend build |
| `npm test` | Vitest unit test suite |
| `npm run lint` | Oxlint code scan |

---

## License

This project is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE).
- Personal writers and open-source developers are welcome to use, study, and create with InkMind freely.
- Any derivative works, modifications, or hosted cloud network services **must release their complete source code under AGPL-3.0**. Closed-source commercial repackaging and resale are strictly prohibited.
