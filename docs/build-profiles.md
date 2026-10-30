# 构建档位与验证边界

所有命令从仓库根执行，保留 `scripts/project-env.mjs` 的工程内临时目录和缓存设置，复用已有依赖。

| 用途 | 命令 | 输出与约束 |
| --- | --- | --- |
| 开发检查 | `pnpm check:dev ui.test.ts ui-update.test.ts` | 完整类型检查后仅运行指定测试文件，不生成或替换全量发布证据 |
| 开发服务端 | `pnpm build:dev` | 只构建 server，输出到 `.codex-work/build/profiles/dev/` |
| 开发选定目标 | `pnpm build:dev --targets server,client,runtime` | 支持 server/client/runtime/smoke，不接受版本参数，不构建扩展 |
| Creator 2 原生准备 | `pnpm build:native --major 2` | 构建 server、统一客户端、Creator 2 扩展、runtime 和 smoke 入口 |
| Creator 3 原生准备 | `pnpm build:native --major 3` | 同上，但仅构建 Creator 3 扩展 |
| 完整发布检查 | `pnpm check:release` | 沿用类型检查 → 完整构建 → 全量测试 → 再次完整构建，第二次嵌入当前测试证据 |

`pnpm build` 默认仍是 release 完整构建。构建成功不等于测试通过、原生验收通过或发布完成。原生档位输出到既有 `.codex-work/build/`，以兼容标准 CLI 安装器；未选择版本的旧文件保持原位，不能据此判断该版本已经重新构建。安装仍使用项目 AGENTS.md 规定的入口及授权/连接验收。

每次构建写入输出目录的 `build-profile.json`，包含档位、目标、源码指纹、UTC 构建时间和状态。每个 esbuild 入口记录耗时（毫秒）和本进程 maxRSS 高水位（KiB），不能把高水位当作该步骤独立峰值。拷贝、哈希及清单生成不计入各编译入口耗时；按实际测量决定后续并发或复用，不宣称跨环境固定加速比例。

2026-10-29 在已有依赖的 macOS ARM64、Node 24.21.0 环境，以同一源码交替执行三组 dev/release 构建：进程墙钟中位数分别为 192.30 ms 和 747.24 ms，开发档位减少约 74.27%。dev 包含 2 个实际编译入口，release 包含 21 个；结果衡量缩小目标后的开发周转，不代表完整构建算法加速，也不包含测试或原生启动。详细样本保存在 `.codex-work/artifacts/optimization-review-20261029/build-profile-benchmark.json`。maxRSS 仅覆盖 Node 进程，不覆盖独立 esbuild 进程。

原生或中断构建会使根输出的完整发布状态失效。打包同时检查完整 release 档位成功、当前源码指纹、全量测试证据及各制品摘要，拒绝混用残留产物。开发档位与定向测试隔离输出，不修改根目录发布档位记录。定向测试记录位于 `.codex-work/logs/verification-dev-tests.jsonl`，只说明该次选定测试结果。

历史构建、账号状态、回滚资料和审计证据不自动清理。测试子进程结束且成功后，只回收此次创建的 fixture 目录；失败目录保留供诊断。

每次构建还生成 `verification-summary.md` 和 `verification-summary.json`，源码指纹与本次运行包相同。摘要包含最近全量测试的源码/报告摘要、通过/失败/跳过/取消计数、Node/系统/架构、操作实现和模块范围状态。首次启用时旧报告没有运行记录会显示 unknown；重新执行全量检查后才记录当前状态。局部测试不能替代该全量记录。

摘要状态为 passed、failed、historical 或 unknown。源码变化时保留历史计数但不标记当前通过；报告内容与记录摘要不符时不展示为可信计数。原生覆盖按精确 Creator 版本证据分别计算，缺失项在 JSON 的 `versions[].unverifiedOperationIds` 中列出。摘要本身不是保存重开、真实点击或设备验收。

## 维护职责边界

| 入口 | 独立职责 | 保留在入口的状态与守卫 |
| --- | --- | --- |
| `extensions/shared/panel.ts` | `panel-view.ts` 生成视图，`panel-style.ts` 管理样式 | IPC、轮询、组合输入、DOM 增量更新、焦点与事件绑定 |
| `extensions/creator3/src/preview.ts` | `preview-capture.ts` 管理截图缓存、绘制完成与截图证据 | 窗口所有权、场景观察、生命周期及输入；观察失效时同步清除截图缓存 |
| `packages/runtime3-bridge/src/index.ts` | `feature-routes.ts` 分发引擎专项能力 | 版本与场景守卫、句柄、订阅、资源所有权和退出清理；路由复用同一帧/调试会话 |
| `packages/application/src/roadmap-operations.ts` | `preview-observations.ts` 负责点击、就绪等待与回归观察 | fixture 所有权、验收账本、取消和工作流；观察服务复用应用调度，不另建原生连接 |

这些拆分不提升能力的原生验证等级。改动相关测试应同时覆盖入口调度和原有生命周期边界；最终发布仍需完整检查及匹配源码的证据。
