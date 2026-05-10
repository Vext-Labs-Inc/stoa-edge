# Contributing to stoa-edge

stoa-edge is the reference runtime for the Stoa open agent substrate. Contributions are welcome under Apache-2.0.

## Before you open a PR

- Read the spec: https://github.com/Vext-Labs-Inc/stoa-spec
- For protocol-level changes (wire envelope shape, receipt fields, error codes), open an RFC on stoa-spec first. Runtime PRs that deviate from the spec without a corresponding spec change will not be merged.
- For new adapters, conformance tests, or runtime improvements, open a PR directly here.

## Runtime PR requirements

1. Passing tests: `npm test` must pass with no failures.
2. TypeScript strict mode: no `any`, no `@ts-ignore` without a documented reason.
3. Conformance delta: if your PR changes observable behavior (response shape, error codes, receipt fields), add or update a test in `tests/` that covers the new behavior.
4. No breaking changes to the Stoa/1 wire shape without a corresponding spec version bump.

## Adding an adapter

1. Create `src/adapters/<vendor>_<resource>_<action>.ts`
2. Export an async function matching `AdapterFn` from `src/adapters/index.ts`
3. Register the cap URN in `ADAPTER_REGISTRY` in `src/adapters/index.ts`
4. Add at least one passing test in `tests/` covering the happy path and one error case

## Code style

- TypeScript strict mode throughout
- No emoji in code or comments (inline SVG where icons are needed in any UI surface)
- Functions over classes where possible; classes only for Durable Objects
- Every public function has a JSDoc comment

## License

By contributing you agree your contribution is licensed under Apache-2.0.
