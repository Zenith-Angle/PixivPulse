import type { EChartsCoreOption } from "echarts/core";

const TREND_POINT_COUNT = 512;
const GAUSSIAN_TAP_COUNT = 97;
const GAUSSIAN_SIGMA_FACTOR = 4.5;
const BANDWIDTH_DIVISOR = 40;
const SUPPORT_RADIUS = 3;

type NumericTuple = readonly [number, number, ...unknown[]];
type NumericPair = [number, number];
type ObjectRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is ObjectRecord => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const finiteNumber = (value: unknown): value is number => (
  typeof value === "number" && Number.isFinite(value)
);

const readNumericTupleData = (value: unknown): NumericTuple[] | undefined => {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const points: NumericTuple[] = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length < 2 || !finiteNumber(item[0]) || !finiteNumber(item[1])) return undefined;
    points.push(item as unknown as NumericTuple);
  }
  return points;
};

const isCartesianLine = (series: ObjectRecord): boolean => (
  series.type === "line" && (series.coordinateSystem === undefined || series.coordinateSystem === "cartesian2d")
);

const encodeIndexIs = (value: unknown, expected: number): boolean => (
  value === undefined || value === expected
);

const supportsTupleEncoding = (series: ObjectRecord): boolean => {
  if (series.encode === undefined) return true;
  if (!isRecord(series.encode)) return false;
  return encodeIndexIs(series.encode.x, 0) && encodeIndexIs(series.encode.y, 1);
};

const supportsTupleLine = (series: ObjectRecord): boolean => (
  isCartesianLine(series) && supportsTupleEncoding(series)
);

const seriesList = (option: EChartsCoreOption): unknown[] => {
  const series = option.series as unknown;
  if (series === undefined || series === null) return [];
  return Array.isArray(series) ? series : [series];
};

const validPairs = (points: readonly NumericTuple[]): NumericPair[] => points.map((point) => [point[0], point[1]]);

interface NormalizedPoints {
  display: NumericPair[];
  unique: NumericPair[];
}

/** Keep the original order for fallback display, while using the last y at a duplicate x for a trend. */
const normalizePoints = (points: readonly NumericTuple[]): NormalizedPoints => {
  const display = validPairs(points);
  const latest = new Map<number, number>();
  for (const point of points) latest.set(point[0], point[1]);
  const unique = Array.from(latest.entries())
    .sort(([left], [right]) => left - right)
    .map(([x, y]) => [x, y] as NumericPair);
  return { display, unique };
};

const gaussianWeights = (): readonly number[] => {
  const unnormalized: number[] = [];
  const middle = (GAUSSIAN_TAP_COUNT - 1) / 2;
  for (let index = 0; index < GAUSSIAN_TAP_COUNT; index += 1) {
    const u = (index - middle) / middle;
    unnormalized.push(Math.exp(-GAUSSIAN_SIGMA_FACTOR * u * u));
  }
  const total = unnormalized.reduce((sum, weight) => sum + weight, 0);
  return total > 0 && Number.isFinite(total)
    ? unnormalized.map((weight) => weight / total)
    : [];
};

const GAUSSIAN_WEIGHTS = gaussianWeights();

const normalizedViewport = (viewport: readonly [number, number] | undefined): [number, number] | undefined => {
  if (viewport === undefined || !finiteNumber(viewport[0]) || !finiteNumber(viewport[1]) || viewport[1] <= viewport[0]) return undefined;
  return [viewport[0], viewport[1]];
};

const interpolatePiecewiseLinear = (points: readonly NumericPair[], x: number): number => {
  if (points.length === 0 || !finiteNumber(x)) return Number.NaN;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];

  let lower = 0;
  let upper = points.length - 1;
  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2);
    if (points[middle]![0] <= x) lower = middle;
    else upper = middle;
  }

  const left = points[lower]!;
  const right = points[upper]!;
  const fraction = (x - left[0]) / (right[0] - left[0]);
  if (!finiteNumber(fraction)) return left[1];
  let value = left[1] + (right[1] - left[1]) * fraction;
  if (!finiteNumber(value)) value = left[1] * (1 - fraction) + right[1] * fraction;
  if (!finiteNumber(value)) value = fraction < 0.5 ? left[1] : right[1];
  return value;
};

const monotonicDirection = (points: readonly NumericPair[]): "increasing" | "decreasing" | "constant" | "mixed" => {
  let increasing = true;
  let decreasing = true;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]![1];
    const current = points[index]![1];
    if (current < previous) increasing = false;
    if (current > previous) decreasing = false;
  }
  if (increasing && decreasing) return "constant";
  if (increasing) return "increasing";
  if (decreasing) return "decreasing";
  return "mixed";
};

