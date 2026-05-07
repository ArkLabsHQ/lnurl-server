# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

### Added
- LNURL-pay service with SSE-based wallet sessions (LUD-06)
- Amountless Lightning receives via reverse swaps
- Reusable sessions: wallet sends a token, server derives a deterministic sessionId via SHA-256
- Session hijack prevention by construction (different tokens always produce different sessionIds)
- Token-based authentication for invoice endpoints
- Multi-arch Docker image (amd64 + arm64) published to GHCR
- Input validation for token (hex, minimum length)
- Comment passthrough to wallet via SSE events
