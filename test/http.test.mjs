// 单元测试：用本地 http 服务器验证网络层的超时 / 重试 / 退避 / 页面抓取。
import { createServer } from "node:http";
import { fetchWithRetry, fetchPage } from "../src/http.mjs";

// 简易断言辅助。
let pass = 0,
    fail = 0;
const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`${ok ? "✅" : "❌"} ${name}: got=${JSON.stringify(got)}`);
    if (!ok) console.log(`   want=${JSON.stringify(want)}`);
    ok ? pass++ : fail++;
};
const okAsync = async (name, fn) => {
    try {
        await fn();
        console.log(`✅ ${name}`);
        pass++;
    } catch (err) {
        console.log(`❌ ${name}: ${err.message}`);
        fail++;
    }
};
// 断言 fn() 以匹配 pattern 的错误消息 reject。
const rejects = async (name, fn, pattern) => {
    try {
        await fn();
        console.log(`❌ ${name}: did not reject`);
        fail++;
    } catch (err) {
        const ok = pattern.test(err.message);
        console.log(`${ok ? "✅" : "❌"} ${name}: ${err.message}`);
        ok ? pass++ : fail++;
    }
};

// 快速策略：短超时、少重试，让测试不等待生产默认值。
const fastPolicy = { timeoutMs: 300, maxRetries: 2, retryDelayMs: 5 };

// 路由级计数器：flaky 前 2 次返回 500，之后 200。
let flakyHits = 0;
let rateHits = 0;
const server = createServer((req, res) => {
    if (req.url === "/ok") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("hello");
    } else if (req.url === "/flaky") {
        flakyHits++;
        if (flakyHits <= 2) {
            res.writeHead(500);
            res.end("boom");
        } else {
            res.writeHead(200);
            res.end("recovered");
        }
    } else if (req.url === "/ratelimit") {
        rateHits++;
        res.writeHead(429, { "retry-after": "0" });
        res.end("slow down");
    } else if (req.url === "/always-500") {
        res.writeHead(500);
        res.end("nope");
    } else if (req.url === "/hang") {
        // 永不响应：触发超时。
    } else if (req.url === "/drop") {
        res.socket.destroy(); // 模拟连接被重置
    } else if (req.url === "/redirect") {
        // 模拟 cookie 过期时跳转到登录页（auth.opencode.ai）
        res.writeHead(302, {
            location: "https://auth.opencode.ai/authorize?client_id=app",
        });
        res.end();
    } else if (req.url === "/unauthorized") {
        res.writeHead(401);
        res.end();
    } else {
        res.writeHead(404);
        res.end();
    }
});

const base = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
        resolve(`http://127.0.0.1:${server.address().port}`),
    );
});

try {
    // 1. 正常 200
    const ok = await fetchWithRetry(`${base}/ok`, {}, fastPolicy);
    eq("200 returns response", ok.status, 200);

    // 2. 500 后自动重试成功（共 3 次请求，前 2 次 500）
    flakyHits = 0;
    const flaky = await fetchWithRetry(`${base}/flaky`, {}, fastPolicy);
    eq("5xx retried then 200", flaky.status, 200);
    eq("5xx retry request count", flakyHits, 3);

    // 3. 429 + Retry-After 重试后耗尽 → 返回 429 由调用方报告
    rateHits = 0;
    const rate = await fetchWithRetry(`${base}/ratelimit`, {}, fastPolicy);
    eq("429 retried, exhausted returns 429", rate.status, 429);
    eq("429 retry request count", rateHits, 3);

    // 4. 重试耗尽后仍 500 → 返回响应而不是抛错
    const always = await fetchWithRetry(`${base}/always-500`, {}, fastPolicy);
    eq("always-500 returns response", always.status, 500);

    // 5. 超时 → 抛出友好错误
    await rejects(
        "timeout throws friendly error",
        () => fetchWithRetry(`${base}/hang`, {}, { ...fastPolicy, timeoutMs: 100 }),
        /timed out/,
    );

    // 6. 连接重置 → 重试后抛出 Network error
    await rejects(
        "network error thrown after retries",
        () => fetchWithRetry(`${base}/drop`, {}, fastPolicy),
        /Network error/,
    );

    // 7. redirect: manual 时 302 不被跟随，Location 头保留（fetchPage 依赖此机制
    //    来识别 cookie 过期 → 登录页跳转）
    const redir = await fetchWithRetry(
        `${base}/redirect`,
        { redirect: "manual" },
        fastPolicy,
    );
    eq("302 not followed with redirect:manual", redir.status, 302);
    eq(
        "location header preserved",
        redir.headers.get("location")?.startsWith("https://auth.opencode.ai"),
        true,
    );

    // 8. fetchPage：200 返回文本，cookie 自动加 auth= 前缀
    const pageText = await fetchPage(`${base}/ok`, "Fe26.2**abc");
    eq("fetchPage 200 returns body text", pageText, "hello");

    // 9. fetchPage：302（登录页跳转）→ 明确报 cookie 过期
    await rejects(
        "fetchPage 302 raises auth-redirect error",
        () => fetchPage(`${base}/redirect`, "Fe26.2**expired"),
        /Authentication failed.*redirected/,
    );

    // 10. fetchPage：401 → 明确报认证失败
    await rejects(
        "fetchPage 401 raises auth error",
        () => fetchPage(`${base}/unauthorized`, "Fe26.2**expired"),
        /Authentication failed \(HTTP 401\)/,
    );
} finally {
    server.close();
}

console.log(
    `\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败"}: ${pass} pass / ${fail} fail`,
);
process.exit(fail === 0 ? 0 : 1);