const enforceMonotonicity = (
  values: number[],
  direction: "increasing" | "decreasing" | "constant" | "mixed",
  hasExactStart: boolean,
  hasExactEnd: boolean,
  startValue: number,
  endValue: number,
): void => {
  if (direction === "mixed" || values.length < 2) return;
  if (direction === "constant") {
    values.fill(startValue);
    return;
  }

  if (direction === "increasing") {
    if (hasExactStart) values[0] = startValue;
    for (let index = 1; index < values.length; index += 1) {
      values[index] = Math.max(values[index]!, values[index - 1]!);
    }
    if (hasExactEnd) values[values.length - 1] = endValue;
    for (let index = values.length - 2; index >= 0; index -= 1) {
      values[index] = Math.min(values[index]!, values[index + 1]!);
    }
    if (hasExactStart) values[0] = startValue;
    return;
  }

  if (hasExactStart) values[0] = startValue;
  for (let index = 1; index < values.length; index += 1) {
    values[index] = Math.min(values[index]!, values[index - 1]!);
  }
  if (hasExactEnd) values[values.length - 1] = endValue;
  for (let index = values.length - 2; index >= 0; index -= 1) {
    values[index] = Math.max(values[index]!, values[index + 1]!);
  }
  if (hasExactStart) values[0] = startValue;
};

/**
 * Produce a display-only Gaussian trend from monotonic-x tuples. Duplicate x
 * values use their last observation for the trend; callers retain the source
 * tuples separately for exact axis tooltip observations.
 */
export function buildSmoothedTrend(
  points: readonly NumericTuple[],
  viewport?: readonly [number, number],
): NumericPair[] {
  const normalized = normalizePoints(points.filter((point): point is NumericTuple => (
    Array.isArray(point) && point.length >= 2 && finiteNumber(point[0]) && finiteNumber(point[1])
  )));
  if (normalized.display.length === 0 || normalized.unique.length < 2) return normalized.display;

  const first = normalized.unique[0]![0];
  const last = normalized.unique[normalized.unique.length - 1]![0];
  const fullSpan = last - first;
  if (!finiteNumber(fullSpan) || fullSpan <= 0 || GAUSSIAN_WEIGHTS.length !== GAUSSIAN_TAP_COUNT) return normalized.display;

  const visible = normalizedViewport(viewport);
  let visibleSpan = visible === undefined ? fullSpan : visible[1] - visible[0];
  if (!finiteNumber(visibleSpan) || visibleSpan <= 0) visibleSpan = fullSpan;
  let bandwidth = visibleSpan / BANDWIDTH_DIVISOR;
  if (!finiteNumber(bandwidth) || bandwidth <= 0) bandwidth = fullSpan / BANDWIDTH_DIVISOR;
  if (!finiteNumber(bandwidth) || bandwidth <= 0) return normalized.display;

  let lower = first;
  let upper = last;
  if (visible !== undefined) {
    const padding = SUPPORT_RADIUS * bandwidth;
    lower = Math.max(first, visible[0] - padding);
    upper = Math.min(last, visible[1] + padding);
    if (!finiteNumber(lower) || !finiteNumber(upper) || lower > upper) return [];
  }

  let minimumY = normalized.unique[0]![1];
  let maximumY = minimumY;
  for (let index = 1; index < normalized.unique.length; index += 1) {
    const value = normalized.unique[index]![1];
    minimumY = Math.min(minimumY, value);
    maximumY = Math.max(maximumY, value);
  }
  const valueScale = Math.max(Math.abs(minimumY), Math.abs(maximumY));
  const direction = monotonicDirection(normalized.unique);
  const values: number[] = [];
  const output: NumericPair[] = [];
  const outputDenominator = TREND_POINT_COUNT - 1;

  for (let index = 0; index < TREND_POINT_COUNT; index += 1) {
    const x = index === 0 ? lower : index === outputDenominator ? upper : lower + ((upper - lower) * index) / outputDenominator;
    const radius = Math.max(0, Math.min(SUPPORT_RADIUS * bandwidth, x - first, last - x));
    let value: number;

    if (valueScale === 0) {
      value = 0;
    } else {
      let weighted = 0;
      let valid = true;
      for (let tap = 0; tap < GAUSSIAN_WEIGHTS.length; tap += 1) {
        const u = (tap / (GAUSSIAN_TAP_COUNT - 1)) * 2 - 1;
        const sampled = interpolatePiecewiseLinear(normalized.unique, x + radius * u);
        if (!finiteNumber(sampled)) {
          valid = false;
          break;
        }
        weighted += (sampled / valueScale) * GAUSSIAN_WEIGHTS[tap]!;
        if (!finiteNumber(weighted)) {
          valid = false;
          break;
        }
      }
      value = valid ? weighted * valueScale : interpolatePiecewiseLinear(normalized.unique, x);
    }

    if (!finiteNumber(value)) value = interpolatePiecewiseLinear(normalized.unique, x);
    if (!finiteNumber(value)) value = minimumY;
    value = Math.max(minimumY, Math.min(maximumY, value));
    if (index === 0 && lower === first) value = normalized.unique[0]![1];
    if (index === outputDenominator && upper === last) value = normalized.unique[normalized.unique.length - 1]![1];
    values.push(value);
    output.push([x, value]);
  }

  enforceMonotonicity(
    values,
    direction,
    lower === first,
    upper === last,
    normalized.unique[0]![1],
    normalized.unique[normalized.unique.length - 1]![1],
  );
  for (let index = 0; index < output.length; index += 1) output[index]![1] = values[index]!;
  return output;
}

