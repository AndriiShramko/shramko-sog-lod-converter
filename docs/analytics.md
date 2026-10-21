# Analytics contract (sog.flyreelstudio.eu)

Two layers, both free of personal data (no file names, no e-mails, no typed text, no IP addresses):

1. **Server counter** `POST /api/e` (`web/src/ui/api.ts` `track()`, `api/server.py` `EVENTS`): daily totals of a
   few allow-listed events, no cookies. Read with `python tools/reports/pull.py stats --days 30`.
2. **Google Analytics 4** `G-08SQDG920Y` (`web/src/ui/analytics.ts`), only after the visitor clicks *Accept*:
   Consent Mode basic, gtag.js is not requested before that. `gtag('config')` sends the one `page_view` of a page
   (nothing else sends `page_view`). `cookie_domain` = the host, cookies `_ga` / `_ga_08SQDG920Y`,
   ≤ 400 days (Chrome's cap; the property keeps data 14 months), Google signals and ad personalisation off.

**Withdraw:** *Cookie settings* in the footer of every page opens the banner again; *Decline* sets
`window['ga-disable-G-08SQDG920Y'] = true`, sends `consent update analytics_storage: denied`, deletes `_ga` and
`_ga_08SQDG920Y` on the host and the parent domains and stores `sog_consent = no` (no reload: a conversion may be
running). Decline and Accept have the same style and size.

**The id cannot be lost:** it is committed in `web/src/ga-id.json`; `web/scripts/post-build.mjs` and
`deploy/deploy.sh` refuse a build whose four language pages do not load exactly this id.

## GA4 events

Every event carries `site_lang`. No string ever goes into GA's numeric `value`.

| Event | Parameters | Sent when |
|---|---|---|
| `page_view` | (automatic) | gtag config, once per page load |
| `section_view` | `section_id` (hero, app, how, why, compare, status, limits, faq, agent, contact, privacy) | half of a section, or half of the screen, is visible; once per section |
| `cta_click` | `cta_id` (nav_how, nav_faq, nav_contact, github_repo, byline, book_call, linkedin, github_profile, coop, superspl_upload, convert_again), `cta_location` | click on an element with `data-cta` |
| `contact_click` | `method` (email, phone, whatsapp, telegram, messenger), `cta_location` | click on a mailto:/tel:/messenger link |
| `lang_switch` | `lang_to`, `cta_location` | language link (sent with `transport_type: beacon`) |
| `copy_prompt` | `cta_location` | the agent prompt was copied |
| `form_start` | `form_id` (lead, feedback) | GA Enhanced Measurement (form interactions), not our code |
| `form_step` | `form_id: lead`, `step` (role, email, consent) | each step reached once |
| `form_submit` | `form_id` (lead, feedback) | a complete form is sent |
| `generate_lead` | `form_id: lead`, `lead_type` (scanner, studio, developer, platform, investor, other) | only after `/api/lead` answered 2xx |
| `feedback_open` / `feedback_send` | `kind` (bug, idea) on send | dialog opened / report stored by the server |
| `file_selected` | `size_bucket`, `splats`, `sh` | a PLY header was read |
| `preset` | `preset` | a scene preset was picked |
| `convert_start` | `size_bucket`, `splats`, `levels`, `backend` (gpu, cpu), `mem`, `queue` | conversion starts |
| `convert_done` | `size_bucket`, `splats`, `levels`, `seconds`, `duration_bucket`, `ok`, `mb`, `queue` | archive written and verified |
| `convert_error` / `convert_cancel` | `stage`, `size_bucket`, `duration_bucket`, `queue` | conversion failed / was cancelled |
| `gpu_unavailable` | `reason` (no-adapter, device-error) | WebGPU could not be used |
| `save_fallback` | `method: opfs` | no save dialog: browser storage is used |
| `file_download_click` | `file_ext: zip`, `cta_location` (result, queue) | download of a finished archive |
| `queue_add` / `queue_start` / `queue_done` | `count` (+ `splats`, `preset` / `failed`, `seconds`) | queue actions |
| `exception` | `description` (≤ 100 chars, URLs and quoted text removed), `fatal: false` | this site's own script errors, ≤ 5 a page |

`size_bucket`: lt100m, 100m-1g, 1g-4g, 4g-16g, 16g-64g, gt64g. `duration_bucket`: lt1m, 1m-5m, 5m-30m, 30m-2h, gt2h.
