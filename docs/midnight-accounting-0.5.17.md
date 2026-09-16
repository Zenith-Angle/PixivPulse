# Midnight accounting — 0.5.17

Daily growth uses Beijing time. One midnight observation serves two purposes: it closes the preceding day and establishes the new day's baseline. Date-only custom endpoints, and a datetime picker ending at 23:59, include that closing midnight. Actual stored timestamps are never rewritten.

The first observation within five minutes after midnight is an **estimated** shared boundary. Later observations keep their own timestamps. An observation outside that window is not silently treated as midnight. Yesterday's settlement exposes actual last-observation time, closed-work coverage, and complete / estimated / partial status. Missing measurements are not interpolated or converted to zero. Earlier history already lost to compaction cannot be recovered by this update.

Work and follower daily growth starts from today's first valid observation. With only one observation the count remains visible and the delta stays unknown. Confirmed unchanged pairs produce zero; declines remain negative. Portfolio increments sum changes within each work, excluding lifetime totals of newly discovered works; first observations of two different works do not constitute a measured interval. Today's movers and work status use daily growth. Agent time-pattern aggregation shares the near-midnight convention.

Automatic scheduling retains the existing fixed Beijing timetable. When a previous automatic run spans midnight, its pending midnight slot is retained until the run finishes, up to the five-minute window. It does not create parallel collection or replay stale midnight slots. Browser closure, sleep, disabled synchronization, authentication failures and collection latency can still prevent a complete day.

Retention planning now protects daily first/last observations' metric dependencies (including unchanged midnight readings) in frame storage, and daily endpoint samples in legacy storage. This task changes the planner only; it does not run maintenance against user data. Existing backup and source revalidation guards remain in place.

## Verification

- Reproduced the original failure before fixing: previous day +60 appeared as +50; today's follower +10 appeared as +20.
- Domain regressions cover exact and delayed midnight, date picker 23:59 closure, missing/late closure, unchanged midnight batches, one point, negative/zero growth, future-data exclusion, new works, staggered first observations, scheduled-run overlap, and compaction/readback invariance.
- Real headed Chromium exercised the actual React/ECharts components with deterministic fixture data in an isolated page: empty today, midnight-only, two observations, delayed midnight, missing midnight, negative growth, works, detail, custom range and comparison. Chinese and English 768px layouts were inspected. Screenshots are in `output/playwright/midnight-*.png`.
- Browser QA found and fixed ECharts disposal clearing React's reused empty-state element, plus clipped chart summaries. A single total point remains visible while its increment chart explains the missing second observation.
- TypeScript, production/store packaging and local-load artifact verification pass.
- The full suite retains three old UI assertion failures in `DashboardApp.test.tsx`: no observations expected the old “no growth” wording; follower today expected growth since yesterday evening; an elapsed-hour fixture near midnight expected yesterday's point inside today. UI tests were not rewritten under the user's no-UI-unit-test rule. Current behavior was verified in the browser. See `output/midnight-final-regression.json` for exact final counts.

## Runtime acceptance limit

The browser acceptance uses deterministic local fixtures, not the user's authenticated Pixiv account. The produced `.extension-dev/chrome-mv3` bundle must be reloaded in Chrome; an actual overnight collection has not been observed during this task. The store ZIP is `.output/pixiv-pulse-0.5.17-chrome.zip`.
