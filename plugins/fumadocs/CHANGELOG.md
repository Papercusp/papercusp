# `@papercupai/fumadocs` changelog

## 0.2.0 — renamed from `@papercupai/docs-viewer`

The plugin previously published as `@papercupai/docs-viewer` is now
`@papercupai/fumadocs`. The dashboard tab id moved from `docs` to
`fumadocs` (the `replaces: ["docs"]` semantic is preserved, so the legacy
hard-coded `docs` tab is still superseded once
`PAPERCUSP_TABS_FROM_PLUGINS=1` is set).

No behavior changes — this is purely a rename to reflect the actual
underlying docs framework (Fumadocs). The package's iframe URL still
defaults to `http://localhost:3055/docs` and remains overridable via
the `docsUrl` config key.

### Migrating an existing install

The on-disk slug changes (`~/.papercusp/global-plugins/docs-viewer/` →
`~/.papercusp/global-plugins/fumadocs/`), so a one-time uninstall +
reinstall is required:

```sh
papercusp uninstall docs-viewer
papercusp install @papercupai/fumadocs
papercusp plugin enable fumadocs --harness <slug>   # per harness
```

Per-harness plugin configs live at
`~/.papercusp/harnesses/<slug>/plugin-configs/<slug>.json` and key by
the on-disk dir basename, so any config you set under `docs-viewer.json`
needs to move to `fumadocs.json`. The shape is unchanged
(`{ "docsUrl": "..." }`).

If you've pinned the plugin in `papercusp.lock`, run
`papercusp upgrade-pin fumadocs --harness <slug>` after reinstalling.

## 0.1.1 — last release under the old name

Original `@papercupai/docs-viewer` release. Iframe-driven dashboard tab
embedding the harness's docs site at the configured `docsUrl`.
