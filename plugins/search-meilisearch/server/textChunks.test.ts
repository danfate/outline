import { textChunks } from "./textChunks";

describe("textChunks", () => {
  it("does not create an invalid overlapping tail for a short emoji-only text", () => {
    expect(textChunks("🟡")).toEqual(["🟡"]);
  });

  it("does not split a Unicode surrogate pair across chunk boundaries", () => {
    const text = `${"a".repeat(999)}🟡${"b".repeat(200)}`;

    const chunks = textChunks(text);

    expect(chunks[0]).toBe("a".repeat(999));
    expect(chunks.every((chunk) => !hasUnpairedSurrogate(chunk))).toBe(true);
  });

  function hasUnpairedSurrogate(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
      const codeUnit = value.charCodeAt(index);
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const nextCodeUnit = value.charCodeAt(index + 1);
        if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
          index += 1;
          continue;
        }
        return true;
      }
      if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        return true;
      }
    }
    return false;
  }
});
