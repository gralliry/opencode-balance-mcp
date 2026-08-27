// 协议冒烟测试：模拟 MCP client 调用 initialize / tools/list / tools/call
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 指向待测的 MCP server 入口文件。
const serverPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "index.mjs",
);
// 以子进程方式启动 server，stdin/stdout 走管道（模拟 MCP stdio 传输），stderr 透传到父进程。
const child = spawn("node", [serverPath], {
    stdio: ["pipe", "pipe", "inherit"],
});

// 收集子进程 stdout 上解析出的所有 JSON-RPC 响应。
const rl = [];
child.stdout.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
        if (line.trim()) rl.push(JSON.parse(line));
    }
});

// 向 server 发送一条 JSON-RPC 消息（每行一条）。
const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");

// 依次发送：握手初始化、初始化通知、工具列表、两个工具调用、以及一个不存在的工具。
send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
    },
});
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "query_go_usage", arguments: {} },
});
send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "query_zen_balance", arguments: {} },
});
send({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "no_such_tool", arguments: {} },
});

// 等待足够时间让所有响应返回后统一断言。
setTimeout(() => {
    const results = rl.filter((m) => m.id !== undefined);
    console.log("--- 响应 ---");
    console.log(JSON.stringify(results, null, 2));
    const init = results.find((m) => m.id === 1);
    const list = results.find((m) => m.id === 2);
    const goCall = results.find((m) => m.id === 3);
    const zenCall = results.find((m) => m.id === 4);
    const badCall = results.find((m) => m.id === 5);
    const toolNames = (list?.result?.tools ?? []).map((t) => t.name);
    // 断言：server 名称正确、恰好暴露两个工具、未提供凭据时两个工具都以 isError=true 返回 text、
    // 且未知工具返回 -32602。
    const ok =
        init?.result?.serverInfo?.name === "opencode-balance-mcp" &&
        toolNames.length === 2 &&
        toolNames.includes("query_go_usage") &&
        toolNames.includes("query_zen_balance") &&
        // 无凭据时两个工具都应返回 text 类型（错误信息也是 text）
        goCall?.result?.content?.[0]?.type === "text" &&
        goCall?.result?.isError === true &&
        zenCall?.result?.content?.[0]?.type === "text" &&
        zenCall?.result?.isError === true &&
        badCall?.error?.code === -32602;
    console.log(ok ? "\n✅ 测试通过" : "\n❌ 测试失败");
    child.kill();
    process.exit(ok ? 0 : 1);
}, 15000);
