# AGENTS.md

Rules for coding agents and contributors working on Ordo.

## Stack

TypeScript in strict mode, Node.js 24+, pnpm, ESM. ESLint (`typescript-eslint` strict-type-checked and stylistic-type-checked), Prettier, Vitest. Runtime dependencies: `@anthropic-ai/claude-agent-sdk`, `pino`, `yaml`, `zod`. Add another only with a reason.

## Design rules

- Ordo knows no subject area. No words from a particular domain in code, prompts, docs or examples.
- The logic is a library: functions take typed input and return typed results, with no `process.argv` or console inside. `src/cli.ts` only parses arguments, reads files and prints.
- The order file is the memory. Anything the dispatcher must remember across a restart goes into the file; anything else may be lost.
- Model access goes through `SessionHost`; notifications through `NotifierPlugin`.

## Types

No `any`. No `as`, except right after runtime validation at a boundary. No non-null assertions. No `@ts-ignore` or disabled lint rules to get a green build. Validate every external input (the order file, model replies, socket messages) with a schema.

## Tests

Deterministic: a scripted `SessionHost`, a manual `Clock`, temporary directories. No network and no real model. Every bug fix starts with a failing test. Do not weaken or delete a test to make a change pass.

## Done means

```bash
pnpm typecheck && pnpm lint && pnpm test
```

pass. Small focused commits, imperative summary line, a body that says why when it is not obvious.
