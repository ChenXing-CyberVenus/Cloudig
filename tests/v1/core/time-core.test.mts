import assert from "node:assert/strict";
import test from "node:test";

import {
  astronomicalYear,
  buildContentTimeSortDescriptor,
  civilSecond,
  compareTerranProjection,
  compareContentTimeSortDescriptors,
  dayOrdinal,
  daysInGregorianMonth,
  endpointEqual,
  fixedProgressionForAll,
  floorDiv,
  floorMod,
  formatEndpoint,
  formatRange,
  isGregorianLeapYear,
  normalizeEndpoint,
  normalizeRange,
  orderedTimeVariants,
  projectTerranEndpoint,
  rangeDirection,
  relativeNominalYears,
  selectorIntersects
} from "../../../src/core/index.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";

test("Time display order appends unsorted variants by last edit with stable ties", () => {
  const system: JsonObject = { variants: {
    v1: { edited_at: "2026-09-01T00:00:00.000Z" },
    v2: { edited_at: "2026-09-03T00:00:00.000Z" },
    v3: { edited_at: "2026-09-03T00:00:00.000Z" }
  } };
  assert.deepEqual(orderedTimeVariants(system), ["v2", "v3", "v1"]);
  system["display_order"] = ["v1"];
  assert.deepEqual(orderedTimeVariants(system), ["v1", "v2", "v3"]);
});

test("floor division and standard proleptic Gregorian leap rules hold across BC", () => {
  for (let value = -1000; value <= 1000; value += 1) {
    const quotient = floorDiv(BigInt(value), 7n);
    const remainder = floorMod(BigInt(value), 7n);
    assert.equal(quotient * 7n + remainder, BigInt(value));
    assert.ok(remainder >= 0n && remainder < 7n);
  }
  assert.equal(astronomicalYear("BC", 1), 0n);
  assert.equal(isGregorianLeapYear(0n), true);
  assert.equal(isGregorianLeapYear(3200n), true);
  assert.equal(daysInGregorianMonth(3200n, 2), 29);
});

test("1 BC is followed by 1 AD without a civil year zero", () => {
  const lastBc = projectTerranEndpoint({
    kind: "calendar", era: "BC", year: 1, month: 12, day: 31, hour: 23, minute: 59, second: 59, offset: "Z"
  });
  const firstAd = projectTerranEndpoint({
    kind: "calendar", era: "AD", year: 1, month: 1, day: 1, hour: 0, minute: 0, second: 0, offset: "Z"
  });
  assert.equal(lastBc.domain, "terran_ordered");
  assert.equal(firstAd.domain, "terran_ordered");
  if (lastBc.domain === "terran_ordered" && firstAd.domain === "terran_ordered") {
    assert.equal(firstAd.lower! - lastBc.upper!, 1n);
  }
});

test("calendar precision projects complete closed intervals and offsets into UTC", () => {
  const february = projectTerranEndpoint({ kind: "calendar", era: "AD", year: 3200, month: 2, offset: "Z" });
  assert.equal(february.domain, "terran_ordered");
  if (february.domain === "terran_ordered") {
    assert.equal(february.lower, civilSecond(3200n, 2, 1));
    assert.equal(february.upper, civilSecond(3200n, 2, 29, 23, 59, 59));
  }

  const plusFourteen = projectTerranEndpoint({
    kind: "calendar", era: "AD", year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0, offset: "+14:00"
  });
  assert.equal(plusFourteen.domain, "terran_ordered");
  if (plusFourteen.domain === "terran_ordered") {
    assert.equal(plusFourteen.lower, civilSecond(2025n, 12, 31, 10));
  }
});

test("floating dates expand by fourteen hours at both ends", () => {
  const floating = projectTerranEndpoint({ kind: "calendar", era: "AD", year: 2026, month: 8, day: 31 });
  assert.equal(floating.domain, "terran_ordered");
  if (floating.domain === "terran_ordered") {
    assert.equal(floating.lower, civilSecond(2026n, 8, 31) - 14n * 3600n);
    assert.equal(floating.upper, civilSecond(2026n, 8, 31, 23, 59, 59) + 14n * 3600n);
  }
});

