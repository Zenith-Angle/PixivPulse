export function novelParagraphs(root: Document): HTMLParagraphElement[] {
  // Pixiv's long-form reader can be a sibling main (not a nested main).
  // Require a unique inner reading region; never fall back to the whole page.
  const candidates = [...root.querySelectorAll("main")].filter(element => !element.querySelector("main,h1") && element.querySelector("p"));
  if (candidates.length !== 1) return [];
  return [...candidates[0]!.querySelectorAll("p")].filter(p => p.getClientRects().length > 0 && !p.closest('[hidden],[aria-hidden="true"]'));
}
