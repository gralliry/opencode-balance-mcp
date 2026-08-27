// 单元测试：直接验证 parse.mjs 中的纯解析函数。
import {
    extractRscObject,
    extractScalar,
} from "../src/parse.mjs";

// 模拟的 Go 用量 RSC 负载（三种时间窗口）。
const goHtml = `<script>rollingUsage:$R[31]={status:"ok",resetInSec:8660,usagePercent:1} weeklyUsage:$R[7]={status:"ok",resetInSec:1,usagePercent:3} monthlyUsage:$R[9]={status:"ok",resetInSec:42,usagePercent:0}</script>`;
// 模拟的 Zen 余额 SSR 负载（两种序列化风格：纯对象 / 带引号键与 !0 简写）。
const zenHtml = `<script>_$HY={"data":{"balance":-1392,"reloadAmount":20,"reloadTrigger":5,"useBalance":true}}</script>`;
const zenHtml2 = `<script>var x={balance:"-1392",reloadAmount:20,reloadTrigger:5,useBalance:!0}</script>`;

// 简易断言辅助：统计通过/失败数量。
let pass = 0,
    fail = 0;
const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(
        `${ok ? "✅" : "❌"} ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`,
    );
    ok ? pass++ : fail++;
};

// --- Go 用量窗口解析 ---
eq("Go rolling", extractRscObject(goHtml, "rollingUsage"), {
    status: "ok",
    resetInSec: 8660,
    usagePercent: 1,
});
eq("Go weekly", extractRscObject(goHtml, "weeklyUsage"), {
    status: "ok",
    resetInSec: 1,
    usagePercent: 3,
});
eq("Go monthly", extractRscObject(goHtml, "monthlyUsage"), {
    status: "ok",
    resetInSec: 42,
    usagePercent: 0,
});

// --- Zen 余额标量解析（对象风格）---
eq("Zen balance (quoted key, obj)", extractScalar(zenHtml, "balance"), -1392);
eq("Zen reloadAmount", extractScalar(zenHtml, "reloadAmount"), 20);
eq("Zen reloadTrigger", extractScalar(zenHtml, "reloadTrigger"), 5);
eq("Zen useBalance (true)", extractScalar(zenHtml, "useBalance"), true);

// --- Zen 余额标量解析（带引号键 / 布尔简写风格）---
eq("Zen balance (str value)", extractScalar(zenHtml2, "balance"), -1392);
eq("Zen useBalance (!0)", extractScalar(zenHtml2, "useBalance"), true);

// --- 确保不会误匹配包含目标 key 的更大标识符 ---
eq("no myBalance", extractScalar("var myBalance:999,balance:7;", "balance"), 7);
eq("no balanceOf", extractScalar("balanceOf:123,balance:7", "balance"), 7);

console.log(
    `\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败"}: ${pass} pass / ${fail} fail`,
);
process.exit(fail === 0 ? 0 : 1);
