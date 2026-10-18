---
name: download-wechat-channels
description: Use when a user requests 视频号 or WeChat Channels account/video search, creator-video collection, or authorized batch downloads through an existing local wx_channel service. Not for 公众号 articles, WeChat messages, private or paid content, or fully headless discovery without native WeChat.
---

# Download WeChat Channels

Use the bundled Node.js adapter for the existing wx_channel local APIs. Read [README.md](README.md) for prerequisites and examples; read [references/api-contract.md](references/api-contract.md) when diagnosing endpoint or pagination compatibility.

## Workflow

1. Confirm the requested creator/content and that the user may download it. The service and native WeChat must already be configured by the user. Run `node scripts/channels.mjs status` from this skill directory. `connected` alone is not readiness. A missing capability count is unproven, not ready.
2. Search accounts or videos. For creator archives, show matching nickname plus exact `username`; resolve meaningful same-name ambiguity with the user before collecting.
3. Collect to a new manifest path outside this repository. Pagination follows opaque cursors, not page numbers. Report `complete:false` and its reason at a limit or cursor anomaly; a short page is not proof of completion. IDs remain strings; never pass long IDs through JavaScript Number or spreadsheet numeric cells.
4. For an authorized download request, run `download --manifest ... --out receipt.json`. It re-fetches video profiles, submits one batch of at most 500 videos and preserves a receipt. Submission is not download success. It refuses active batches instead of clearing or replacing them. For larger selections, use user-approved disjoint manifests and verify each batch before starting the next.
5. Run `verify --receipt ... --out verification.json`. This correlates exact IDs, waits for terminal states, locates backend download records, checks actual files and sizes, then uses ffprobe when available. Without ffprobe, files are size-only evidence and remain unverified. A timeout does not cancel the backend batch.

```powershell
node scripts/channels.mjs search-accounts --keyword "青苗讲师团" --max-pages 5 --out D:/archive/accounts.json
node scripts/channels.mjs collect --username "EXACT_USERNAME" --max-pages 100 --out D:/archive/videos.json
node scripts/channels.mjs download --manifest D:/archive/videos.json --out D:/archive/receipt.json
node scripts/channels.mjs verify --receipt D:/archive/receipt.json --out D:/archive/verification.json
```

## Boundaries and reporting

- Stop on missing native-page readiness; ask the user to open the supported Channels page manually. Do not launch WeChat, install certificates, start or widen a proxy, disable security, or intercept chat traffic.
- Use only literal loopback API origins. Optional auth is read from `WX_CHANNEL_TOKEN`, never command arguments. Do not print/store cookies, tokens, signed media URLs, decode keys, raw responses, or application logs. Runtime manifests contain only selected metadata; media credentials stay in memory.
- No private/paid access bypass, authentication bypass or CAPTCHA evasion. Respect ownership, platform terms and the user's requested scope.
- Final result must distinguish collected count/completeness, submitted count, verified files, failed/unverified IDs, and actual local paths. Do not say “全部下载成功” until collection is complete and every selected file is verified.
- Backend field/API drift can break compatibility. Do not invent endpoints or silently treat unknown JSON shapes as an empty complete result. Existing source-level rounding cannot be repaired by converting an already-rounded ID to a string.
