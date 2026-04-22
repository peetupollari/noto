# Noto

Noto is an Electron-based markdown note app with local storage, cloud sync helpers, a Windows installer, and GitHub Releases auto-update support.

## What Is Configured

- `electron-builder` builds a Windows NSIS installer.
- `electron-updater` checks the GitHub Releases feed for `peetupollari/noto`.
- Updates download automatically and install on restart or on the next app quit.
- `notologo-ico.ico` is used for the packaged app executable, installer, uninstaller, tray icon, and Windows taskbar jump list tasks.

## Important Requirement

For end users to receive updates directly from GitHub Releases, the `peetupollari/noto` repository needs to be public when you publish releases.

If the repository stays private, normal users will not be able to fetch update metadata from GitHub Releases without additional authenticated update infrastructure.

## Windows Signing Note

This repository is configured so unsigned Windows builds can still install updates from GitHub Releases.

That keeps the release flow working now, but Microsoft SmartScreen reputation and the best Windows trust experience still require code signing. Electron's current guidance is to use modern Windows code signing, ideally EV or a cloud-based signing service such as Azure Trusted Signing.

## Development

Install dependencies:

```bash
npm install
```

Run the app in development:

```bash
npm start
```

## Build A Local Installer

Create a Windows installer locally:

```bash
npm run dist:win
```

Output files are written to `dist/`.

Notes:

- Auto-updates are only available in the installed packaged app, not in `npm start`.
- The generated installer target is NSIS, which is the Windows target supported by `electron-updater` with `electron-builder`.
- If local packaging fails while extracting `winCodeSign` with a symbolic-link privilege error, enable Windows Developer Mode or run the build from an elevated terminal.

## Publish A Release

1. Update the version in `package.json`.
2. Commit and push your changes.
3. Create a matching Git tag with a `v` prefix.
4. Push the tag to GitHub.

Example:

```bash
git add .
git commit -m "Release v0.0.5"
git tag v0.0.5
git push origin main
git push origin v0.0.5
```

When the tag is pushed, `.github/workflows/release.yml` will:

- install dependencies,
- build the Windows installer,
- upload release assets to GitHub Releases.

## Package Scripts

- `npm start` runs the app locally.
- `npm run dev` runs Electron with a remote debugging port.
- `npm run pack` builds an unpacked packaged app.
- `npm run dist` builds distributable packages without publishing.
- `npm run dist:win` builds the Windows NSIS installer without publishing.
- `npm run release:win` builds and publishes the Windows installer to GitHub Releases.

## Release Feed Behavior

The packaged app is configured to:

- check for updates automatically after launch,
- keep checking periodically while installed,
- download updates automatically,
- prompt the user to restart when an update is ready,
- install the update automatically on the next quit if the user chooses Later.

## References

- Electron Builder auto update docs: https://www.electron.build/auto-update.html
- Electron Builder publish docs: https://www.electron.build/publish.html
- Electron Builder NSIS docs: https://www.electron.build/nsis.html
- Electron taskbar docs: https://www.electronjs.org/docs/latest/tutorial/windows-taskbar
