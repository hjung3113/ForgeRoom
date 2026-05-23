# core/__tests__/ Working Guide

This folder contains unit tests for `apps/orchestrator/src/core` implementation files.

## Rules

- Keep implementation code out of this folder.
- Import implementation modules via `../<module>`.
- Put shared fakes and builders in `../test-support/` when reused by more than one test file.
- Keep each test file under 300 lines at stage completion; split fixture builders into `test-support/` when needed.

