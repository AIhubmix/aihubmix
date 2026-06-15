# Changelog

## 1.0.1

### Patch Changes

- Fix image attachments and declare missing runtime dependencies

  - Fix the base64 image data URL format in the Anthropic transformer
    (`data:<media_type>;base64,<data>`), which previously broke conversations
    with image attachments.
  - Declare `@fastify/cors`, `undici` and `jsonrepair` in `dependencies`; they
    were imported by the source but missing from `package.json`, so a clean
    install could not build the package.

## 1.0.0

### Major Changes

- dab5ee8: init claude code router
- b4f3b79: add README

### Patch Changes

- aa02c6a: update support models

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1] - 2024-01-XX

### Added

- Initial release
- CLI commands for server management
- Web UI interface
- API key authentication
- Configurable routing
- Logging support
