/**
 * Token-cost plugin: one session reading in the composer dock and one per-turn
 * reading in each assistant message's action row. Both open the same click-open
 * details panel, and both are priced by the Host `tokenCost` projection, which
 * files every billed request under its own model and peak/off-peak period.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-plugin-token-cost',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useId, useRef, useState } = React

    // The portaled panel is an enhancement: without react-dom the panel renders
    // in place (fixed positioning still escapes the row's layout).
    let createPortal = null
    try {
      createPortal = require('react-dom').createPortal
    } catch {
      createPortal = null
    }

    const PACKAGE = 'dsh-plugin-token-cost'

    /** Groups beyond this count are summarized, keeping the panel readable. */
    const MAX_GROUPS = 4

    // ---------------------------------------------------------------------
    // 价格表：元 / 每百万 tokens，取自 DeepSeek 官方价格页
    //   https://api-docs.deepseek.com/zh-cn/quick_start/pricing
    //   查询日期 2026-11-18（DeepSeek-V4.1-Flash-1017 / V4-Pro-0813）
    //
    // 官方按北京时间分时段计价：
    //   高峰 = 周一至周五（不含法定节假日）9:00-12:00 与 14:00-18:00
    //   空闲 = 其余时段，含周末与节假日全天；空闲价为高峰价的一半
    //
    // 时段由 Host 投影按每条请求自己的时间判定。改价只改这里。
    // ---------------------------------------------------------------------
    const PRICING = {
      currency: '¥',
      fallbackModel: 'deepseek-flash',
      models: {
        'deepseek-flash': {
          label: 'DeepSeek-V4.1-Flash',
          peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
          offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
        },
        'deepseek-v4-pro': {
          label: 'DeepSeek-V4-Pro',
          peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
          offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
        },
      },
      aliases: {
        'deepseek-v4-flash': 'deepseek-flash',
        'deepseek-v4-flash-vision-exp': 'deepseek-flash',
      },
      cacheWritePerMillion: 0,
    }

    /**
     * Prices injected by the Host half for this page load, when its daily check
     * of the official page succeeded. Absent or malformed means the built-in
     * table above stands unchanged.
     */
    const INJECTED = (() => {
      const raw = globalThis.__DSH_TOKEN_COST__
      if (raw === null || typeof raw !== 'object') return null
      if (raw.models === null || typeof raw.models !== 'object') return null
      return raw
    })()

    /** Table in force: the Host's fetched rates merged over the built-ins, per model. */
    const MODELS = (() => {
      const merged = {}
      for (const [key, entry] of Object.entries(PRICING.models)) merged[key] = { ...entry }
      if (INJECTED === null) return merged
      for (const [key, entry] of Object.entries(INJECTED.models)) {
        const peak = entry?.peak
        const offPeak = entry?.offPeak
        const usable = ['cacheHit', 'cacheMiss', 'output'].every(metric =>
          [peak?.[metric], offPeak?.[metric]].every(value =>
            typeof value === 'number' && Number.isFinite(value) && value > 0))
        if (!usable) continue
        merged[key] = {
          label: merged[key]?.label ?? key,
          peak: { cacheHit: peak.cacheHit, cacheMiss: peak.cacheMiss, output: peak.output },
          offPeak: { cacheHit: offPeak.cacheHit, cacheMiss: offPeak.cacheMiss, output: offPeak.output },
        }
      }
      return merged
    })()

    /** Currency of the table in force. */
    const CURRENCY = INJECTED?.currency === '¥' ? '¥' : PRICING.currency

    /** When the fetched table was captured, for the panel's provenance line. */
    const PRICE_SOURCE = INJECTED === null ? null : String(INJECTED.fetchedAt ?? '')

    const CSS = `
      .dsh-token-cost { display: inline-flex; min-width: 0; }
      .dsh-token-cost--dock {
        font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
        line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
      }
      .dsh-token-cost__pill {
        display: inline-flex; align-items: center; gap: 6px; box-sizing: border-box;
        max-width: 100%; padding: 1px 8px; border: none; border-radius: var(--dsw-radius-sm);
        background: transparent; color: var(--dsw-alias-label-tertiary);
        font: inherit; font-variant-numeric: tabular-nums; line-height: inherit;
        white-space: nowrap; cursor: pointer;
      }
      .dsh-token-cost__pill svg { width: 14px; height: 14px; flex: none; }
      .dsh-token-cost__trigger {
        display: inline-flex; align-items: center; gap: 4px; min-width: 0;
        height: calc(28px + var(--dsh-content-font-delta, 0px)); padding: 6px 8px;
        border: none; border-radius: var(--dsw-radius-sm); background: transparent;
        color: var(--dsw-alias-label-tertiary);
        font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
        font-variant-numeric: tabular-nums;
        line-height: calc(24px + var(--dsh-content-font-delta, 0px));
        white-space: nowrap; cursor: pointer;
      }
      .dsh-token-cost__trigger svg {
        width: calc(15px + var(--dsh-content-font-delta, 0px));
        height: calc(15px + var(--dsh-content-font-delta, 0px));
        flex: none;
      }
      .dsh-token-cost__pill[aria-expanded='true'],
      .dsh-token-cost__trigger[aria-expanded='true'] {
        background: var(--dsw-alias-interactive-bg-hover);
      }
      @media (hover: hover) {
        .dsh-token-cost__pill:hover, .dsh-token-cost__trigger:hover {
          background: var(--dsw-alias-interactive-bg-hover);
          color: var(--dsw-alias-label-secondary);
        }
      }
      .dsh-token-cost__label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      .dsh-token-cost:focus-visible, .dsh-token-cost__trigger:focus-visible, .dsh-token-cost__pill:focus-visible {
        outline: 2px solid var(--dsw-alias-interactive-bg-hover);
        outline-offset: 1px; border-radius: var(--dsw-radius-sm);
      }

      /* Panel skin mirrors the host's stat dialog (stat-dialog.module.css). */
      .dsh-token-cost__panel {
        position: fixed; z-index: 1100; box-sizing: border-box;
        width: max-content;
        min-width: min(300px, calc(100vw - 24px));
        max-width: min(440px, calc(100vw - 24px));
        padding: 16px; border: 0; border-radius: var(--dsw-radius-lg);
        background: var(--dsw-specific-menu);
        backdrop-filter: var(--dsw-menu-backdrop-filter);
        --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
        box-shadow: var(--dsw-elevation-prominent);
        font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
        cursor: default;
        max-height: calc(100dvh - 12px - max(12px, var(--dsh-frame-overlay-top, 12px)));
        overflow-x: hidden; overflow-y: auto;
        --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
        --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
        position-area: none;
        top: max(12px, var(--dsh-frame-overlay-top, 12px));
        bottom: max(12px, calc(anchor(top) + 8px));
        left: max(12px, anchor(left));
        right: 12px;
        position-try-fallbacks: --dsh-token-cost-window, --dsh-token-cost-opposite,
          --dsh-token-cost-wide-opposite, --dsh-token-cost-tall, --dsh-token-cost-viewport;
        align-self: end; justify-self: start;
        height: fit-content; min-height: 0; margin: 0;
      }
      .dsh-token-cost__panelTitle {
        display: flex; justify-content: space-between; gap: 16px; margin-bottom: 8px;
        color: var(--dsw-alias-label-primary); font-weight: 500;
      }
      .dsh-token-cost__panelLabel { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
      .dsh-token-cost__panelLabel svg { width: 14px; height: 14px; flex: none; }
      .dsh-token-cost__panelValue { font-variant-numeric: tabular-nums; }
      .dsh-token-cost__rule { margin-bottom: 10px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
      .dsh-token-cost__group + .dsh-token-cost__group { margin-top: 12px; }
      .dsh-token-cost__groupTitle {
        display: flex; justify-content: space-between; gap: 16px; margin-bottom: 6px;
        color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums;
      }
      .dsh-token-cost__groupName { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      .dsh-token-cost__details {
        display: grid; grid-template-columns: minmax(76px, auto) minmax(0, 1fr);
        gap: 6px 16px; margin: 0; color: var(--dsw-alias-label-tertiary);
      }
      .dsh-token-cost__details dt, .dsh-token-cost__details dd { min-width: 0; margin: 0; }
      .dsh-token-cost__details dd {
        color: var(--dsw-alias-label-secondary);
        font-variant-numeric: tabular-nums; text-align: right;
      }
      .dsh-token-cost__rates {
        margin-top: 6px; color: var(--dsw-alias-label-tertiary);
        font-size: 11px; line-height: 16px;
      }
      .dsh-token-cost__note {
        margin-top: 10px; color: var(--dsw-alias-label-tertiary);
        font-size: 11px; line-height: 16px;
      }
      @position-try --dsh-token-cost-window {
        position-area: none;
        top: max(12px, var(--dsh-frame-overlay-top, 12px));
        bottom: max(12px, calc(anchor(top) + 8px));
        left: 12px; right: 12px; margin: 0;
        align-self: safe end; justify-self: safe end;
      }
      @position-try --dsh-token-cost-opposite {
        top: max(12px, calc(anchor(bottom) + 8px));
        bottom: 12px; align-self: start;
      }
      @position-try --dsh-token-cost-wide-opposite {
        top: max(12px, calc(anchor(bottom) + 8px));
        bottom: 12px; left: 12px; right: 12px;
        align-self: start; justify-self: safe end;
      }
      @position-try --dsh-token-cost-tall {
        position-area: none;
        top: max(12px, var(--dsh-frame-overlay-top, 12px));
        bottom: 12px; left: max(12px, anchor(left)); right: 12px; margin: 0;
        align-self: safe start; justify-self: start;
      }
      @position-try --dsh-token-cost-viewport {
        position-area: none;
        inset: max(12px, var(--dsh-frame-overlay-top, 12px)) 12px 12px; margin: 0;
        align-self: safe start; justify-self: safe end;
      }
    `

    const DICTS = {
      zh: {
        'pill.label': '≈{cost}',
        'period.peak': '高峰',
        'period.offPeak': '空闲',
        'model.unattributed': '未标注模型',
        'dialog.sessionTitle': '本会话费用',
        'dialog.turnTitle': '本轮费用',
        'dialog.groupTitle': '{model} · {period}',
        'dialog.uncached': '未命中输入',
        'dialog.cacheRead': '命中输入',
        'dialog.cacheWrite': '写入缓存',
        'dialog.output': '输出',
        'dialog.rates': '单价/百万：命中 {hit} · 未命中 {miss} · 输出 {out}（元）',
        'dialog.more': '另有 {count} 组模型/时段未列出',
        'dialog.noteBuiltin': '单价来自插件内置表（{time}）；高峰/空闲按每条请求的发生时间判定，法定节假日未单独识别',
        'dialog.noteAuto': '单价来自自动抓取（{time}）；高峰/空闲按每条请求的发生时间判定，法定节假日未单独识别',
        'dialog.mixedNote': '当前时段口径：投影尚未就绪，按空闲单价估算',
      },
      en: {
        'pill.label': '≈{cost}',
        'period.peak': 'peak',
        'period.offPeak': 'off-peak',
        'model.unattributed': 'unattributed model',
        'dialog.sessionTitle': 'Session cost',
        'dialog.turnTitle': 'Turn cost',
        'dialog.groupTitle': '{model} · {period}',
        'dialog.uncached': 'Uncached input',
        'dialog.cacheRead': 'Cached input',
        'dialog.cacheWrite': 'Cache write',
        'dialog.output': 'Output',
        'dialog.rates': 'Rates/1M: hit {hit} · miss {miss} · output {out} ({currency})',
        'dialog.more': 'Plus {count} more model/period groups',
        'dialog.noteBuiltin': 'Rates from the built-in table ({time}); peak/off-peak follows each request time, public holidays are not detected',
        'dialog.noteAuto': 'Rates fetched automatically ({time}); peak/off-peak follows each request time, public holidays are not detected',
        'dialog.mixedNote': 'Projection not ready yet: priced at the off-peak rate',
      },
    }

    /** Translate through the registered dictionaries when the locale seat is missing. */
    function fallbackTranslate(key, params) {
      const template = DICTS.zh[key] ?? key
      if (params === undefined || params === null) return template
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match))
    }

    /** Compact token count: 1234 → 1.2k, 1234567 → 1.23M. */
    function formatTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '0'
      if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
      if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
      if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
      return String(Math.round(value))
    }

    /** Money with a fixed decimal count, so a reading never changes width at a magnitude boundary. */
    function formatMoney(value, currency, digits) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return `${currency}${value.toFixed(digits)}`
    }

    /** Reading label: three decimals, with a lower bound instead of a misleading ¥0.000. */
    function formatReading(value, currency) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value > 0 && value < 0.0005) return `<${currency}0.001`
      return formatMoney(value, currency, 3)
    }

    /** Unit price without trailing zero noise (2, 0.3, 13.5). */
    function formatUnitPrice(value) {
      return String(Math.round(value * 1e6) / 1e6)
    }

    /** Resolve a provider-owned model id to a price-table key. */
    function resolveModelKey(model) {
      if (typeof model !== 'string' || model.length === 0) return PRICING.fallbackModel
      const last = model.split(/[:/]/).pop() ?? model
      const name = last.trim().toLowerCase()
      if (name.length === 0) return PRICING.fallbackModel
      const aliased = PRICING.aliases[name] ?? name
      return Object.prototype.hasOwnProperty.call(MODELS, aliased) ? aliased : PRICING.fallbackModel
    }

    /** Rate row for one model and period. */
    function rateFor(modelKey, period) {
      return MODELS[modelKey][period === 'peak' ? 'peak' : 'offPeak']
    }

    /** Cost of one bucket set at one rate row. */
    function costOf(buckets, rate) {
      return ((buckets.uncachedInputTokens ?? 0) / 1e6) * rate.cacheMiss
        + ((buckets.cacheReadTokens ?? 0) / 1e6) * rate.cacheHit
        + ((buckets.cacheWriteTokens ?? 0) / 1e6) * PRICING.cacheWritePerMillion
        + ((buckets.outputTokens ?? 0) / 1e6) * rate.output
    }

    /** Total tokens of one bucket set. */
    function totalOf(buckets) {
      return (buckets.uncachedInputTokens ?? 0)
        + (buckets.cacheReadTokens ?? 0)
        + (buckets.cacheWriteTokens ?? 0)
        + (buckets.outputTokens ?? 0)
    }

    /**
     * Turn projected rows into priced groups, costliest first.
     * @param rows - projection rows (provider/model/period + four buckets).
     * @returns priced groups; empty when no row carries tokens.
     */
    function groupsOf(rows) {
      if (!Array.isArray(rows)) return []
      return rows
        .map((row) => {
          const modelKey = resolveModelKey(row.model)
          const rate = rateFor(modelKey, row.period)
          return {
            model: typeof row.model === 'string' ? row.model : '',
            modelKey,
            period: row.period === 'peak' ? 'peak' : 'offPeak',
            rate,
            buckets: row,
            cost: costOf(row, rate),
            tokens: totalOf(row),
          }
        })
        .filter(group => group.tokens > 0)
        .sort((left, right) => right.cost - left.cost)
    }

    /** Whole-session fallback group used before the projection reaches the page. */
    function fallbackGroups(usage, selection) {
      const charged = selection?.lastUsed ?? selection?.next ?? null
      const modelKey = resolveModelKey(charged?.model)
      const rate = rateFor(modelKey, 'offPeak')
      return [{
        model: '',
        modelKey,
        period: 'offPeak',
        rate,
        buckets: usage,
        cost: costOf(usage, rate),
        tokens: totalOf(usage),
      }]
    }

    const totalCost = groups => groups.reduce((sum, group) => sum + group.cost, 0)

    /** Original ¥ mark drawn as an inline glyph, inheriting the trigger's color. */
    function CostIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          role: 'presentation',
        },
        h('path', { d: 'M5.2 4.4 8 7.9l2.8-3.5' }),
        h('path', { d: 'M5.6 7.2h4.8M5.6 9h4.8' }),
        h('path', { d: 'M8 7.9V12' }),
      )
    }

    /**
     * Trigger-anchored dialog seat: open state, anchor identity, Escape and
     * outside-click dismissal (the host's stat-dialog behaviour, reimplemented
     * here because Harness Client packages are not importable).
     */
    function useDialogSeat() {
      const [open, setOpen] = useState(false)
      const rootRef = useRef(null)
      const panelRef = useRef(null)
      const anchorName = `--dsh-token-cost-${useId().replace(/:/g, '')}`
      useEffect(() => {
        if (!open) return undefined
        const outside = (target) => {
          if (rootRef.current !== null && rootRef.current.contains(target)) return false
          if (panelRef.current !== null && panelRef.current.contains(target)) return false
          return true
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onPointerDown = (event) => {
          if (event.target instanceof Node && outside(event.target)) setOpen(false)
        }
        const onClick = (event) => {
          if (event.target instanceof Node && outside(event.target)) setOpen(false)
        }
        document.addEventListener('keydown', onKeyDown)
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('click', onClick, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('click', onClick, true)
        }
      }, [open])
      return { open, setOpen, rootRef, panelRef, anchorName }
    }

    /** One group's bucket rows plus the rates it was priced at. */
    function GroupBlock({ group, t, currency }) {
      const { buckets, rate } = group
      const modelLabel = group.model.length === 0
        ? MODELS[group.modelKey].label ?? group.modelKey
        : MODELS[group.modelKey].label ?? group.model
      const periodLabel = t(group.period === 'peak' ? 'period.peak' : 'period.offPeak')
      const rows = [
        ['dialog.uncached', buckets.uncachedInputTokens, (buckets.uncachedInputTokens ?? 0) / 1e6 * rate.cacheMiss],
        ['dialog.cacheRead', buckets.cacheReadTokens, (buckets.cacheReadTokens ?? 0) / 1e6 * rate.cacheHit],
      ]
      if ((buckets.cacheWriteTokens ?? 0) > 0 && PRICING.cacheWritePerMillion > 0) {
        rows.push([
          'dialog.cacheWrite',
          buckets.cacheWriteTokens,
          (buckets.cacheWriteTokens / 1e6) * PRICING.cacheWritePerMillion,
        ])
      }
      rows.push(['dialog.output', buckets.outputTokens, (buckets.outputTokens ?? 0) / 1e6 * rate.output])
      return h(
        'div',
        { className: 'dsh-token-cost__group' },
        h(
          'div',
          { className: 'dsh-token-cost__groupTitle' },
          h('span', { className: 'dsh-token-cost__groupName' },
            t('dialog.groupTitle', { model: modelLabel, period: periodLabel })),
          h('span', null, formatMoney(group.cost, currency, 4)),
        ),
        h(
          'dl',
          { className: 'dsh-token-cost__details' },
          rows.flatMap(([key, tokens, cost]) => [
            h('dt', { key: `${key}-dt` }, t(key)),
            h('dd', { key: `${key}-dd` },
              `${formatTokens(tokens ?? 0)} · ${formatMoney(cost, currency, 4)}`),
          ]),
        ),
        h(
          'div',
          { className: 'dsh-token-cost__rates' },
          t('dialog.rates', {
            hit: formatUnitPrice(rate.cacheHit),
            miss: formatUnitPrice(rate.cacheMiss),
            out: formatUnitPrice(rate.output),
            currency,
          }),
        ),
      )
    }

    /** The shared panel body: groups, an overflow note, and the provenance note. */
    function PanelBody({ groups, t, currency, mixed }) {
      const shown = groups.slice(0, MAX_GROUPS)
      return h(
        React.Fragment,
        null,
        ...shown.map((group, index) =>
          h(GroupBlock, {
            key: `${group.modelKey}-${group.period}-${group.buckets.provider}-${index}`,
            group,
            t,
            currency,
          })),
        groups.length > MAX_GROUPS
          ? h('div', { className: 'dsh-token-cost__note' },
            t('dialog.more', { count: groups.length - MAX_GROUPS }))
          : null,
        h('div', { className: 'dsh-token-cost__note' },
          mixed
            ? t('dialog.mixedNote')
            : t(PRICE_SOURCE === null ? 'dialog.noteBuiltin' : 'dialog.noteAuto', {
              time: PRICE_SOURCE === null ? '2026-11-18' : PRICE_SOURCE.slice(0, 16).replace('T', ' '),
            })),
      )
    }

    /** The portaled (or in-place) dialog surface. */
    function CostPanel({ seat, title, total, groups, t, currency, mixed }) {
      if (!seat.open) return null
      const panel = h(
        'div',
        {
          ref: seat.panelRef,
          className: 'dsh-token-cost__panel',
          role: 'dialog',
          'aria-label': title,
          style: { positionAnchor: seat.anchorName },
        },
        h(
          'div',
          { className: 'dsh-token-cost__panelTitle' },
          h('span', { className: 'dsh-token-cost__panelLabel' }, h(CostIcon), title),
          h('span', { className: 'dsh-token-cost__panelValue' }, formatMoney(total, currency, 4)),
        ),
        h('div', { className: 'dsh-token-cost__rule', 'aria-hidden': true }),
        h(PanelBody, { groups, t, currency, mixed }),
      )
      return createPortal === null ? panel : createPortal(panel, document.body)
    }

    /**
     * Composer dock entry: whole-session cost, matching the scope of the usage
     * pill beside it.
     * @param props - Session-scope standard props plus the bound locale seat.
     */
    function CostPill(props) {
      const seat = useDialogSeat()
      const readProjection = props.useProjection ?? (() => undefined)
      const ledger = readProjection('tokenCost')
      const usage = readProjection('tokenUsage')
      const selection = readProjection('modelSelection')
      const t = typeof props.t === 'function' ? props.t : fallbackTranslate
      const currency = CURRENCY

      let groups = []
      let mixed = false
      if (ledger !== null && ledger !== undefined && Array.isArray(ledger.rows)) {
        groups = groupsOf(ledger.rows)
      }
      if (groups.length === 0) {
        if (usage === undefined || usage === null || totalOf(usage) === 0) return null
        groups = fallbackGroups(usage, selection)
        mixed = true
      }
      const total = totalCost(groups)
      if (!(total > 0)) return null
      const title = t('dialog.sessionTitle')

      return h(
        React.Fragment,
        null,
        h('style', { key: 'token-cost-style' }, CSS),
        h(
          'span',
          {
            key: 'token-cost-pill',
            ref: seat.rootRef,
            className: 'dsh-token-cost dsh-token-cost--dock',
            'data-composer-stat': PACKAGE,
            style: { anchorName: seat.anchorName },
          },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-token-cost__pill',
              'aria-haspopup': 'dialog',
              'aria-expanded': seat.open,
              'aria-label': `${title} ${formatMoney(total, currency, 4)}`,
              onClick: () => { seat.setOpen(!seat.open) },
            },
            h(CostIcon),
            h('span', { className: 'dsh-token-cost__label' },
              t('pill.label', { cost: formatReading(total, currency) })),
          ),
        ),
        h(CostPanel, { key: 'token-cost-panel', seat, title, total, groups, t, currency, mixed }),
      )
    }

    /** Reverse lookup: the Turn that produced one durable assistant message. */
    function turnOfMessage(snapshot, messageId) {
      const turns = snapshot?.timeline?.turns
      if (turns === undefined || turns === null || typeof turns.forEach !== 'function') return undefined
      let found
      turns.forEach((entry, turn) => {
        if (found !== undefined) return
        const tail = entry?.data?.get?.('turn-tail')
        if (tail?.closing?.finalNode?.messageId === messageId) found = turn
      })
      return found
    }

    /**
     * Assistant action-row entry: this Turn's cost, seated in the message's
     * icon row next to the shipped usage trigger.
     * @param props - Session-scope standard props, the owner's messageId, locale seat.
     */
    function TurnCostAction(props) {
      const seat = useDialogSeat()
      const readProjection = props.useProjection ?? (() => undefined)
      const useChat = typeof props.useChat === 'function' ? props.useChat : (() => undefined)
      const messageId = props.messageId
      const turn = useChat(snapshot => turnOfMessage(snapshot, messageId))
      const ledger = readProjection('tokenCost')
      const t = typeof props.t === 'function' ? props.t : fallbackTranslate
      const currency = CURRENCY

      if (typeof turn !== 'number' || ledger === null || ledger === undefined) return null
      const entry = Array.isArray(ledger.turns)
        ? ledger.turns.find(candidate => candidate.turn === turn)
        : undefined
      const groups = groupsOf(entry?.rows)
      if (groups.length === 0) return null
      const total = totalCost(groups)
      if (!(total > 0)) return null
      const title = t('dialog.turnTitle')

      return h(
        React.Fragment,
        null,
        h('style', { key: 'token-cost-style' }, CSS),
        h(
          'span',
          {
            key: 'token-cost-turn',
            ref: seat.rootRef,
            className: 'dsh-token-cost',
            style: { anchorName: seat.anchorName },
          },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-token-cost__trigger',
              'aria-haspopup': 'dialog',
              'aria-expanded': seat.open,
              'aria-label': `${title} ${formatMoney(total, currency, 4)}`,
              onClick: () => { seat.setOpen(!seat.open) },
              'data-turn-cost': turn,
            },
            h(CostIcon),
            h('span', { className: 'dsh-token-cost__label' },
              t('pill.label', { cost: formatReading(total, currency) })),
          ),
        ),
        h(CostPanel, { key: 'token-cost-turn-panel', seat, title, total, groups, t, currency, mixed: false }),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(PACKAGE, DICTS), 'token-cost: dictionaries')
        // A fresh id adds a cell beside the shipped activity/usage pills instead
        // of replacing one; order 2 puts it directly after the usage reading.
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: PACKAGE,
          order: 2,
          locale: PACKAGE,
        }, CostPill))
        // One entry in each completed message's icon row, next to its usage pill.
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: PACKAGE,
          order: 0,
          locale: PACKAGE,
        }, TurnCostAction))
      },
    }
  },
})
