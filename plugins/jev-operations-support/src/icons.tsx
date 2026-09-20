// `@material-ui/icons/*` deep-path modules are plain CommonJS with `__esModule: true`. When
// this plugin's own `dist/*.mjs` output (tsup's ESM build) imports one of them with a default
// import, a real webpack/Rspack host applies Node-style strict ESM->CJS interop: the "default"
// import resolves to the whole `module.exports` object (`{ default: Component }`), not the
// component itself, and React fails with "Element type is invalid ... got: object". The Vite
// playground doesn't reproduce this because Vite's dev/CJS interop is more lenient.
//
// To avoid the hazard entirely, we don't import from `@material-ui/icons` at all. These are
// minimal `SvgIcon`-based equivalents, built the same way every other MUI import in this plugin
// is done: a named import from the package root (`@material-ui/core`), which is ESM-safe.
import { SvgIcon, type SvgIconProps } from '@material-ui/core';

export function ExpandMoreIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z" />
    </SvgIcon>
  );
}

export function CloseIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
    </SvgIcon>
  );
}
