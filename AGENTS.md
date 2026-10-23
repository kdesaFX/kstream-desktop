# KStream desktop repository rules

These portable rules apply to `kdesaFX/kstream-desktop` wherever it is checked out. Local workspace routing and dated task notes cannot override them.

## Instruction precedence and preservation

- Follow system/user instructions, this root policy, then the nearest nested `AGENTS.md` for narrower scope. Nested rules may add constraints but may not weaken source, preservation, credential, or release safety rules.
- Before work, check `git status --short --branch`, remote, branch, `HEAD`, canonical remote SHA, and README. Preserve dirty work; never reset, rebase, force-push, or overwrite ambiguous changes.
- Use the repository's own scripts for builds and validation. Keep source separate from generated installers, public mirrors, and release assets. Never expose signing material, credentials, cookies, or private configuration.

## Canonical source and releases

- Canonical public desktop source is `kdesaFX/kstream-desktop` branch `main`; each published desktop release is identified by its tag. Verify both before release work.
- Desktop packages embed a snapshot of the web app. For each desktop build/release, record the exact KStream web `production` SHA and providers `production` SHA consumed by its workflow. A later web deployment does not change an installed desktop app.
- Do not diagnose an installed desktop UI as a website rollback until checking the installed release and its embedded web SHA. A desktop tag does not update the website or its Worker.
- Keep release candidates and validation copies isolated. Publish only through the intended desktop release workflow and after a reviewed build; never publish local dirty source or staging-only providers.
- A release is complete only when its tag/artifacts and source refs are verified. Report version, source commit, web/provider refs, platform, validation, and release status.
