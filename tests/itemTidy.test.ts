import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The customer's Review screen asking the category service to read messy lines.
 *
 * What comes back is model output headed for a customer's list, so the server
 * keeps only well-formed answers and maps each one back to the line it belongs
 * to. Whatever goes wrong, it answers available: false and the list is sent as
 * the customer typed it.
 */

// Mocked rather than set on process.env: env.ts loads .env with override, so a
// developer's blank CATEGORY_SERVICE_URL would otherwise win over this test.
vi.mock("../src/config/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env.js")>()),
  CATEGORY_SERVICE_URL: "http://category.test",
  CATEGORY_NORMALIZE_TIMEOUT_MS: 10000,
}));
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { tidyItemLines } = await import("../src/services/itemTidyService.js");
const { itemTidyBodySchema } = await import("../src/validators/itemTidyValidators.js");

const reply = (body: unknown) => fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });

const lines = [
  { id: "a", text: "5 Kilo of Chicken 2qty" },
  { id: "b", text: "chicken 2, rice 5kg" },
];

beforeEach(() => {
  fetchMock.mockReset();
});

describe("tidying a Review screen's lines", () => {
  it("posts the texts with the whole budget, shared down the model chain, and maps answers back to line ids", async () => {
    reply({
      available: true,
      model: "gemini-3.8-flash",
      label: "Gemini 3.8 Flash",
      results: [
        { n: 1, items: [{ name: "Chicken", quantity: 2, size: "5 kg" }], confident: true },
        {
          n: 2,
          items: [
            { name: "chicken", quantity: 2, size: "" },
            { name: "rice", quantity: 1, size: "5 kg" },
          ],
          confident: false,
        },
      ],
    });

    const result = await tidyItemLines({ lines });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://category.test/normalize-items");
    const body = JSON.parse(init.body);
    expect(body.lines).toEqual(["5 Kilo of Chicken 2qty", "chicken 2, rice 5kg"]);
    // Not halved per model: Gemini took longer than 2.75 s for three lines.
    expect(body.timeout_ms).toBe(9250);

    expect(result.available).toBe(true);
    expect(result.results).toEqual([
      { id: "a", items: [{ name: "Chicken", quantity: 2, size: "5 kg", notes: null }], confident: true },
      {
        id: "b",
        items: [
          { name: "chicken", quantity: 2, size: null, notes: null },
          { name: "rice", quantity: 1, size: "5 kg", notes: null },
        ],
        confident: false,
      },
    ]);
  });

  it("passes the rider instruction a line carried", async () => {
    reply({
      available: true,
      results: [{ n: 1, items: [{ name: "Sibuyas", quantity: 1, size: "1/2 kg", note: "paki pili yung walang bulok" }], confident: true }],
    });
    const result = await tidyItemLines({ lines: [{ id: "a", text: "sibuyas 1/2 kilo paki pili yung walang bulok" }] });
    expect(result.results[0].items[0]).toEqual({ name: "Sibuyas", quantity: 1, size: "1/2 kg", notes: "paki pili yung walang bulok" });
  });

  it("drops answers that point past the end, repeat a line, or are malformed", async () => {
    reply({
      available: true,
      results: [
        { n: 1, items: [{ name: "Chicken", quantity: 2, size: "5 kg" }], confident: true },
        { n: 1, items: [{ name: "Pork", quantity: 1 }], confident: true },
        { n: 3, items: [{ name: "Ghost", quantity: 1 }], confident: true },
        { n: 2, items: [{ name: "", quantity: 1 }], confident: true },
        { n: 2, items: [{ name: "a", quantity: 1 }, { name: "b", quantity: 1 }, { name: "c", quantity: 1 }, { name: "d", quantity: 1 }], confident: true },
      ],
    });

    const result = await tidyItemLines({ lines });

    expect(result.results.map((r) => r.id)).toEqual(["a"]);
    expect(result.results[0].items[0].name).toBe("Chicken");
  });

  it("answers available: false when the service is unreachable or declines", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    expect(await tidyItemLines({ lines })).toEqual({ available: false, results: [] });

    reply({ available: false, results: [], reason: "no model available" });
    expect(await tidyItemLines({ lines })).toEqual({ available: false, results: [] });
  });
});

describe("the request validator", () => {
  it("accepts up to 20 lines of up to 120 characters", () => {
    const ok = Array.from({ length: 20 }, (_, i) => ({ id: String(i), text: "Coke 1.5L x2" }));
    expect(itemTidyBodySchema.parse({ lines: ok }).lines).toHaveLength(20);
  });

  it("refuses an empty list, a 21st line, and an over-long line", () => {
    expect(() => itemTidyBodySchema.parse({ lines: [] })).toThrow();
    expect(() =>
      itemTidyBodySchema.parse({ lines: Array.from({ length: 21 }, (_, i) => ({ id: String(i), text: "x" })) })
    ).toThrow();
    expect(() => itemTidyBodySchema.parse({ lines: [{ id: "a", text: "x".repeat(121) }] })).toThrow();
  });
});
