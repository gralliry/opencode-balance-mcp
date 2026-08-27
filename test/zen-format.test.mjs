// 验证 formatZen 纯函数（直接 import 生产代码，不复制逻辑）。
// 余额单位是 1e-8 USD（与 dashboard 客户端 formatBalance = amount / 1e8 一致）。
import { formatZen } from "../src/parse.mjs";

// 简易断言辅助。
let pass = 0,
    fail = 0;
const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`${ok ? "✅" : "❌"} ${name}: got=${JSON.stringify(got)}`);
    if (!ok) console.log(`   want=${JSON.stringify(want)}`);
    ok ? pass++ : fail++;
};

// 有余额、有自动充值（负余额 = credit；-1392000000 / 1e8 = $13.92）
eq(
    "credit case",
    formatZen(
        {
            balanceRaw: -1392000000,
            reloadAmount: 20,
            reloadAmountMin: 10,
            reloadTrigger: 5,
            reloadTriggerMin: 5,
        },
        "wrk_1",
    ),
    {
        workspaceId: "wrk_1",
        plan: "pay-as-you-go",
        balanceRaw: -1392000000,
        balanceUsd: 13.92,
        balanceFormatted: "$13.92 (credit)",
        autoReload: {
            triggerUsd: 5,
            triggerMinUsd: 5,
            reloadUsd: 20,
            reloadMinUsd: 10,
        },
        reloadAmount: 20,
        reloadTrigger: 5,
    },
);

// 欠费（正余额；500000000 / 1e8 = $5.00）
eq("owed case", formatZen({ balanceRaw: 500000000 }, "wrk_2"), {
    workspaceId: "wrk_2",
    plan: "pay-as-you-go",
    balanceRaw: 500000000,
    balanceUsd: 5,
    balanceFormatted: "$5.00 (owed)",
    autoReload: null,
    reloadAmount: null,
    reloadTrigger: null,
});

// 零余额
eq("zero case", formatZen({ balanceRaw: 0 }, "wrk_3"), {
    workspaceId: "wrk_3",
    plan: "pay-as-you-go",
    balanceRaw: 0,
    balanceUsd: 0,
    balanceFormatted: "$0.00",
    autoReload: null,
    reloadAmount: null,
    reloadTrigger: null,
});

// 亚美分负值 → 显示 $0.00 而不是 "$-0.00"
eq("tiny negative balance", formatZen({ balanceRaw: -1 }, "wrk_4").balanceFormatted, "$0.00");

// 页面无 balance 字段 → 返回 null，由调用方决定是否抛错
eq("no balance field", formatZen({ reloadAmount: 20 }, "wrk_5"), null);

console.log(
    `\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败"}: ${pass} pass / ${fail} fail`,
);
process.exit(fail === 0 ? 0 : 1);
