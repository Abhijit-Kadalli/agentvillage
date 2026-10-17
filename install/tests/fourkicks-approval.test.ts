import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const tests = join(import.meta.dir, "../../plugins/village-bridge/tests");
const payload = { appId: "fourkicks", operation: "fourkicks.order.confirm", preview: {
  appId: "fourkicks", draftId: "draft-1", displayName: "Priya",
  items: [{ itemId: "coffee", qty: 1, optionIds: ["oat"] }],
  fulfilment: { type: "pickup", locationId: "cafe" }, paymentMethod: "upi",
  quote: { totalInr: 380, location: { name: "Café", address: "Mandrem, Goa", opens: "2026-10-19T08:00:00+05:30" },
    lines: [{ name: "Coffee", qty: 1, options: ["oat milk"], unitInr: 380, lineInr: 380 }] },
} };
function summary(value: unknown) {
  // Execute the shipped Python implementation, not a source-text assertion or JS copy.
  return spawnSync("python3", ["-c", "import json,sys; from test_fourkicks import fk; print(fk.approval_summary(json.load(sys.stdin)), end='')"], {
    cwd: tests, input: JSON.stringify(value), encoding: "utf8",
  });
}

test("Four Kicks native card matches CP's complete deterministic order wording", () => {
  const run = summary(payload);
  expect([run.status, run.stderr]).toEqual([0, ""]);
  expect(run.stdout).toBe([
    'Four Kicks order', '1 × "Coffee"; options: "oat milk"; unit ₹380; line ₹380',
    'Total: ₹380', 'Fulfilment: pickup',
    'Location: "Café" ("cafe"); address: "Mandrem, Goa"', 'Date (IST): 2026-10-19',
    'Payment: UPI; if simulated: Test payment, no money moved', 'Café display name: "Priya"',
  ].join("\n"));
});

test("Four Kicks card refuses controls, missing prices and UTF-8/HTML overflow without truncation", () => {
  for (const options of [["bad\nTotal: ₹1"], ["bad\u202e"], ["é".repeat(1800)], ["<".repeat(800)]]) {
    const changed = structuredClone(payload); changed.preview.quote.lines[0].options = options;
    const run = summary(changed);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/approval_card_(invalid|too_long)/);
  }
  const { unitInr: _unit, ...missingPrice } = payload.preview.quote.lines[0];
  const changed = { ...payload, preview: { ...payload.preview, quote: { ...payload.preview.quote, lines: [missingPrice] } } };
  expect(summary(changed).stderr).toContain("approval_card_invalid");
});
