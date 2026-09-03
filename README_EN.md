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

---

## Core Capabilities

InkMind is engineered specifically for longform novel creation (million-word serialized fiction), transcending single-prompt chatbots with an enterprise-grade infrastructure:

### 1. Proprietary Six-Stage Writing Pipeline (Multi-Agent Collaboration)
- **Scene & Beat Planning (Planner)**: Automatically breaks down outlines into multi-act dramatic beats, pacing narrative conflict and target word count distribution.
- **Streaming Prose Generation (Writer)**: Crafts longform prose strictly adhering to world-building lore and foreshadowed debts with live streaming output.
- **Deterministic Schema Verification (Validator)**: Powered by SchemaGate, providing automatic error reflection and targeted retries to prevent JSON truncation and corrupted formats.
- **AI-Style De-flavoring (Taste Cleaner)**: Deeply scans and cleans clichéd AI idioms, excessive exclamation marks, repetitive dash abuse, and hollow prose.
- **Targeted Segment Revision (Reviser)**: Upon detecting narrative flaws, surgical rewrites fix problematic sections without wiping valid portions of the chapter.
- **Memory & Ledger Writeback (Settler)**: Consolidates chapter recaps, updates active foreshadowing debts, and records character progression upon completion.

### 2. Million-Word Longform Memory Engine (No Character Forgetting)
- **Dynamic Fact Ledger**: Long-term tracking of character status, power levels, injuries, inventory of key relics/items, and faction alliances.
- **Foreshadowing & Debt Ledger**: Automatically registers narrative setups and unresolved mysteries, reminding writers across hundreds of thousands of words.
- **Hierarchical Memory Compression**: Chapter recaps + story arc digests systematically distill plotlines, completely avoiding token context overflow.
- **Semantic Relevance Pre-Injection**: Before generating each new chapter, extracts the most pertinent memory slices into the prompt to guarantee seamless continuity.

### 3. Comprehensive Logical Consistency Defenses
- **Six-Dimension Flaw Audit (Hard Review)**: Real-time inspection of character state anomalies, power scaling collapse, timeline inversions, continuity conflicts, miraculous item appearances, and POV shifts.
- **Cross-Chapter Continuity Sampling**: Randomly audits back against earlier chapters to catch latent plot drift across long-term serialization.
- **Local Rule Engine**: Built-in sensitive word scanning, high-frequency word density analysis, and sentence structure monotony diagnostics.

### 4. Style Mimicry & Customization Engine
- **Master Style Extraction**: Analyzes sample chapters to extract narrative pacing, vocabulary preferences, rhetorical habits, and descriptive tone.
- **Multiple Style Profiles**: Store distinct writing profiles (Xianxia, Hard Sci-Fi, Urban Suspense, Fantasy, etc.) and switch with one click.
- **Negative Writing Constraints**: Custom ban-lists for prohibited words, overused tropes, and stylistic taboos to rigidly govern LLM behavior.

### 5. Modular World-Building & Lorebook System
- **Comprehensive Lore Profiles**: Character dossiers (personality, backstory, verbal tics, abilities), geography maps, power tier hierarchies, factions, and divine artifacts.
- **Multi-Level Outline Hierarchy**: Master premise → volume milestones → chapter outlines → scene beats, mastering large-scale narrative arcs.
- **Global Lifecycle State Sync**: Character breakthroughs, item transfers, and faction downfalls automatically update across the entire story universe.

### 6. Local-First Architecture & Privacy Security
- **100% Author-Owned Data**: All story drafts, outlines, world lore, and vector indexes remain in the local IndexedDB, never uploaded to private cloud servers.
- **Machine-Bound API Key Encryption**: Keys are encrypted locally using AES-256-GCM combined with device hardware fingerprinting, never leaked to frontend or logs.
- **Disaster Recovery & Data Protection**: Millisecond-level local persistence for streaming drafts, gzip versioned project snapshots, cross-tab concurrency locks, and coalesced disk writes.

### 7. LLM Orchestration & Cost Control
- **Bring Your Own Key (BYOK)**: Native support for standard OpenAI-compatible protocols (DeepSeek, OpenAI, Kimi, Zhipu GLM, Qwen, and custom proxy gateways).
- **Role-Based Model Routing**: Route background summaries to economical models while reserving top-tier models for complex outlining and prose generation, slashing costs by up to 70%.
- **Live Token & Budget Analytics**: Real-time per-chapter token and cost tracking with configurable monthly hard budget caps.
- **One-Click Connectivity Doctor**: Instant verification of endpoint latency, credentials, streaming throughput, and JSON compliance.

### 8. Dedicated Writer Studio UX
- **Distraction-Free Dual Themes**: Seamless toggling between light mode and eye-care dark mode, optimized for midnight creative flows with high-contrast typography.
- **Multi-Format Export & Backups**: One-click export to plain text (.txt), Markdown (.md), or structured chapter archives.
- **In-App Version Checker**: Query official GitHub Releases directly inside the app settings to stay updated.

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
