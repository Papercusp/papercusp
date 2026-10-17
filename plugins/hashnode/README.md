# Hashnode publishing provider

Installs as a sandboxed daemon using the shared provider SDK. Settings → Integrations shows the declared personal-access-token field; the host stores the token and supplies it as an Authorization Bearer value only to `gql.hashnode.com`. Configure the target `publicationId` on the source.

`blog.post` accepts `{title, markdown, canonicalUrl, published?, tags?}`. It creates a draft by default using `createDraft`; explicit boolean `published:true` uses `publishPost`. Both send `originalArticleURL` pointing to HTTPS `papercusp.com`. The publication always comes from persisted source configuration. Titles are limited to 128 characters, Markdown to 80,000 bytes and tags to 15 distinct lowercase slugs; the complete JSON request must fit the vendor's 100 KB ceiling.

Hashnode's current API requires an active **Pro publication** for draft and publication mutations, and an appropriate author/editor role for direct publication. Missing credentials, permission or Pro access are surfaced without retrying. This package does not purchase or upgrade a plan. It declares no read/update/delete or contributor-review capability.

Returns `{externalId, published, canonicalUrl, url?}`. Draft creation returns its real ID without inventing a public URL. Transport failures, server errors, partial GraphQL data/errors or malformed success responses remain ambiguous; reconcile them before another create. No retries or host quota policy live in the package.

Contract checked 2026-10-17 against Hashnode's [primary schema](https://github.com/Hashnode/gql-skill/blob/291402fbfd8bab56c4d87754a6a590f724822d78/skills/gql-api/references/schema.graphql), [authentication reference](https://github.com/Hashnode/gql-skill/blob/291402fbfd8bab56c4d87754a6a590f724822d78/skills/gql-api/references/auth-and-roles.md) and [mutation reference](https://github.com/Hashnode/gql-skill/blob/291402fbfd8bab56c4d87754a6a590f724822d78/skills/gql-api/references/mutations.md). Verified with fakes, the shared conformance kit and installation tests. **Not live-verified**; no content was sent to a vendor.
