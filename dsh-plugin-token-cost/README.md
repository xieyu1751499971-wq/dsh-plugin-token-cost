# Token cost

Shows what a session's tokens cost, at DeepSeek's official rates — per model and
per price period — in two places: a session reading beside the composer statistics
pills, and a per-turn reading in each completed message's action row. Both open a
click-through details panel.

## Requirements

- DeepSeek Harness with the Web UI. Verified against `@deepseek-ai/dsh` `0.2.2-rc.3`
  on the Desktop profile.
- Node 20 or newer only for running the tests; the plugin itself needs nothing extra.

## Installation

This bundle is used from a local directory; it is not published to npm.

1. Put this directory on the machine running DSH (clone or download and unzip).
2. In DSH open **Plugins** → **Add plugin** and pick this directory. An agent session
   can do the same with the `plugin_manager` `install_bundle` action and this
   absolute path as the target.
3. **Restart DSH once.** The Host half registers the `tokenCost` projection and
   starts tracking the price page at startup; a page reload is enough for
   Client-only edits later.

Disable or remove the `token-cost` row in **Plugins** to uninstall.

## Where the readings appear

| Reading | Location | Scope |
|---|---|---|
| `≈¥2.753` | composer dock, directly after the shipped usage pill | whole session |
| `≈¥0.041` | assistant message action row, next to the shipped usage pill | that turn |

Clicking either trigger opens the same kind of anchored panel: the total, then one
block per model/period group with its four bucket subtotals and the unit rates it
was priced at. Escape, an outside click, or a second click on the trigger closes
it.

The `≈` is deliberate: this is an estimate from a published price table, not a
copy of a bill.

## Where the prices come from

[DeepSeek 模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing),
retrieved 2026-11-18, 元 per **one million** tokens:

| model | period | cache hit | cache miss | output |
|---|---|---|---|---|
| `deepseek-flash` (V4.1-Flash) | 高峰 peak | 0.04 | 2 | 8 |
| `deepseek-flash` (V4.1-Flash) | 空闲 off-peak | 0.02 | 1 | 4 |
| `deepseek-v4-pro` | 高峰 peak | 0.30 | 9 | 27 |
| `deepseek-v4-pro` | 空闲 off-peak | 0.15 | 4.5 | 13.5 |

Peak is Beijing time Monday–Friday 09:00–12:00 and 14:00–18:00, excluding Chinese
public holidays; everything else is off-peak at half the peak rate. Cache writes
are not charged separately.

The table in `client.js` is a **fallback**. The Host half checks the official page
once a day and injects whatever it last validated successfully; see
[Automatic price refresh](#automatic-price-refresh).

## Architecture

One Host session projection (`tokenCost`) does the accounting, so it covers the
whole durable log and survives paging and compaction. It publishes two views:

- `rows` — session totals split by route and period;
- `turns` — the same split per turn, which is what the per-message reading uses.

Fold rules:

- `assistant/message` settles billed usage and names its route
  (`source.provider` / `source.model`); `assistant/attempt` reports usage before
  the route is known.
- A later event for the same turn/step **replaces** the earlier one, and
  `llm/retry-started` frees the slot so a retried attempt counts separately — the
  same rules as the shipped `tokenUsage` unit.
- Each settlement is filed under its own peak/off-peak period from the event time.
- Usage reported without a route lands in an unattributed row so the total stays
  equal to the adjacent usage pill's token count.

The Client only multiplies rows by the table and renders; `test/fold.test.mjs`
exercises the fold offline (15 cases: replacement, retries, per-turn split,
period classification, total conservation).

### Loading zod without a resolution path

A linked local bundle resolves imports from its own directory, so the profile's
`node_modules` is unreachable (`ERR_MODULE_NOT_FOUND`, verified). The Host half
imports the Harness's own zod by absolute path, derived from `DSH_INSTALL_DIR`,
the process arguments, or the packaged `resources` layout — which also keeps the
schema an instance of the same zod module the registry validates with.

## Changing the prices

Everything lives in the `PRICING` constant at the top of `client.js`:

```js
const PRICING = {
  currency: '¥',
  fallbackModel: 'deepseek-flash',
  models: { /* one row per model, peak and offPeak rates */ },
  aliases: { 'deepseek-v4-flash': 'deepseek-flash' },
  cacheWritePerMillion: 0,
}
```

Adding a model is one more row under `models`. After editing `client.js`, reload
the page; editing the Host half (`index.js`, `projection.js`) needs a restart.

## Automatic price refresh

The Host half keeps the rates current on its own:

- Fetches `https://api-docs.deepseek.com/zh-cn/quick_start/pricing/` — the Chinese
  page, because the English one is priced in USD.
- Checks once a day, and immediately at startup when the cached table is older
  than 12 hours.
- Parses the pricing block out of the rendered table and validates it before use:
  both models present, all six rates per model, every rate plausible
  (`0 < p < 1000`), currency `¥`, and off-peak equal to half of peak within 1% —
  a relation the page itself states, so it catches a mis-shifted column.
- On any failure it logs once and keeps the previous table: a stale price is far
  better than a wrong one.
- Persists the table to `~/.dsh/storages/token-cost-pricing.json`, so a restart
  keeps working offline.
- Injects the current table into each page load as `window.__DSH_TOKEN_COST__`;
  the Client merges it over the built-in table per model.

The panel's last line says where the rates came from and when: "单价来自自动抓取
（2026-11-18 16:12）" or "单价来自插件内置表（2026-11-18）".

Network: one `GET` to the official documentation page. No local data, session
content, or credentials are sent.

## Limitations

- **Public holidays are not detected.** A weekday holiday is priced as peak.
- **Price changes apply on the next page load**, not mid-render; the reading keeps
  using the table that was injected when the page booted.
- **Unattributed usage** is priced at `fallbackModel` and labelled "未标注模型".
- The panel shows up to four model/period groups; the rest are summarized.
- No prompt-image, tool-call, or subscription accounting beyond the four buckets.
- Both triggers hide themselves while their scope has billed nothing.
- The per-message reading needs the message's turn to be in the loaded window;
  outside it, no reading is rendered (the session reading is unaffected).

## What it touches

Local data only: the Host projection folds session events; the Client reads that
projection and registers two slot entries. No model requests, and the only
outbound request is the daily `GET` of the price page described above. Disabling
the plugin removes both readings, the projection, and the dictionaries.

## Tests

```
node test/fold.test.mjs      # 15 cases: replacement, retries, per-turn split, periods
node test/pricing.test.mjs   # 10 cases: table parsing and rejection rules
```

Both are plain Node scripts with no dependencies and no network access; the
pricing cases run against the HTML fixtures in `test/fixtures/`.

## License

MIT — see [LICENSE](LICENSE).
