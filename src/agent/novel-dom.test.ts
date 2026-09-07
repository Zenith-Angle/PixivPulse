import { afterEach, expect, it, vi } from "vitest";
import { novelParagraphs } from "./novel-dom";

afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });
it.each([false, true])("extracts only prose in nested/sibling reader layout: %s", sibling => {
  const reader = '<main><p>正文段落</p><p hidden>隐藏内容</p></main>';
  document.body.innerHTML = sibling ? `<main><h1>标题</h1><p>简介</p></main>${reader}<aside><p>推荐</p></aside>` : `<main><h1>标题</h1><p>简介</p>${reader}<aside><p>推荐</p></aside></main>`;
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  expect(novelParagraphs(document).map(p => p.textContent)).toEqual(["正文段落"]);
});
it("fails closed for missing/ambiguous prose regions", () => {
  document.body.innerHTML = '<main><h1>标题</h1><p>简介</p></main>';
  expect(novelParagraphs(document)).toEqual([]);
  document.body.innerHTML = '<main><p>正文?</p></main><main><p>推荐?</p></main>';
  expect(novelParagraphs(document)).toEqual([]);
});
