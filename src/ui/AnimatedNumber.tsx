import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";

export interface AnimatedNumberProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  /** The already-formatted value shown to the user. */
  value: ReactNode;
  /** Disable transitions while a surface is hydrating its first local snapshot. */
  animate?: boolean;
  /** Optional unformatted value for an exact increase/decrease comparison. */
  comparisonValue?: number | null;
  /** Replays the roll when changed while the component remains mounted. */
  animationSignal?: unknown;
}

export type NumberRollDirection = "increase" | "decrease" | "change";

interface RollTransition {
  from: ReactNode;
  to: ReactNode;
  direction: NumberRollDirection;
  revision: number;
  animated: boolean;
}

const cn = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(" ");

const readReducedMotion = (): boolean => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
};

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(readReducedMotion);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  return reduced;
}

const displayValue = (value: ReactNode): ReactNode => value === null || value === undefined ? "—" : value;

const valueIdentity = (value: ReactNode): unknown => {
  if (value === null || value === undefined) return "placeholder:—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return `${typeof value}:${String(value)}`;
  return value;
};

export const numericDisplayValue = (value: ReactNode): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim().replaceAll(",", "").replace(/%$/, "");
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

export const numberRollDirection = (previous: number | null, next: number | null): NumberRollDirection => {
  if (previous === null || next === null || previous === next) return "change";
  return next > previous ? "increase" : "decrease";
};

const accessibleText = (value: ReactNode): string | undefined => {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return String(value);
  return undefined;
};

/**
 * Rolls a committed value into the next committed value. The initial value and
 * placeholder hydration are intentionally static so opening a page never
 * pretends that old local data has just grown.
 */
export function AnimatedNumber({ value, comparisonValue, animationSignal, animate = true, className, ...rest }: AnimatedNumberProps) {
  const nextValue = displayValue(value);
  const nextIdentity = valueIdentity(nextValue);
  const currentValueRef = useRef(nextValue);
  const currentIdentityRef = useRef(nextIdentity);
  const currentComparisonRef = useRef(comparisonValue ?? numericDisplayValue(nextValue));
  const animationSignalRef = useRef(animationSignal);
  const animationEnabledRef = useRef(animate);
  const [transition, setTransition] = useState<RollTransition>({
    from: nextValue,
    to: nextValue,
    direction: "change",
    revision: 0,
    animated: false,
  });
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const wasAnimationEnabled = animationEnabledRef.current;
    animationEnabledRef.current = animate;
    const valueChanged = !Object.is(currentIdentityRef.current, nextIdentity);
    const signalChanged = !Object.is(animationSignalRef.current, animationSignal);
    animationSignalRef.current = animationSignal;
    if (!valueChanged && !signalChanged) return;

    const previousValue = currentValueRef.current;
    const previousComparison = currentComparisonRef.current;
    const nextComparison = comparisonValue ?? numericDisplayValue(nextValue);
    const placeholderHydration = accessibleText(previousValue) === "—";
    const shouldAnimate = animate && wasAnimationEnabled && !reducedMotion && !placeholderHydration;

    currentValueRef.current = nextValue;
    currentIdentityRef.current = nextIdentity;
    currentComparisonRef.current = nextComparison;
    setTransition((current) => ({
      from: previousValue,
      to: nextValue,
      direction: valueChanged ? numberRollDirection(previousComparison, nextComparison) : "change",
      revision: current.revision + 1,
      animated: shouldAnimate,
    }));
  }, [animate, animationSignal, comparisonValue, nextIdentity, nextValue, reducedMotion]);

  useEffect(() => {
    if (!transition.animated) return undefined;
    const revision = transition.revision;
    const timer = window.setTimeout(() => {
      setTransition((current) => current.revision === revision ? { ...current, animated: false } : current);
    }, 780);
    return () => window.clearTimeout(timer);
  }, [transition.animated, transition.revision]);

  const providedAriaLabel = rest["aria-label"];
  const ariaLabel = providedAriaLabel ?? accessibleText(transition.to);
  const animated = transition.animated && !reducedMotion;
  const rows = transition.direction === "decrease"
    ? [transition.to, transition.from]
    : [transition.from, transition.to];

  return (
    <span
      {...rest}
      aria-label={ariaLabel}
      className={cn("animated-number", animated && "animated-number-rolling", className)}
      data-roll-direction={animated ? transition.direction : undefined}
      data-current-value={accessibleText(transition.to)}
    >
      <span
        key={transition.revision}
        className={cn("animated-number-viewport", animated && `animated-number-viewport-${transition.direction}`)}
        aria-hidden="true"
        onAnimationEnd={() => setTransition((current) => current.revision === transition.revision ? { ...current, animated: false } : current)}
      >
        {animated ? (
          <span className={cn("animated-number-track", `animated-number-track-${transition.direction}`)}>
            <span className="animated-number-row animated-number-row-from">{rows[0]}</span>
            <span className="animated-number-row animated-number-row-to">{rows[1]}</span>
          </span>
        ) : (
          <span className="animated-number-value">{transition.to}</span>
        )}
      </span>
    </span>
  );
}

/** A semantic alias retained for existing callers. */
export function FlipValue(props: AnimatedNumberProps) {
  return <AnimatedNumber {...props} />;
}

export default AnimatedNumber;
