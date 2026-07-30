import { describe, expect, it } from "vitest";
import { describeCoverageItems } from "../coverage";

describe("describeCoverageItems", () => {
  it("translates internal codes and removes scoped duplicates", () => {
    expect(describeCoverageItems(["bucket_budget", "budget:bucket_budget", "external_capital_events"]))
      .toEqual(["未设置该仓季度资金预算", "尚未初始化外部净投入"]);
  });

  it("keeps actionable Chinese issues while hiding unknown internal codes", () => {
    expect(describeCoverageItems(["请补录现金余额", "internal_unknown_code"]))
      .toEqual(["请补录现金余额", "存在待补录的数据，请前往数据管理核对"]);
  });
});
