# LinkedIn personal-profile provider

Install from the Cupboard, register a LinkedIn developer app with OpenID Connect and Share on LinkedIn, and configure its callback and client registration in Settings → Integrations. Connect the member account and set `memberId` to its `userinfo.sub`. The host stores the grant, expires it and requests reauthorization; ordinary self-serve grants do not promise partner-only programmatic refresh.

The package supports text posts on the connected personal profile and deletion by post URN. It declares no organization posting, replies, comment reads or post reads. Those require additional platform approval. Its sync page is deliberately empty and makes no network request. Media uploads are not implemented. The Posts API version is pinned to `202608`, never derived from the clock.

Post creation sends one request. A transport error, 409/5xx, or success without a valid `x-restli-id` is reported as unconfirmed and is never automatically repeated inside the package. Deletes are idempotent: success confirms absence; 404 reports `deleted:false`. Destination, disclosure, account approval and quota gates stay in the host. Tokens are injected only by `host.fetch`.

Verification uses recorded HTTP fakes and the SDK kit. **Live verification pending.** No vendor calls are made by tests.

Primary references checked 2026-10-16: [Share on LinkedIn](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin), [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api). Reuses the SDK contract, host OAuth and generated daemon launcher.