/** Return the x extent across supported inline cartesian line tuple series. */
export function getChartTimeExtent(option: EChartsCoreOption): [number, number] | undefined {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const candidate of seriesList(option)) {
    if (!isRecord(candidate) || !supportsTupleLine(candidate)) continue;
    const data = readNumericTupleData(candidate.data);
    if (data === undefined) continue;
    for (const point of data) {
      minimum = Math.min(minimum, point[0]);
      maximum = Math.max(maximum, point[0]);
    }
  }
  return finiteNumber(minimum) && finiteNumber(maximum) ? [minimum, maximum] : undefined;
}

const seriesId = (series: ObjectRecord): string | undefined => {
  if (typeof series.id === "string") return series.id;
  if (typeof series.id === "number" && Number.isFinite(series.id)) return String(series.id);
  return undefined;
};

const styleRecord = (value: unknown): ObjectRecord => isRecord(value) ? value : {};

const hiddenRawSeries = (source: ObjectRecord, id: string): ObjectRecord => {
  const emphasis = styleRecord(source.emphasis);
  const select = styleRecord(source.select);
  return {
    ...source,
    id: `${id}:raw`,
    lineStyle: { ...styleRecord(source.lineStyle), width: 0, opacity: 0 },
    areaStyle: { ...styleRecord(source.areaStyle), opacity: 0 },
    itemStyle: { ...styleRecord(source.itemStyle), opacity: 0 },
    showSymbol: false,
    silent: true,
    sampling: undefined,
    emphasis: {
      ...emphasis,
      disabled: true,
      lineStyle: { ...styleRecord(emphasis.lineStyle), width: 0, opacity: 0 },
      areaStyle: { ...styleRecord(emphasis.areaStyle), opacity: 0 },
      itemStyle: { ...styleRecord(emphasis.itemStyle), opacity: 0 },
    },
    selectedMode: false,
    select: {
      ...select,
      lineStyle: { ...styleRecord(select.lineStyle), width: 0, opacity: 0 },
      areaStyle: { ...styleRecord(select.areaStyle), opacity: 0 },
      itemStyle: { ...styleRecord(select.itemStyle), opacity: 0 },
    },
  };
};

const trendSeries = (source: ObjectRecord, id: string, data: NumericPair[]): ObjectRecord => ({
  ...source,
  id: `${id}:trend`,
  data,
  dimensions: Array.isArray(source.dimensions) ? source.dimensions.slice(0, 2) : source.dimensions,
  encode: { x: 0, y: 1, tooltip: 1 },
  showSymbol: false,
  symbol: "none",
  smooth: 0.35,
  smoothMonotone: "none",
  sampling: undefined,
  animation: false,
  silent: true,
  tooltip: { show: false, trigger: "none" },
  emphasis: { ...styleRecord(source.emphasis), disabled: true },
  selectedMode: false,
});

/**
 * Keep exact raw observations as the tooltip/axis series and append a
 * display-only trend companion for each eligible multi-x cartesian line.
 */
export function buildTrendSeries(
  option: EChartsCoreOption,
  viewport?: readonly [number, number],
): unknown[] {
  const rawSeries: unknown[] = [];
  const companions: unknown[] = [];
  const sharedViewport = normalizedViewport(viewport) ?? getChartTimeExtent(option);

  for (const candidate of seriesList(option)) {
    if (!isRecord(candidate) || !supportsTupleLine(candidate) || candidate.smooth === false) {
      rawSeries.push(candidate);
      continue;
    }
    const data = readNumericTupleData(candidate.data);
    const id = seriesId(candidate);
    if (data === undefined || id === undefined || normalizePoints(data).unique.length < 2) {
      rawSeries.push(candidate);
      continue;
    }

    rawSeries.push(hiddenRawSeries(candidate, id));
    companions.push(trendSeries(candidate, id, buildSmoothedTrend(data, sharedViewport)));
  }
  return [...rawSeries, ...companions];
}
