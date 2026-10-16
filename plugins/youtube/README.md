# YouTube provider

Install from the Cupboard, enable YouTube Data API v3 on the existing Google OAuth app, and connect in Settings → Integrations. Configure `channelId`. The host holds and refreshes the Google grant and controls source access, quotas, retry and publication. Account consent and app verification may be required before a real account grants the scopes.

The package reads channel activities, top-level comments and every page of each thread's replies. Activity queries overlap the saved timestamp by one millisecond to cover either inclusive or exclusive `publishedAfter` semantics. Comment threads have no time filter: each pass rescans them, including old threads whose comments were edited. Inline reply previews are not mistaken for complete conversations; the package uses `comments.list(parentId=...)`. In-flight cursors keep original watermarks and emitted versions. Page bounds fail explicitly rather than reporting a truncated scan as complete.

Only `social.reply` is declared. YouTube replies address the top-level parent comment; a reply document retains its `replyToId` and video coordinates. The package calls `comments.insert` once, refuses a definite `canReply:false`, and does not invent a top-level-post, upload or delete capability. An unconfirmed write is never retried inside the package. A reply costs 50 quota units; the host's quota policy remains authoritative.

Verification uses recorded HTTP fakes and the SDK conformance kit. **Live verification pending.** Tests make no vendor calls.

Primary references checked 2026-10-16: [activities.list](https://developers.google.com/youtube/v3/docs/activities/list), [commentThreads.list](https://developers.google.com/youtube/v3/docs/commentThreads/list), [comments.list](https://developers.google.com/youtube/v3/docs/comments/list), [comments.insert](https://developers.google.com/youtube/v3/docs/comments/insert). Reuses the SDK provider contract, Google client registration and generated daemon launcher.
