## Summary

<!-- What changed and why. -->

## Checklist

- [ ] Title follows Conventional Commits (`<type>(<scope>): <description>`)
- [ ] `pnpm hygiene` passes
- [ ] `pnpm check:comments` passes — no explanatory comments
- [ ] `pnpm lint:fix` has been run
- [ ] `pnpm build` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] `pnpm e2e:quick` passes
- [ ] A framework change ships with a matching fixture change under `packages/<fw>/e2e`
