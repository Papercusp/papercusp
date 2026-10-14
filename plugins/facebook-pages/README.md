# Facebook Pages provider

Install this package from the Cupboard and connect it in Settings → Integrations. Register a Meta app with Facebook Login for Business and configure its callback and declared scopes. Development-mode accounts must have an app role; other accounts require Meta review. Set the source's `pageId` before syncing.

The host holds the user grant, selects that Page from `/me/accounts`, requires `MODERATE` and `CREATE_CONTENT`, and injects the Page token. The package never receives either credential or the token collection. It uses only `host.fetch`; the host commits cursors, admits records, and controls retries and backoff.

Posts, comments and nested replies become `social-post` records with the original ids and timestamps. Events are `ext:facebook-pages:post`, `ext:facebook-pages:comment` and `ext:facebook-pages:reply`, matching the existing `social-facebook-pages` trigger pack. Posts use `updated_time` when supplied, so edits become new deliveries. Captionless records preserve empty text and `textAbsent`; no text is invented.

The published-post edge is ranked. A pass reads at most 20 pages of 100 posts and filters each record independently. It watches comments on at most 25 posts encountered in that scan, with at most 10 pages of 100 comments per post, using `filter=stream` to include nested replies. Empty pages with a continuation are followed. These bounds can be lowered in source config. Posts beyond the scan bound and comments outside the watch window are not covered. The comment API supplies no edit timestamp, so comment edits are not redelivered. Remote deletes are not discovered by this rescan.

`social.post` publishes text to the configured Page; `social.reply` replies to a post or comment; `social.delete` reports the API's deletion result. Writes request a server id and permalink in the creation response. Facebook provides no server-side idempotency for post/reply. This package makes one request and never retries an ambiguous write; a timeout or unconfirmed response needs reconciliation before another publish attempt. The host's destination, disclosure and publish gates run before invocation.

Verification: recorded HTTP fakes, the shared SDK conformance kit, and the real loader plus generic Integrations model. **Live verification pending** on Avi's account (plan P-029). A package installation is not a live-account attestation.