test("BC decades and centuries use chronological closed intervals", () => {
  const decade = projectTerranEndpoint({ kind: "decade", era: "BC", index: 1 });
  const century = projectTerranEndpoint({ kind: "century", era: "BC", index: 1 });
  assert.equal(decade.domain, "terran_ordered");
  assert.equal(century.domain, "terran_ordered");
  if (decade.domain === "terran_ordered") {
    assert.equal(decade.lower, civilSecond(astronomicalYear("BC", 19), 1, 1) - 14n * 3600n);
    assert.equal(decade.upper, civilSecond(astronomicalYear("BC", 10), 12, 31, 23, 59, 59) + 14n * 3600n);
  }
  if (century.domain === "terran_ordered") {
    assert.equal(century.lower, civilSecond(astronomicalYear("BC", 100), 1, 1) - 14n * 3600n);
    assert.equal(century.upper, civilSecond(astronomicalYear("BC", 1), 12, 31, 23, 59, 59) + 14n * 3600n);
  }
});

test("relative values use exact decimal BigInt and their saved anchor changes ordering", () => {
  assert.equal(relativeNominalYears("wan", "0.1"), 1000n);
  assert.equal(relativeNominalYears("zheng", "9999.0"), 99990n * 10n ** 39n);
  const first = projectTerranEndpoint({
    kind: "relative", direction: "before", unit: "wan", value: "0.1", anchor: { date: "2026-08-31", offset: "-07:00" }
  });
  const refreshed = projectTerranEndpoint({
    kind: "relative", direction: "before", unit: "wan", value: "0.1", anchor: { date: "2027-08-31", offset: "-07:00" }
  });
  assert.equal(compareTerranProjection(first, refreshed), -1);
});

test("relative and calendar endpoints share one interval reversal rule", () => {
  const range: JsonObject = {
    start: {
      kind: "relative",
      direction: "before",
      unit: "wan",
      value: "0.5",
      anchor: { date: "2026-08-31", offset: "-07:00" }
    },
    end: { kind: "calendar", era: "BC", year: 3500 }
  };
  assert.equal(rangeDirection(range), "reversed");
  const overlapping = structuredClone(range);
  overlapping["end"] = { kind: "calendar", era: "BC", year: 3000 };
  assert.equal(rangeDirection(overlapping), "indeterminate");
});

test("normalization canonicalizes zero offsets and removes collapsed ranges", () => {
  const plusZero = normalizeEndpoint({
    kind: "calendar", era: "AD", year: 2026, month: 8, day: 31, hour: 12, offset: "+00:00"
  });
  const zulu = { kind: "calendar", era: "AD", year: 2026, month: 8, day: 31, hour: 12, offset: "Z" };
  assert.equal(endpointEqual(plusZero, zulu), true);
  assert.deepEqual(normalizeRange({ start: zulu, end: plusZero }), { start: zulu });
  assert.deepEqual(normalizeEndpoint({
    kind: "relative", direction: "after", unit: "wan", value: "1", anchor: { date: "2026-08-31", offset: "Z" }
  }), {
    kind: "relative", direction: "after", unit: "wan", value: "1.0", anchor: { date: "2026-08-31", offset: "Z" }
  });
});

test("the shared formatter gives stable readable Chinese and English fallbacks", () => {
  assert.equal(formatEndpoint({ kind: "calendar", era: "AD", year: 2026, month: 8, day: 31 }, "zh-CN"), "2026-08-31");
  assert.equal(formatEndpoint({ kind: "calendar", era: "AD", year: 2026, month: 8 }, "zh-CN"), "2026年8月");
  assert.equal(formatEndpoint({ kind: "calendar", era: "BC", year: 200 }, "zh-CN"), "公元前200年");
  assert.equal(formatEndpoint({ kind: "calendar", era: "AD", year: 2026, month: 8 }, "en"), "August 2026");
  assert.equal(formatEndpoint({ kind: "calendar", era: "BC", year: 8 }, "en"), "8 BC");
  assert.equal(formatEndpoint({ kind: "relative", direction: "before", unit: "wan", value: "0.5", anchor: { date: "2026-08-31", offset: "Z" } }, "zh-CN"), "0.5万年前");
  assert.equal(formatRange({
    start: { kind: "century", era: "BC", index: 8 },
    end: { kind: "century", era: "BC", index: 3 }
  }, "en"), "8th century BC – 3rd century BC");
  assert.equal(formatEndpoint({
    kind: "sovereign",
    target: { node: "t2", occurrences: { mode: "progression", first: 1, step: 2, last: 5 } },
    snapshot: {
      timeline: { lineage: "l1", variant: "v1", number: 1, revision: 1, name: "星河纪元", author: "晨星" },
      target: { id: "t2", kind: "periodic", name: "月相", count: 12 },
      path: [2]
    }
  }, "zh-CN"), "星河纪元 · 月相（第1–5，步长2）");
});

