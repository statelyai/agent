import { describe, expect, it } from "vitest";
import { AgentError } from "./errors.js";
import { judgeAgreement, type AgreementRow } from "./judge-agreement.js";

const rows = (pairs: [human: string, judge: string, count: number][]): AgreementRow[] =>
  pairs.flatMap(([human, judge, count]) =>
    Array.from({ length: count }, (_, i) => ({ id: `${human}-${judge}-${i}`, human, judge })),
  );

function hasNaN(value: unknown): boolean {
  if (typeof value === "number") return Number.isNaN(value);
  if (value && typeof value === "object") return Object.values(value).some(hasNaN);
  return false;
}

describe("judgeAgreement", () => {
  it("reports perfect agreement", () => {
    const report = judgeAgreement(
      rows([
        ["pass", "pass", 3],
        ["fail", "fail", 2],
      ]),
    );

    expect(report).toEqual({
      total: 5,
      accuracy: 1,
      perLabel: { pass: { human: 3, agreed: 3 }, fail: { human: 2, agreed: 2 } },
      confusion: { pass: { pass: 3 }, fail: { fail: 2 } },
      disagreements: [],
    });
  });

  it("reports a judge that is always wrong, disagreements in input order", () => {
    const report = judgeAgreement([
      { id: "a", human: "pass", judge: "fail" },
      { id: "b", human: "fail", judge: "pass" },
      { id: "c", human: "pass", judge: "fail" },
    ]);

    expect(report.accuracy).toBe(0);
    expect(report.perLabel).toEqual({
      pass: { human: 2, agreed: 0 },
      fail: { human: 1, agreed: 0 },
    });
    expect(report.confusion).toEqual({ pass: { fail: 2 }, fail: { pass: 1 } });
    expect(report.disagreements.map((d) => d.id)).toEqual(["a", "b", "c"]);
  });

  it("shows low minority-label recall behind high accuracy", () => {
    const report = judgeAgreement(
      rows([
        ["pass", "pass", 18],
        ["fail", "pass", 1],
        ["fail", "fail", 1],
      ]),
    );

    expect(report.accuracy).toBe(0.95);
    expect(report.perLabel.fail).toEqual({ human: 2, agreed: 1 });
  });

  it("computes TPR, TNR, and the correction", () => {
    // 10 human positives, judge says fail on 8: TPR = 8/10 = 0.8.
    // 10 human negatives, judge says pass on 9: TNR = 9/10 = 0.9.
    // correct(0.3) = (0.3 + 0.9 − 1) / (0.8 + 0.9 − 1) = 0.2 / 0.7 ≈ 0.2857.
    const report = judgeAgreement(
      rows([
        ["fail", "fail", 8],
        ["fail", "pass", 2],
        ["pass", "pass", 9],
        ["pass", "fail", 1],
      ]),
      { positive: "fail" },
    );

    expect(report.binary).toEqual({ tpr: 0.8, tnr: 0.9 });
    expect(report.correct?.(0.3)).toBeCloseTo(0.2 / 0.7);
    // (0.05 + 0.9 − 1) / 0.7 < 0, clamped to 0; (1 + 0.9 − 1) / 0.7 > 1, clamped to 1.
    expect(report.correct?.(0.05)).toBe(0);
    expect(report.correct?.(1)).toBe(1);
  });

  it("omits the correction for a chance-level judge", () => {
    // TPR = 0.5, TNR = 0.5: TPR + TNR = 1.
    const report = judgeAgreement(
      rows([
        ["fail", "fail", 1],
        ["fail", "pass", 1],
        ["pass", "pass", 1],
        ["pass", "fail", 1],
      ]),
      { positive: "fail" },
    );

    expect(report.binary).toEqual({ tpr: 0.5, tnr: 0.5 });
    expect(report.correct).toBeUndefined();
  });

  it("leaves TPR undefined with no human positives, and no NaN anywhere", () => {
    const report = judgeAgreement(
      rows([
        ["pass", "pass", 3],
        ["pass", "fail", 1],
      ]),
      {
        positive: "fail",
      },
    );

    expect(report.binary).toEqual({ tpr: undefined, tnr: 0.75 });
    expect(report.correct).toBeUndefined();
    expect(hasNaN(report)).toBe(false);
  });

  it("treats every label other than `positive` as negative", () => {
    // Positives: unsafe → unsafe (1 of 1). Negatives: safe and off-topic,
    // judged anything but unsafe count as true negatives (3 of 4).
    const report = judgeAgreement(
      [
        { id: "1", human: "unsafe", judge: "unsafe" },
        { id: "2", human: "safe", judge: "off-topic" },
        { id: "3", human: "off-topic", judge: "safe" },
        { id: "4", human: "safe", judge: "safe" },
        { id: "5", human: "off-topic", judge: "unsafe" },
      ],
      { positive: "unsafe" },
    );

    expect(report.binary).toEqual({ tpr: 1, tnr: 0.75 });
    expect(report.accuracy).toBe(0.4);
    expect(report.confusion["off-topic"]).toEqual({ safe: 1, unsafe: 1 });
  });

  it("groups rows by `row.group`, leaving ungrouped rows out of every group", () => {
    const report = judgeAgreement([
      { id: "a", human: "pass", judge: "pass", group: "triage" },
      { id: "b", human: "fail", judge: "pass", group: "triage" },
      { id: "c", human: "pass", judge: "pass", group: "refund" },
      { id: "d", human: "fail", judge: "fail" },
    ]);

    expect(report.total).toBe(4);
    expect(Object.keys(report.groups!)).toEqual(["triage", "refund"]);
    expect(report.groups!.triage).toMatchObject({ total: 2, accuracy: 0.5 });
    expect(report.groups!.refund).toMatchObject({ total: 1, accuracy: 1 });
    expect(report.groups!.triage).not.toHaveProperty("groups");
  });

  it("groups rows by `groupBy`, overriding `row.group`, with extra row fields", () => {
    const report = judgeAgreement(
      [
        { id: "a", human: "fail", judge: "fail", group: "x", request: "classify" },
        { id: "b", human: "pass", judge: "pass", group: "x", request: "classify" },
        { id: "c", human: "fail", judge: "pass", group: "x", request: "approve" },
      ],
      { positive: "fail", groupBy: (row) => row.request },
    );

    expect(Object.keys(report.groups!)).toEqual(["classify", "approve"]);
    expect(report.groups!.classify!.binary).toEqual({ tpr: 1, tnr: 1 });
    expect(report.groups!.approve!.binary).toEqual({ tpr: 0, tnr: undefined });
  });

  it("omits `groups` when no row has a group and no `groupBy` is given", () => {
    expect(judgeAgreement(rows([["pass", "pass", 1]]))).not.toHaveProperty("groups");
  });

  it("throws on empty rows", () => {
    expect(() => judgeAgreement([])).toThrow(AgentError);
    expect(() => judgeAgreement([])).toThrow(
      expect.objectContaining({ code: "empty-agreement-rows" }),
    );
  });

  it("keeps a label named __proto__ as its own entry", () => {
    const report = judgeAgreement([
      { id: "one", human: "__proto__", judge: "pass" },
      { id: "two", human: "__proto__", judge: "__proto__", group: "__proto__" },
    ]);

    expect(Object.hasOwn(report.perLabel, "__proto__")).toBe(true);
    expect(report.perLabel["__proto__"]).toEqual({ human: 2, agreed: 1 });
    expect(report.confusion["__proto__"]?.["pass"]).toBe(1);
    expect(report.confusion["__proto__"]?.["__proto__"]).toBe(1);
    expect(Object.hasOwn(report.groups!, "__proto__")).toBe(true);
  });
});
