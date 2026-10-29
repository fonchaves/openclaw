import { expect, it } from "vitest";
import mermaidScriptUrl from "../../../packages/mermaid-renderer/src/engine.ts";

it("does not inherit KaTeX trust from a polluted prototype in the shipped classic engine", async () => {
  // A separate realm avoids polluting Vitest itself. Test the engine before the
  // host's passive-SVG sanitizer, which would otherwise hide this regression.
  const frame = document.createElement("iframe");
  document.body.append(frame);
  try {
    const realm = frame.contentWindow as Window &
      typeof globalThis & {
        mermaid: {
          initialize(config: unknown): void;
          render(id: string, source: string): Promise<{ svg: string }>;
        };
      };
    const script = realm.document.createElement("script");
    script.src = mermaidScriptUrl;
    await new Promise<void>((resolve, reject) => {
      script.addEventListener("load", () => resolve(), { once: true });
      script.addEventListener(
        "error",
        () => reject(new Error("Failed to load the shipped Mermaid engine")),
        { once: true },
      );
      realm.document.head.append(script);
    });
    realm.mermaid.initialize({
      startOnLoad: false,
      securityLevel: "loose",
      flowchart: { htmlLabels: true },
    });
    const source =
      "flowchart LR" +
      String.fromCharCode(10) +
      'A["$$' +
      String.fromCharCode(92) +
      'href{https://example.invalid/security-canary}{trusted}$$"]';
    Object.defineProperty(realm.Object.prototype, "trust", {
      value: true,
      writable: true,
      configurable: true,
    });
    try {
      const { svg } = await realm.mermaid.render("polluted-prototype", source);
      expect(svg).toContain("katex");
      expect(svg).not.toContain("https://example.invalid/security-canary");
      expect(svg).not.toContain("<a ");
    } finally {
      Reflect.deleteProperty(realm.Object.prototype, "trust");
    }
  } finally {
    frame.remove();
  }
});
