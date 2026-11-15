import { describe, expect, it } from "vitest";
import { normalizeLoopback } from "./registry";

describe("normalizeLoopback", () => {
  it("pins localhost to IPv4 so Windows can reach Ollama", () => {
    expect(normalizeLoopback("http://localhost:11434/v1")).toBe("http://127.0.0.1:11434/v1");
    expect(normalizeLoopback("http://LOCALHOST/v1")).toBe("http://127.0.0.1/v1");
  });

  it("leaves other hosts alone", () => {
    expect(normalizeLoopback("https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
    expect(normalizeLoopback("http://localhost.example.com/v1")).toBe("http://localhost.example.com/v1");
    expect(normalizeLoopback("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434/v1");
  });
});
