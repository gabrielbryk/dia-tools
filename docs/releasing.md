# Publishing and releasing

GitHub Actions is disabled for this repository. Workflow templates live in `docs/workflow-templates/`, outside the active workflow directory. Building and testing locally do not publish anything.

1. Review the tracked file list. It should contain code, documentation, skills, lockfile, and synthetic tests only.
2. Run `bun install --frozen-lockfile`, `bun run check`, and `bun run build:portable`.
3. Run the portable executable's `self-test` on the intended macOS architecture. Check `doctor` and a read-only operation against a supported Dia version if available.
4. Create your GitHub repository and push this source using your preferred Git client.
5. Publish releases manually while automation remains disabled. If automation is requested later, review the templates, move the selected files into `.github/workflows/` with `.yml` extensions, and explicitly enable Actions in repository settings before using them.

The inactive CI template uses a macOS host; the artifact filename records its actual architecture. To add Intel or other targets, run native builds and verify their native SQLCipher dependencies. Do not label an architecture as supported merely because Bun can cross-compile its runtime.

Portable release archives include third-party license notices. The project license applies to project code, not SQLCipher, OpenSSL, Bun, or their dependencies. Local executables and native libraries are ad-hoc signed; Developer ID signing and notarization require maintainer-owned credentials and are not configured here.

The npm-style source package supports Bun users with an installed SQLCipher library. For users who need no runtime installation, distribute the portable release archive. Never upload your local `artifacts/`, `plans/`, encrypted backups, or `.build/` directory.
