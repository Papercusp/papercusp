# TikTok Display API provider

Install from the Cupboard and register a TikTok app with Login Kit and Display API approval. Add its client key and secret in Settings → Integrations, connect the account, and configure its `openId`. Tokens and refresh stay in the host. The package uses the generic OAuth descriptor's `client_key` parameter and comma-separated scopes.

This package reads the connected user's public videos. It declares no posting, reply, deletion or comment-reading capability and requests no Content Posting scopes. A comment count is metadata, not access to the comments. Cover image URLs expire and are marked accordingly. Video captions may be absent. Changing counters do not change a record's version; caption edits have no documented revision marker and are not replayed.

Each completed pass restarts at the newest page. TikTok's paging cursor is a timestamp in milliseconds that moves backwards only within that pass. The saved watermark uses `create_time` in seconds plus ids at that boundary. Equal-second videos remain eligible across pages. Resume keeps the original watermark until the pass completes. Repeating cursors and page-bound overflow fail explicitly without reporting a successful truncated scan.

Verification uses recorded HTTP fakes and the SDK conformance kit. **Live verification pending.** Tests make no vendor calls.

Primary references checked 2026-10-16: [video list](https://developers.tiktok.com/doc/tiktok-api-v2-video-list), [web login](https://developers.tiktok.com/doc/login-kit-web/), [token management](https://developers.tiktok.com/doc/oauth-user-access-token-management/), [identity](https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info/). Reuses the SDK provider contract, generic host OAuth flow and generated daemon launcher.
