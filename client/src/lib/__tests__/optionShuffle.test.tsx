import { describe, it, expect } from "vitest";
import {
  presentOptionKeys, seededShuffle, optionSeed, orderDependentOptions,
} from "@/lib/optionShuffle";

// The display-shuffle helpers. Watertightness rests on three properties:
// the output is always a PERMUTATION of the canonical keys (nothing lost,
// nothing invented, blanks dropped), the same seed always reproduces the
// same order (stable serves, resumable), and order-dependent option text is
// never shuffled (re-ordering "All of the above" changes what it means).

const OPTS = { A: "alpha", B: "bravo", C: "charlie", D: "delta", E: "echo" };

describe("seeded permutation", () => {
  it("is a permutation: same members, no duplicates, no inventions", () => {
    for (let s = 0; s < 50; s++) {
      const out = seededShuffle(["A", "B", "C", "D", "E"], s);
      expect([...out].sort()).toEqual(["A", "B", "C", "D", "E"]);
    }
  });

  it("is deterministic per seed, and different seeds actually vary the order", () => {
    expect(seededShuffle(["A", "B", "C", "D", "E"], 42)).toEqual(seededShuffle(["A", "B", "C", "D", "E"], 42));
    const orders = new Set(
      Array.from({ length: 30 }, (_, s) => seededShuffle(["A", "B", "C", "D", "E"], s).join("")),
    );
    // 30 seeds over 120 permutations: many distinct orders, or the shuffle
    // is decorative.
    expect(orders.size).toBeGreaterThan(10);
  });

  it("optionSeed differs across serves of the same question", () => {
    expect(optionSeed("Q1||0|123")).not.toBe(optionSeed("Q1||1|123"));
    expect(optionSeed("Q1||0|123")).not.toBe(optionSeed("Q1||0|456"));
  });
});

describe("order-dependence guard", () => {
  it("flags options that summarise the list, and letter cross-references", () => {
    expect(orderDependentOptions(["one", "two", "three", "four", "All of the above"])).toBe(true);
    expect(orderDependentOptions(["one", "two", "None of the above"])).toBe(true);
    // Same shape without "above" — absent from today's bank, guarded anyway.
    expect(orderDependentOptions(["one", "two", "All of these"])).toBe(true);
    // Abbreviated to the bare word (the bank's CV56 ends in a lone "none").
    expect(orderDependentOptions(["25 mm/sec", "50 mm/sec", "none"])).toBe(true);
    // …but "none" inside a real answer is content, not a summary.
    expect(orderDependentOptions(["none of the enzyme is saturated", "half is", "all is"])).toBe(false);
    expect(orderDependentOptions(["one", "B & D", "three"])).toBe(true);
    expect(orderDependentOptions(["For both A and B, 63% is achieved", "x"])).toBe(true);
    expect(orderDependentOptions(["see option C", "x"])).toBe(true);
  });

  it("does NOT exempt ordinary clinical prose that merely says above/below", () => {
    // The bank has 18 of these; a bare "above" is not positional wording, and
    // exempting on it cost them their shuffle for nothing.
    expect(orderDependentOptions(["Negative when pH is above 7.40", "Positive", "Zero"])).toBe(false);
    expect(orderDependentOptions(["Stored as gas above liquid", "As liquid", "As solid"])).toBe(false);
    expect(orderDependentOptions(["Increasing lung volume above FRC", "Below FRC", "At FRC"])).toBe(false);
  });

  it("flags options that ARE letters — a scrambled A–E list reads as a fault", () => {
    // Mapleson circuits, figure-labelled classification questions.
    expect(orderDependentOptions(["A", "B", "C (no change)", "D", "E"])).toBe(true);
    // One incidental single letter is not enough to forfeit the shuffle.
    expect(orderDependentOptions(["A", "bravo text", "charlie text"])).toBe(false);
  });

  it("flags options that walk a labelled diagram in order", () => {
    expect(orderDependentOptions([
      "A is minus 90 mV", "B is caused by L-type calcium channels", "at point C, voltage gated",
    ])).toBe(true);
    expect(orderDependentOptions([
      "Curve A is shifted to A1 when PaCO2 is 50", "Curve B is shifted to B1", "The x-axis is mmCSF",
    ])).toBe(true);
    // Prose that merely starts with "A" is not a label.
    expect(orderDependentOptions([
      "A competitive antagonist at the receptor", "An agonist", "An inverse agonist",
    ])).toBe(false);
  });

  it("flags quantity sets whatever their units, ranges or ratios", () => {
    expect(orderDependentOptions(["5%", "10%", "30%", "50%", "80%"])).toBe(true);
    expect(orderDependentOptions(["150 mmHg", "90", "45", "9", "4.5"])).toBe(true); // descending
    // Units change mid-ladder — a magnitude comparison would miss these.
    expect(orderDependentOptions(["30 min", "1 hr", "2 hr", "4 hr", "8 hr"])).toBe(true);
    expect(orderDependentOptions(["10 to 30 ml", "50 to 70 mls", "120 to 150 ml"])).toBe(true);
    expect(orderDependentOptions(["1:3", "1:30", "3:1", "30:1"])).toBe(true);
    expect(orderDependentOptions(["<80%", "80-90%", "90-96%"])).toBe(true);
    // A single numeric option among prose is not a quantity set.
    expect(orderDependentOptions(["20 mmHg", "raised", "lowered"])).toBe(false);
    expect(orderDependentOptions(Object.values(OPTS))).toBe(false);
  });

  it("errs toward NOT shuffling: known false positives forfeit the shuffle only", () => {
    // "it has A and B antigens" is a blood group, not a cross-reference —
    // matching it anyway is the fail-safe direction.
    expect(orderDependentOptions(["it has A and B antigens", "x"])).toBe(true);
  });
});

describe("presentOptionKeys", () => {
  it("returns a permutation of the non-blank canonical keys", () => {
    const out = presentOptionKeys({ ...OPTS, D: " ", E: undefined }, "seed");
    expect([...out].sort()).toEqual(["A", "B", "C"]);
  });

  it("shuffles plain questions deterministically and leaves guarded ones canonical", () => {
    const a = presentOptionKeys(OPTS, "Q1||0|1754800000000");
    expect(a).toEqual(presentOptionKeys(OPTS, "Q1||0|1754800000000"));
    expect(a.join("")).toBe("ADEBC"); // pinned: the wiring test in the runner relies on it
    expect(presentOptionKeys({ A: "one", B: "two", C: "three", D: "four", E: "None of the above" }, "any").join("")).toBe("ABCDE");
    expect(presentOptionKeys({ A: "5%", B: "10%", C: "30%", D: "50%", E: "80%" }, "any").join("")).toBe("ABCDE");
  });

  it("never shuffles a degenerate (0/1-option) record", () => {
    expect(presentOptionKeys({ A: "only" }, "x")).toEqual(["A"]);
    expect(presentOptionKeys({}, "x")).toEqual([]);
  });
});
