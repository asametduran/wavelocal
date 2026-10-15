// @ts-check
/**
 * Windows packaging for the Wavelocal desktop shell (`npm run desktop:dist` from the repository root).
 *
 * The installer carries the compiled shell (inside app.asar) and the built web app (`../dist`, copied to
 * `resources/web`, which is where `main.ts` serves the page from when packaged). Nothing is downloaded at run time
 * and the app makes no network requests, so there is no auto-updater and no publish target.
 *
 * @type {import('electron-builder').Configuration}
 */
module.exports = {
  appId: 'app.wavelocal.desktop',
  productName: 'Wavelocal',
  copyright: 'Wavelocal',
  asar: true,
  directories: { output: 'release', buildResources: 'build' },
  // only the compiled shell goes into the asar; sources, tests, source maps and tooling stay out
  files: ['package.json', 'out/desktop/src/**/*.js', 'out/src/desktop-bridge.js', '!**/*.test.js', '!**/*.map'],
  extraResources: [{ from: '../dist', to: 'web', filter: ['**/*', '!**/*.map'] }],
  // fuses and signing are not configured: the shell has no native modules and ships unsigned (see README)
  electronLanguages: ['en-US'],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: '../public/icons/icon-512.png',
    artifactName: 'Wavelocal-Setup-${version}-${arch}.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    shortcutName: 'Wavelocal',
    uninstallDisplayName: 'Wavelocal',
    createDesktopShortcut: 'always',
    createStartMenuShortcut: true,
  },
}
