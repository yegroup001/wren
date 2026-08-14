<div align="center">

# Wren

A terminal-based AI coding agent — open source, self-hosted.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg)](LICENSE)

</div>

## Overview

Wren is a terminal-native AI coding agent. It runs locally with your own API keys — no accounts, no cloud dependency, telemetry off by default.

## Features

- **Terminal UI** — streaming output, expandable tool cards, inline diffs with line numbers, syntax-highlighted code, session sidebar with todos and file changes
- **Agent harness** — sub-agent orchestration, SQLite session persistence, streaming with retry and compaction, MCP tool support
- **Multi-provider** — Anthropic, OpenAI, OpenAI-compatible, Gemini, and Grok
- **Self-hosted** — AGPL-3.0, runs on your machine, no accounts, no quotas

## Installation

Install the latest release with:

```bash
curl -fsSL https://raw.githubusercontent.com/yegroup001/wren/main/install.sh | bash
```

The installer detects your platform, downloads the latest binary release, installs it to `~/.wren/bin`, and adds that directory to your shell configuration. Restart your shell or add `~/.wren/bin` to `PATH` manually if needed.

To install a specific release instead:

```bash
curl -fsSL https://raw.githubusercontent.com/yegroup001/wren/main/install.sh | bash -s -- --version 0.1.1
```

## License

[AGPL-3.0-or-later](LICENSE)
