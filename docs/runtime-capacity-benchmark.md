# 运行时网关容量基准

入口为 `scripts/runtime-capacity-benchmark.ts`。它建立五个隔离工程夹具，使用默认配额和真实回环 HTTP；不连接 Creator、不执行游戏或 GPU 渲染。成功时只回收该次自有测试目录，报告保留在 `.codex-work/artifacts/runtime-capacity-benchmark/`。

先按项目规则设置 TMPDIR/TMP/TEMP/XDG_CACHE_HOME，然后执行：

```sh
node scripts/project-env.mjs node -e 'require("esbuild").buildSync({entryPoints:["scripts/runtime-capacity-benchmark.ts"],outfile:".codex-work/build/runtime-capacity-benchmark.mjs",bundle:true,packages:"external",platform:"node",target:"node24",format:"esm"})'
node scripts/project-env.mjs node .codex-work/build/runtime-capacity-benchmark.mjs
```

## 2026-10-29 本机结果

Node v24.21.0，macOS ARM64。默认每工程 32、总计 128 个会话；每会话 128、总计 512 个待处理命令。各配额的额外请求均返回 RESOURCE_BUSY。512 个命令逐一经 HTTP poll/reply 排空并核对结果；之后 20 个 1 MiB 文本回复全部完成，证明容量释放后可继续服务。

| 阶段 | 样本 | P50 毫秒 | P95 毫秒 |
| --- | ---: | ---: | ---: |
| 注册会话 | 128 | 0.404 | 0.822 |
| 达到配额后的 poll/reply 排空 | 512 | 0.433 | 0.825 |
| 恢复后的 1 MiB 回复 | 20 | 3.836 | 6.332 |

进程 RSS 起点 20,433,680 字节，5 毫秒采样峰值 222,234,120 字节；系统进程 maxRSS 为 250,928 KiB。包含 HTTP、JSON、测试载荷及垃圾回收影响，不能解释为网关自身分配量或稳定常驻内存。采样会漏掉瞬时峰值。

原始报告：`.codex-work/artifacts/runtime-capacity-benchmark/2026-10-29T12-23-41.379Z/REPORT.json`。保留逐次延迟和环境，不含访问令牌。排空计时只包含每个 poll/reply 的传输，不包含此前排队时间；载荷为文本而非解码图片。慢流、正文读取并发、断线和迟到回复边界由自动回归覆盖，此基准不宣称覆盖全部容量维度，也不作为真实引擎吞吐承诺。