test("unknown, whenever, infinities, and sovereign variants keep their domains", () => {
  assert.equal(rangeDirection({ start: { kind: "unknown" }, end: { kind: "calendar", era: "AD", year: 2026 } }), "indeterminate");
  assert.equal(rangeDirection({ start: { kind: "infinite_past" }, end: { kind: "infinite_future" } }), "forward");
  const left = {
    kind: "sovereign",
    target: { node: "t1" },
    snapshot: {
      timeline: { lineage: "l1", variant: "v1", number: 1, revision: 1, name: "A", author: "A" },
      target: { id: "t1", kind: "single", name: "A" },
      path: [1]
    }
  };
  const right = structuredClone(left);
  right.snapshot.path = [2];
  assert.equal(rangeDirection({ start: left, end: right }), "forward");
  right.snapshot.timeline.variant = "v2";
  assert.equal(rangeDirection({ start: left, end: right }), "indeterminate");

  const periodicStart: JsonObject = {
    ...left,
    target: { node: "t2", occurrences: { mode: "progression", first: 1, step: 1, last: 3 } },
    snapshot: {
      ...left.snapshot,
      target: { id: "t2", kind: "periodic", name: "Cycle", count: 12 }
    }
  };
  const periodicEnd: JsonObject = {
    ...periodicStart,
    target: { node: "t2", occurrences: { mode: "progression", first: 4, step: 1, last: 6 } }
  };
  assert.equal(rangeDirection({ start: periodicStart, end: periodicEnd }), "forward");

  const staleOtherNode: JsonObject = {
    ...periodicEnd,
    target: { node: "t3", occurrences: { mode: "progression", first: 4, step: 1, last: 6 } },
    snapshot: {
      ...periodicStart["snapshot"] as JsonObject,
      target: { id: "t3", kind: "periodic", name: "Cycle", count: 12 }
    }
  };
  assert.equal(rangeDirection({ start: periodicStart, end: staleOtherNode }), "indeterminate");
});

function enumerate(selector: JsonObject, periodCount: number): Set<number> {
  if (selector["mode"] === "all") return new Set(Array.from({ length: periodCount }, (_, index) => index + 1));
  if (selector["mode"] === "prefix") return new Set(Array.from({ length: selector["count"] as number }, (_, index) => index + 1));
  const values = new Set<number>();
  for (let value = selector["first"] as number; value <= (selector["last"] as number); value += selector["step"] as number) values.add(value);
  return values;
}

test("selector CRT intersection matches exhaustive small-domain truth", () => {
  for (let count = 1; count <= 12; count += 1) {
    const selectors: JsonObject[] = [{ mode: "all" }, ...Array.from({ length: count }, (_, index) => ({ mode: "prefix", count: index + 1 }))];
    for (let first = 1; first <= count; first += 1) {
      for (let step = 1; step <= count; step += 1) {
        for (let last = first; last <= count; last += step) selectors.push({ mode: "progression", first, step, last });
      }
    }
    for (const left of selectors) {
      const leftSet = enumerate(left, count);
      for (const right of selectors) {
        const expected = [...enumerate(right, count)].some((value) => leftSet.has(value));
        assert.equal(selectorIntersects(left, right, count), expected, `${count}:${JSON.stringify(left)}:${JSON.stringify(right)}`);
      }
    }
  }
});

test("large periodic selectors are solved without enumeration", () => {
  const maximum = 99999999;
  assert.equal(selectorIntersects(
    { mode: "progression", first: 1, step: 99991, last: 99991001 },
    { mode: "progression", first: 2001, step: 99989, last: 99991001 },
    maximum
  ), true);
  assert.deepEqual(fixedProgressionForAll(maximum), { mode: "progression", first: 1, step: 1, last: maximum });
  assert.equal(dayOrdinal(1n, 1, 2) - dayOrdinal(1n, 1, 1), 1n);
});

