# YouTube API Services – Audit and Quota Extension

## Applicant and project

- Organization / brand: ZEVANORY
- Google Cloud project: `zevanory-gemini`
- OAuth app: `ZEVANORY Publisher`
- YouTube channel: `@ZEVANORY`
- Requested scopes: `https://www.googleapis.com/auth/youtube.upload` and `https://www.googleapis.com/auth/youtube`
- API client type: internal publishing automation for the brand's own channel

## Description of the API client

ZEVANORY Publisher is a first-party content publishing tool used only by ZEVANORY to upload and manage Shorts on ZEVANORY's own YouTube channel. It does not offer YouTube functionality to external users, does not read or aggregate third-party channel data, and does not sell, transfer, or use YouTube API data for advertising profiles.

The tool converts a ZEVANORY creative that has passed the brand's automated quality and compliance rubric into a 15–30 second vertical MP4, adds the approved title, description and campaign UTM, and uploads the video with `privacyStatus=private`. Public visibility remains unavailable until the application audit is accepted and the channel's release policy permits publication.

## Exact API use

1. Exchange the authorized refresh token at Google's OAuth token endpoint.
2. Call `channels.list(part=snippet,contentDetails,mine=true)` to verify that the authorized channel title is `ZEVANORY` and obtain its uploads playlist.
3. Call `videos.insert(part=snippet,status)` using a resumable upload to send a ZEVANORY-owned MP4.
4. Optionally call `playlistItems.list` and `videos.list` for idempotency and to read the status/metrics of videos uploaded by this same client to this same channel.
5. Store only the returned video ID, publication URL/status, timestamps and aggregate performance metrics required for the brand's own reporting.

## Users and data

The only user is the verified ZEVANORY channel owner/operator. The client does not support public sign-up and does not access third-party users' private data. It processes only ZEVANORY-owned creative files and metadata plus the IDs and aggregate metrics of videos uploaded to `@ZEVANORY`.

OAuth credentials and tokens are encrypted secrets in GitHub Actions and Cloudflare Workers. They are never written to logs, source control, artifacts or client-side code. Access is limited to the production automation workflow and the ZEVANORY Worker.

## Retention, deletion and revocation

Raw OAuth access tokens are kept only in process memory and expire normally. Refresh tokens remain in the secret stores until rotated or revoked. Publication evidence (video ID, URL/status, timestamp and aggregate metrics) is retained for operational audit. If authorization is revoked, the automation stops fail-closed. On a deletion request, stored YouTube-derived evidence is removed within 30 days, except minimal security/audit records required by law.

## Compliance and user control

- All uploads are content owned by ZEVANORY.
- No scraping, downloading of third-party videos, surveillance, enrichment or sale of YouTube data occurs.
- No API data is combined with unrelated personal data.
- The client follows the YouTube API Services Terms of Service and Developer Policies.
- The channel owner can revoke access at any time in the Google Account permissions page.
- A publication kill switch can stop automated publishing immediately.
- During audit, uploaded Shorts remain private.

## Quota request rationale

The expected steady-state volume is small: at most two Shorts per day, plus the minimum `channels.list`, `playlistItems.list` and `videos.list` calls needed for identity, idempotency and performance evidence. Additional quota is requested only to provide reliable first-party publishing without retries exhausting the default quota. The tool does not mass-upload, serve third parties or operate a multi-tenant publishing platform.

## Demo / reviewer steps

1. Authorize the OAuth app with the ZEVANORY owner account.
2. Run the manual `Activate Telegram and YouTube production channels` workflow.
3. Observe the `channels.list?mine=true` proof showing title `ZEVANORY` (tokens are masked).
4. Observe the F1 rubric result (`score >= 85`, `compliance = 100`) and the generated 1080×1920, 20-second MP4.
5. Observe `videos.insert` returning a `videoId` with `privacyStatus=private`.
6. Confirm the video in YouTube Studio for `@ZEVANORY`.

## Official policy references

- YouTube API Services Terms of Service: https://developers.google.com/youtube/terms/api-services-terms-of-service
- YouTube API Services Developer Policies: https://developers.google.com/youtube/terms/developer-policies
- Audit and quota extension form: https://support.google.com/youtube/contact/yt_api_form
- OAuth access management: https://myaccount.google.com/permissions
