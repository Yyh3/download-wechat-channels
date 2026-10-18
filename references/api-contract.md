# wx_channel API contract

Source audit target: `nobiyou/wx_channel`, v5.7.13 working source based at Git commit `434bb4df364b9e9a69e10f42cfe94e63c5eee13d`. Only the Channels files listed below define this adapter; unrelated local public-account experiments are not dependencies.

| Operation | Method/path | Key fields / response |
| --- | --- | --- |
| Capability status | GET `/api/channels/status` | `connected`, `search_ready_clients`, `feed_ready_clients`, `profile_ready_clients` |
| Account search | GET `/api/channels/contact/search` | `keyword`, `next_marker`; finderSearch Type=1 / Scene=13, `data.infoList` |
| Video search | GET `/api/channels/feed/search` | `keyword`, `next_marker`; Type=3 / Scene=19, `data.objectList` |
| Creator list | GET `/api/channels/contact/feed/list` | `username`, `next_marker`; finderUserPage, `data.object` |
| Video profile | GET `/api/channels/feed/profile` | string `object_id`, `nonce_id`; `data.object.objectDesc.media[0]` |
| Batch state | GET `/__wx_channels_api/batch_progress` | `tasks[]`: string `id`, `status` pending/downloading/done/failed |
| Batch submit | POST `/__wx_channels_api/batch_start` | `videos[]`: id, title, author, url, key; `forceRedownload:false`; shared backend state |
| Locate files | GET `/api/downloads?page=1&pageSize=100` | `items[]`: `videoId`, `status`, `filePath`; `total`, `totalPages` |

Search handlers use `{code:0,data:...}`; download-record console handlers use `{success:true,data:...}`. The search `data` itself contains upstream `{errCode:0,data:{...}}`. HTTP 200 does not prove that either envelope succeeded. Errors are reported as codes without reflecting potentially sensitive raw upstream messages.

Empty batch exception: `HandleBatchProgress` declares `var allTasks []map[string]interface{}` without allocation, so an initial empty batch returns `tasks:null,total:0`. Only that exact pair is normalized to `[]`; missing tasks or other non-array values fail closed. Native `/api/channels/*` requests reserve serialized 1000 ms pacing slots; test-only wait injection avoids actual delays in pacing tests and is not exposed by the CLI.

Cursor detail: injected `api_client.js` applies `decodeURIComponent(body.next_marker)` after ordinary HTTP query decoding. Therefore the CLI sets `next_marker=encodeURIComponent(rawCursor)` through URLSearchParams (which adds HTTP percent encoding). This preserves percent escapes, plus signs and signatures after the injected decode. Do not simplify to raw URL concatenation or decode the opaque cursor yourself.

List fields are validated; aliases observed in related interfaces are accepted, unknown shapes fail. `lastBuffer` (or `lastBuff`) is the cursor. A present cursor continues unless `continueFlag` explicitly ends; missing cursor while `continueFlag=1`, repeated cursor, or page limit returns `complete:false`.

Source files inspected:

- `internal/api/search.go`: aliases, request structs, finder bridge calls, readiness fields.
- `internal/assets/inject/api_client.js`: actual finderSearch/finderUserPage calls and cursor decoding.
- `internal/handlers/batch.go`: batch start/progress payloads, busy check, terminal states.
- `internal/handlers/console_api.go`, `internal/database/models.go`: file records and pagination.
- `internal/assets/inject/download.js`: signed media URL/token join behavior; only query structure escapes `%26`, `%3D`, `%3F` are decoded, not signature bytes like `%2F`.

`/api/queue` is deliberately not used: adding a record to a queue is not evidence the existing batch downloader is executing it. Do not use endpoint names from an unrelated tool or claim these are public Tencent APIs.

Verification is read-only: match exact video ID; require completed record and real regular nonempty file; ffprobe with local-only protocol whitelist requires MP4-family container, video stream and positive duration. No automatic backend complete/fail mutation occurs. Batch disappearance is unknown state, not success. Timeout leaves the backend untouched.
