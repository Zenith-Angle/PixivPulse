// Render received bursts over a short bounded interval. This does not invent
// tokens or delay ordinary small deltas; canonical text is persisted separately.
export function createTextStream(paint: (text: string) => void, reducedMotion = false) {
  let visible = "", pending = "", deadline = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiters: (() => void)[] = [];
  const settle = () => { for (const resolve of waiters.splice(0)) resolve(); };
  const tick = () => {
    timer = undefined;
    const frames = Math.max(1, Math.ceil((deadline - Date.now()) / 40));
    let count = reducedMotion ? pending.length : Math.max(32, Math.ceil(pending.length / frames));
    // Do not split a Unicode surrogate pair between paints.
    if (count < pending.length && /[\uD800-\uDBFF]/.test(pending[count - 1]!)) count++;
    visible += pending.slice(0, count); pending = pending.slice(count);
    paint(visible);
    if (pending) timer = setTimeout(tick, 40); else settle();
  };
  return {
    push(chunk: string) {
      if (!pending) deadline = Date.now() + 600;
      pending += chunk;
      if (!timer) tick();
    },
    drain(): Promise<void> { return pending ? new Promise(resolve => waiters.push(resolve)) : Promise.resolve(); },
    reset() { clearTimeout(timer); timer = undefined; visible = ""; pending = ""; settle(); paint(visible); },
    flush() { clearTimeout(timer); timer = undefined; visible += pending; pending = ""; paint(visible); settle(); },
    dispose() { clearTimeout(timer); timer = undefined; pending = ""; settle(); },
  };
}