test("content-time sort reverses only comparable domains and leaves unknown or unset at the end", () => {
  const facts = [
    { title: "2020", archive: "a1", path: "a1.json", range: { start: { kind: "calendar", era: "AD", year: 2020 } } },
    { title: "2021", archive: "a2", path: "a2.json", range: { start: { kind: "calendar", era: "AD", year: 2021 } } },
    { title: "unknown", archive: "a3", path: "a3.json", range: { start: { kind: "unknown" } } },
    { title: "unset", archive: "a4", path: "a4.json" }
  ].map((entry) => buildContentTimeSortDescriptor(entry));
  assert.deepEqual([...facts].sort((left, right) => compareContentTimeSortDescriptors(left, right, "asc")).map((entry) => entry.title), ["2020", "2021", "unknown", "unset"]);
  assert.deepEqual([...facts].sort((left, right) => compareContentTimeSortDescriptors(left, right, "desc")).map((entry) => entry.title), ["2021", "2020", "unknown", "unset"]);
});

test("point precedes range at the same start and mapped Sovereign time joins Terran ordering", () => {
  const point = buildContentTimeSortDescriptor({
    title: "point", archive: "a1", path: "a1.json", range: { start: { kind: "calendar", era: "AD", year: 2020 } }
  });
  const range = buildContentTimeSortDescriptor({
    title: "range", archive: "a2", path: "a2.json", range: {
      start: { kind: "calendar", era: "AD", year: 2020 },
      end: { kind: "calendar", era: "AD", year: 2021 }
    }
  });
  assert.equal(compareContentTimeSortDescriptors(point, range, "asc"), -1);
  assert.equal(compareContentTimeSortDescriptors(point, range, "desc"), -1);

  const sovereign = buildContentTimeSortDescriptor({
    title: "mapped", archive: "a3", path: "a3.json", range: { start: {
      kind: "sovereign",
      target: { node: "t1" },
      snapshot: {
        timeline: { lineage: "l1", variant: "v1", number: 1, revision: 1, name: "A", author: "A" },
        target: { id: "t1", kind: "single", name: "A" },
        path: [1],
        sort: { start: { kind: "calendar", era: "AD", year: 1900 } }
      }
    } }
  });
  assert.equal(sovereign.domain, 0);
  assert.equal(compareContentTimeSortDescriptors(sovereign, point, "asc"), -1);
});

test("unmapped Sovereign time follows user variant order, canonical path, and stable ties", () => {
  const make = (title: string, archive: string, variant: string, path: number[], editedAt: string) => buildContentTimeSortDescriptor({
    title,
    archive,
    path: `${archive}.json`,
    editedAt,
    variantOrder: { v1: 0, v2: 1 },
    nodeEditedAt: { t1: "2026-08-31T10:00:00.000Z" },
    range: { start: {
      kind: "sovereign",
      target: { node: "t1" },
      snapshot: {
        timeline: { lineage: "l1", variant, number: 1, revision: 1, name: "A", author: "A" },
        target: { id: "t1", kind: "single", name: "A" },
        path
      }
    } }
  });
  const values = [
    make("v2", "a3", "v2", [1], "2026-08-31T12:00:00.000Z"),
    make("second", "a2", "v1", [2], "2026-08-31T12:00:00.000Z"),
    make("first", "a1", "v1", [1], "2026-08-31T11:00:00.000Z")
  ];
  assert.deepEqual([...values].sort((left, right) => compareContentTimeSortDescriptors(left, right, "asc")).map((entry) => entry.title), ["first", "second", "v2"]);
  assert.deepEqual([...values].sort((left, right) => compareContentTimeSortDescriptors(left, right, "desc")).map((entry) => entry.title), ["v2", "second", "first"]);

  const same = [
    buildContentTimeSortDescriptor({ title: "same", archive: "a2", path: "b.json", editedAt: "2026-08-31T11:00:00.000Z" }),
    buildContentTimeSortDescriptor({ title: "same", archive: "a1", path: "a.json", editedAt: "2026-08-31T12:00:00.000Z" })
  ];
  assert.deepEqual(same.sort((left, right) => compareContentTimeSortDescriptors(left, right, "asc")).map((entry) => entry.archive), ["a1", "a2"]);
});
