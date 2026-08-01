# Contributing

Thanks for taking a look. Issues and pull requests are welcome.

## Getting set up

You need a UniFi Protect console with a **UP-AirQuality** sensor, a local console
account without MFA, and a ClickHouse instance.

```bash
cp .env.example .env    # fill in your console + ClickHouse details
npm install
npm run dev
```

Open `/onboarding` — it checks every dependency and tells you what is missing.

`tools/stream.py` is the quickest way to confirm your console credentials work
before involving the web app at all:

```bash
python3 tools/stream.py --once
```

## Before opening a PR

```bash
npm run typecheck
npm run build
```

Both run in CI. There is no test suite yet — if you want to add one, that is a
genuinely useful contribution.

## Things worth knowing

- **Never commit `.env`.** It holds console and database credentials. It is
  gitignored; keep it that way.
- **`lib/protect.ts` decodes an undocumented protocol.** The frame format was
  derived by observation, not from documentation, and Ubiquiti can change it in
  any Protect release. If a firmware update breaks ingestion, that decoder is
  the first place to look.
- **Severity thresholds are sourced, not invented.** Each entry in
  `lib/metrics.ts` carries a `source` field naming the standard behind it. If a
  metric has no defensible public band, leave `thresholds` off — the UI falls
  back to the status word the sensor itself reports. Please do not add made-up
  numbers; an honest "no published bands" is better.
- **Dedupe means row counts differ per metric.** A metric is only written when
  its value changes. `/api/series` carries the last value forward to compensate.
  Keep that in mind before "fixing" a query that looks sparse.
- **Charts are small multiples on purpose.** These metrics span wildly different
  scales, so they never share a second y-axis.

## Reporting a problem

Include your Protect version (`/api/health` reports it), the sensor firmware,
and anything the collector logged. Please redact credentials, tokens, and
cookies from anything you paste.
