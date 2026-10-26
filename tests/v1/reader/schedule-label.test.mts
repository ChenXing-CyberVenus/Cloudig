import test from "node:test";
import assert from "node:assert/strict";
import {cronLabel} from "../../../src/ui/shared/conversation-renderer/schedule-label.mts";
test("saved cron is readable without inventing timezone or changing rule semantics",()=>{
 assert.equal(cronLabel("5 9 * * *",false),"每天 09:05");
 assert.equal(cronLabel("5 9 * * *",true),"Every day at 09:05");
 assert.equal(cronLabel("*/15 * * * *",false),"每 15 分钟");
 assert.equal(cronLabel("0 8 2 * *",false),"每月 2 日 08:00");
 assert.equal(cronLabel("0 8 * * 1,3",true),"Every Mon, Wed at 08:00");
 assert.match(cronLabel("0 8 2 * 1",false),/自定义/);
 assert.match(cronLabel("99 25 * * *",false),/自定义/);
 assert.match(cronLabel("0 0 8 * * *",false),/自定义/);
});
