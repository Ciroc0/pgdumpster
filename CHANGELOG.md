# Changelog

All notable changes to this project will be documented here.

The format follows Keep a Changelog principles and the project uses Semantic Versioning for released packages.

## [Unreleased]

## [0.1.0] - 2026-08-16

### Added

- A TypeScript CLI for backup, inspect, coverage, integrity verification and restore planning of hosted Supabase projects.
- Coverage-accounted backup capture for PostgreSQL state, File Storage, Auth, API keys, Edge Functions, Vault-root-key material and applicable Management API surfaces.
- Deterministic `.tar.zst` archives, SHA-256 integrity manifests, resumable checkpoints, local and S3-compatible publication, and standard `age` encryption.
- Restore dry-run/apply with source-target protection, integrity-first planning, handler completeness checks and explicit semantic/platform-limit reporting.

### Changed

- Backup consistency is explicit: `verified` is the default; `best-effort` and `quiesced` record their distinct guarantees and drift outcomes.
- Secret-bearing plaintext backups require explicit acknowledgement; encrypted inputs require an `age` identity file in configuration.

### Security

- Release automation verifies exact-SHA CI, CodeQL and protected live E2E evidence before publishing, then verifies the published npm artifact in a fresh consumer install.

### Platform limits

- Supabase-managed values that cannot be exported or identically recreated are represented as explicit platform limits; they are never silently treated as complete recovery.
