# Instagram provider

Install this package from the Cupboard and connect it in Settings → Integrations. It uses Instagram API with Facebook Login for Business, so the host holds the Facebook user grant and the package receives only `host.fetch`.

The package reads a bounded set of media and each media's newest comments. The API returns at most 50 comments per query and does not provide a replay cursor for older comments; the package records a `lossRisk` fault when a full window can no longer prove that the stored watermark is covered. Replies are expanded and become `ext:instagram:reply` records.

Instagram is media-primary: `social.post` refuses text-only and carousel requests, creates one media container, checks its status once per minute for at most five minutes, and publishes only after `FINISHED`. The package probes container status after an ambiguous publish and reports the observation without republishing. `social.reply` uses the comment replies edge and refuses hidden comments. `social.delete` verifies a comment object before deleting it; media deletion is unverified and is not advertised. Permalinks are returned only when the server supplies them.

The newest-50 bound cannot recover older comments that fell out of the window. On a measured overflow the package raises a source fault before advancing the cursor, and never claims complete coverage. Cold backfill covers only the visible window. Comment edits and remote deletions are not discovered. Media outside the configured watch window is not covered; mentions outside these comments are not read yet.

Verification: recorded HTTP fakes and the shared provider conformance kit. **Live verification pending** on Avi's account (plan P-029).
