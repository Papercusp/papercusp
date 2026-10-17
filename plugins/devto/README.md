# dev.to publishing provider

Installs as a sandboxed daemon using the shared provider SDK. Settings → Integrations shows the declared API-key field; the key stays in the host's protected credential store. The host injects `api-key` only for `dev.to`.

`blog.post` accepts `{title, markdown, canonicalUrl, published?, tags?}`. `published` defaults to `false`; only the boolean `true` publishes. `canonicalUrl` must be an HTTPS URL on `papercusp.com`, without credentials, a custom port or a fragment. YAML front matter is refused because Forem can use it to override publication and canonical metadata. Titles are limited to 128 characters, Markdown to 80,000 bytes and tags to four distinct lowercase alphanumeric strings.

Agents call `blog:post` with `providerId:"devto"`, the connected `sourceId`, these content fields, and trusted `addressee` provenance. Drafts are stored at dev.to. Public publication also requires the existing `papercusp-social-auto-publish` owner setting; when it is off, the tool returns `withheld` with the resolved destination. It always checks personal access and disclosure before sending content.

One create request returns `{externalId, published, canonicalUrl, url?}`. Transport failures, 409, server errors and malformed success responses remain ambiguous; callers must reconcile before another create. The package never retries or owns quota/backoff policy. It declares no read, update or delete capability.

Contract checked 2026-10-17 against the [official Forem API](https://developers.forem.com/api/v1) and [primary schema](https://raw.githubusercontent.com/forem/forem/main/swagger/v1/api_v1.json). Verified with recorded fakes, the shared conformance kit and package installation tests. **Not live-verified**; no article was sent to a vendor during implementation.
