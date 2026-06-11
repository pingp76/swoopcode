/**
 * index.ts — 组装根（Composition Root）
 *
 * 职责：初始化所有组件并将它们连接在一起，然后启动 REPL。
 *
 * 组件初始化顺序（每步只依赖前面已创建的组件，无循环依赖）：
 * config → projectContext → logger → terminal → llm → session/transcript →
 * history → todoManager → skillManager → permissionManager → memoryManager →
 * sessionEventBuffer → taskStore/taskManager → systemPromptProvider →
 * tool providers → tool registry → subagent provider → compressor → agent →
 * cli commands → repl
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { loadConfig } from "./config.js";
import { createProjectContext } from "./project-context.js";
import { createLogger } from "./logger.js";
import { createLLMClient } from "./llm.js";
import { createHistory } from "./history.js";
import { createToolRegistry } from "./tools/registry.js";
import { createAgent } from "./agent.js";
import { createTodoManager } from "./todo.js";
import { createSubagentToolProvider } from "./tools/subagent.js";
import {
  createSkillManager,
  createSkillToolProvider,
  SKILL_SYSTEM_PROMPT_HINT,
} from "./skills.js";
import { createLLMLogger } from "./llm-logger.js";
import { createContextCompressor } from "./compressor.js";
import { createRepl } from "./repl.js";
import {
  createCliCommandRegistry,
  createSkillCliCommand,
  createModeCliCommand,
  createMemoryCliCommand,
  createTaskCliCommand,
} from "./cli-commands.js";
import { createTerminal } from "./terminal.js";
import { createPermissionManager } from "./permission.js";
import { createHookRunner } from "./hooks.js";
import { createMemoryManager } from "./memory.js";
import { createMemoryToolProvider } from "./tools/memory.js";
import { createSystemPromptProvider } from "./system-prompt.js";
import { createSessionEventBuffer } from "./session-events.js";
import { createSessionManager } from "./session.js";
import { createTranscriptStore } from "./transcript.js";
import { createTaskStore } from "./task-store.js";
import { createTaskManager } from "./tasks.js";
import { createTaskToolProvider } from "./tools/tasks.js";
import { createAsyncRunManager } from "./async-runs.js";
import { createAsyncRunToolProvider } from "./tools/async-runs.js";
import {
  createExecutionPolicy,
  createReadonlyCommandPolicy,
} from "./execution-policy.js";
import { createScheduleStore } from "./schedule-store.js";
import { createScheduleManager } from "./schedules.js";
import { createScheduleToolProvider } from "./tools/schedules.js";
import { createScheduleCliCommand } from "./cli-commands.js";
import { createOutputStore } from "./output-store.js";
import { createOutputToolProvider } from "./tools/output.js";
import { createStableContextManager } from "./stable-context.js";
import { createContextRanker } from "./context-ranking.js";
import { createRuntimePolicyStore } from "./runtime-policy-store.js";
import {
  createModelPolicyCliCommand,
  createThinkingCliCommand,
  createStableContextCliCommand,
} from "./cli-commands.js";

/**
 * main — 主函数
 *
 * 纯组装逻辑：创建组件 → 注入依赖 → 启动 REPL。
 */
async function main() {
  // 架构导读：index.ts 是 Composition Root（组装根）。
  //
  // 组装根的职责不是写业务逻辑，而是把所有“有状态对象”和“跨模块依赖”
  // 在一个地方创建清楚、连接清楚。学生读这个文件时应该重点看三件事：
  //
  // 1. 哪些实例必须全局共享？
  //    例如 permissionManager、executionPolicy、outputStore、sessionEventBuffer。
  //    如果在子智能体或 async run 里重新 create 一份，看似参数相同，
  //    实际上状态、通知队列、output_id、权限模式都会断开。
  //
  // 2. 哪些能力要被过滤？
  //    主 Agent 可以拿完整 registry；后台子 Agent 只能拿 readonly registry。
  //    这体现了 agent 架构里的常见套路：不是让所有执行路径共享最大权限，
  //    而是按执行场景注入不同能力。
  //
  // 3. 哪些内容属于稳定前缀，哪些属于动态提醒？
  //    system prompt / tool definitions 在会话内保持稳定；memory 更新、task active group、
  //    async/schedule 通知都通过普通消息 reminder 注入，避免破坏 prompt cache。

  // 1. 加载配置（从 .env 文件）
  const config = loadConfig();

  // 2. 创建项目上下文：集中管理 projectRoot 和 Agent 全局运行目录
  // 常见坑：直接在各模块里使用 process.cwd()。
  // 这样会让“被操作项目目录”和“Agent 自身运行数据目录”混在一起。
  // ProjectContext 把 projectRoot、agentHome、logsDir、memoryDir、tasksDir 等一次性定好，
  // 后续所有模块都从这里拿路径，边界才不会漂移。
  const projectContext = createProjectContext();

  // 3. 创建日志器（同时写入 logs/agent.log，保留 console 输出便于实时观察）
  const logger = createLogger(
    config.logLevel,
    resolve(projectContext.logsDir, "agent.log"),
  );

  // 4. 创建终端（统一 readline，供 REPL 和权限确认共享）
  const terminal = createTerminal();

  // 5. 创建 Runtime Policy Store（session-local 可变策略存储）
  const runtimePolicyStore = createRuntimePolicyStore(
    config.modelProfile,
    config.model,
    process.env,
  );

  // 5.5. 创建 ContextRanker 和 Stable Context Manager（长上下文模型使用）
  // ContextRanker 为任意项目类型生成通用内容重要性排序
  const contextRanker = createContextRanker(projectContext.projectRoot);
  const stableContextManager = createStableContextManager(
    projectContext.projectRoot,
    config.runtimePolicy.modelProfileId,
    () => runtimePolicyStore.getPolicy().contextLoading!,
    contextRanker,
  );

  // 6. 创建 LLM 客户端
  const llmLogger = createLLMLogger({ logDir: projectContext.logsDir });
  const llm = createLLMClient(
    {
      provider: config.provider,
      displayName: config.providerDisplayName,
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      model: config.model,
      capabilities: config.llmCapabilities,
    },
    llmLogger,
    () => runtimePolicyStore.getPolicy(),
  );

  // 6. 创建会话管理器和原始 transcript 存储
  // History 和 Transcript 是两个不同层次：
  // - History 是 prompt working context，会被压缩、替换、整理
  // - Transcript 是 append-only 原始事件流，用于未来审计/回放
  // 常见错误是只保留 History，结果 compact 后再也看不到原始过程。
  const sessionManager = createSessionManager({
    projectRoot: projectContext.projectRoot,
    cwd: projectContext.projectRoot,
    model: config.model,
  });
  const mainSession = sessionManager.createMainSession("main");
  const transcriptStore = createTranscriptStore();

  // 7. 创建对话历史管理器
  const history = createHistory();

  // 8. 创建 todo 管理器
  const todoManager = createTodoManager();

  // 9. 创建 Skill 管理器并扫描 Agent 全局 skills/ 目录
  // Skill 是 Agent 自身能力，不是当前项目源码的一部分。
  // 所以它从 agentHome 派生的全局 skillsDir 读取，而不是写进 projectRoot。
  // 这能避免 agent 在用户项目里制造隐藏状态，也方便跨项目复用技能。
  const skillManager = createSkillManager(projectContext.skillsDir);
  if (existsSync(projectContext.skillsDir)) {
    skillManager.scan();
    logger.info("Loaded %d skills", skillManager.listMeta().length);
  } else {
    logger.info("No global skills/ directory found, skills disabled");
  }

  // 10. 创建权限管理器
  // permissionManager 必须是共享实例。
  // /mode 命令修改的是这一份实例；主 Agent、subagent provider、async manager
  // 都引用同一份，才能保证权限模式变化在整个进程中一致可见。
  const permissionManager = createPermissionManager(projectContext.projectRoot);

  // 11. 创建 skill 工具提供者
  const skillProvider = createSkillToolProvider(skillManager);

  // 12. 创建 Memory 管理器并扫描 Agent 全局 memory/ 目录
  // Memory 会影响未来会话，因此它也属于 agentHome 全局运行数据。
  // 但当前会话的 system prompt snapshot 不会因为中途创建 memory 自动改写；
  // 新 memory 通过 sessionEventBuffer reminder 告知模型，这是 cache-friendly 的取舍。
  const memoryManager = createMemoryManager({
    memoryDir: projectContext.memoryDir,
    logger,
  });
  if (existsSync(projectContext.memoryDir)) {
    memoryManager.scan();
    logger.info("Loaded %d memories", memoryManager.list().length);
  } else {
    logger.info(
      "No global memory/ directory found, memory system initialized empty",
    );
  }

  // 13. 创建会话事件缓冲区（用于收集 out-of-band 状态变化）
  // sessionEventBuffer 是“动态状态 → LLM 可见提醒”的统一出口。
  // 设计注意点：不要让工具或 CLI 命令直接改 system prompt；
  // 它们只 push event，由 agent.run() 在下一轮统一 drain。
  const sessionEventBuffer = createSessionEventBuffer();

  // 14. 创建持久化 Task 系统
  //     Task 是 Agent 全局运行数据，默认放在 agentHome/tasks，不写入被操作项目目录。
  // TaskStore 和 TaskManager 分开是一个重要教学点：
  // - Store 负责磁盘布局与读写对称校验
  // - Manager 负责状态机和依赖图
  // 如果把它们混在工具层，学生会很难区分“参数错”“业务状态错”“磁盘文件坏”。
  const taskStore = createTaskStore({
    tasksDir: projectContext.tasksDir,
    projectRoot: projectContext.projectRoot,
    logger,
  });
  taskStore.cleanupTempFiles();
  const taskSummaries = taskStore.scan();
  const taskManager = createTaskManager({
    store: taskStore,
    projectRoot: projectContext.projectRoot,
  });
  const activeTaskCount = taskStore.list({ status: "active" }).length;
  if (activeTaskCount > 0) {
    sessionEventBuffer.push({
      source: "task",
      message: `Current project has ${activeTaskCount} active task group(s). Use run_task_group_list/read if the user wants to continue previous work.`,
    });
  }
  logger.info("Loaded %d task group(s)", taskSummaries.length);

  // 15. 读取项目级 AGENTS.md 指令（如果存在），作为稳定 system prompt 的最前缀。
  //     这是 coding agent 的常见惯例：项目约束高于通用 skill/memory 提示。
  const projectInstructions = existsSync(projectContext.agentsFile)
    ? readFileSync(projectContext.agentsFile, "utf-8")
    : null;
  if (projectInstructions) {
    logger.info("Loaded project instructions from AGENTS.md");
  }

  // 16. 创建 System Prompt Provider（组合 AGENTS.md + Skill hint + Memory hint）
  //     创建时立即生成一次稳定快照，会话内不再自动刷新
  // 常见坑：每轮都重新拼 system prompt。
  // 这样虽然“看起来更实时”，但会让 prompt cache 前缀频繁变化，
  // 也会使一次会话内的行为边界不稳定。本项目选择启动时 snapshot，
  // 中途变化走 reminder，这是一种工程上常见的稳定前缀设计。
  const systemPromptProvider = createSystemPromptProvider({
    getProjectInstructions: () => projectInstructions,
    getSkillHint: () =>
      skillManager.listMeta().length > 0 ? SKILL_SYSTEM_PROMPT_HINT : null,
    getMemoryHint: () => memoryManager.buildPromptSection(),
  });

  // 17. 设置稳定的 system prompt（只设置一次，不再每轮更新）
  const snapshot = systemPromptProvider.getSnapshot();
  if (snapshot.systemPrompt) {
    history.setSystemPrompt(snapshot.systemPrompt);
  }

  // 18. 创建 memory 工具提供者（接入 sessionEventBuffer）
  const memoryProvider = createMemoryToolProvider(memoryManager, {
    sessionEventBuffer,
  });

  // 19. 创建 task 工具提供者（接入 sessionEventBuffer）
  const taskProvider = createTaskToolProvider(taskManager, {
    sessionEventBuffer,
  });

  // 20. 创建 Hook Runner（注册三个教学演示 handler，仅打印日志不修改对话）
  //     父子 Agent 共享同一个实例，确保子智能体继承父级 Hook
  // HookRunner 放在组装根创建，而不是在 Agent 内部 new。
  // 这样未来可以把真实的 hook 配置、测试 hook、审计 hook 注入同一个 Agent，
  // 也能保证 subagent 使用父级同一套观察点。
  const hookRunner = createHookRunner(
    {
      // SessionStart：会话开始时记录用户输入
      SessionStart: [
        (event) => {
          if (event.name === "SessionStart") {
            logger.info(
              "[Hook:SessionStart] 会话开始，用户输入: %s",
              event.payload.query.slice(0, 80),
            );
          }
          return { exitCode: 0 };
        },
      ],
      // PreToolUse：工具执行前记录工具名和参数摘要
      PreToolUse: [
        (event) => {
          if (event.name === "PreToolUse") {
            const { toolName, args } = event.payload;
            const argsPreview = JSON.stringify(args).slice(0, 120);
            logger.info(
              "[Hook:PreToolUse] 即将执行 %s，参数: %s",
              toolName,
              argsPreview,
            );
          }
          return { exitCode: 0 };
        },
      ],
      // PostToolUse：工具执行后记录结果摘要
      PostToolUse: [
        (event) => {
          if (event.name === "PostToolUse") {
            const { toolName, error, output } = event.payload;
            logger.info(
              "[Hook:PostToolUse] %s 执行完毕 (%s)，输出: %s",
              toolName,
              error ? "失败" : "成功",
              output.slice(0, 120),
            );
          }
          return { exitCode: 0 };
        },
      ],
    },
    logger,
  );

  // 20.4. 创建 Schedule 存储和管理器
  //       Schedule 数据放在 schedulesDir/schedules/
  const scheduleStore = createScheduleStore({
    schedulesDir: projectContext.schedulesDir,
    projectRoot: projectContext.projectRoot,
    logger,
  });
  const executionPolicy = createExecutionPolicy();
  const readonlyCommandPolicy = createReadonlyCommandPolicy(executionPolicy);
  // ExecutionPolicy 和 PermissionManager 的分工很容易混淆：
  // - PermissionManager 面向“当前前台用户是否授权”
  // - ExecutionPolicy 面向“非交互路径拿到授权后，还能执行哪些命令/资源”
  // Async Run、Schedule、Subagent 都属于非交互或半非交互路径，因此必须额外收窄。

  // OutputStore 是“大输出句柄”边界。
  // Async Run、Schedule、压缩器都复用同一个实例，确保 output_id 在整个进程内一致可读。
  // 常见坑：每个模块各自创建 OutputStore。
  // 这样 async run 写出的 output_id 可能在主 Agent 的 run_output_read 中读不到；
  // 共享同一实例和同一 outputDir 可以避免 handle 空转。
  const outputStore = createOutputStore({
    outputDir: projectContext.taskOutputsDir,
  });

  // 20.5. 创建 Async Run 管理器
  //       输出目录放在 taskOutputsDir/async-runs/
  const asyncRunManager = createAsyncRunManager({
    projectRoot: projectContext.projectRoot,
    taskOutputsDir: projectContext.taskOutputsDir,
    llm,
    logger,
    executionPolicy,
    commandPolicy: readonlyCommandPolicy,
    outputStore,
    createAgentFn: createAgent,
    createCompressorFn: () =>
      createContextCompressor({
        ...config.compression,
        outputDir: projectContext.taskOutputsDir,
      }),
    // createReadonlyRegistryFn 是能力分层的关键点。
    // 它不是简单复用主 Agent 的 tools，而是为后台 subagent 重新组装一份“窄工具集”。
    // 设计套路：共享底层依赖（llm/logger/policy/outputStore），但不共享最大工具能力。
    createReadonlyRegistryFn: (readPaths: string[]) =>
      // 后台子智能体使用只读 registry：
      // - 不注册写文件/编辑文件能力
      // - 不允许继续启动 subagent 或 async run
      // - run_read 还要受 declared read_paths 限制
      createToolRegistry(
        undefined, // no todo
        undefined, // no subagent (prevent nesting)
        skillProvider, // allow skills
        undefined, // no memory
        undefined, // no task
        undefined, // no async-run (prevent nesting)
        {
          projectRoot: projectContext.projectRoot,
          commandPolicy: readonlyCommandPolicy,
          includeFileWrite: false,
          includeFileEdit: false,
          readPolicy: {
            validate(path: string) {
              const resolvedPath = resolve(projectContext.projectRoot, path);
              // read_paths 为空数组时禁止读取任何项目文件
              // 这是 fail-closed 设计：调用方没有声明可读范围时，不能默认读整个项目。
              if (readPaths.length === 0) {
                return {
                  allowed: false,
                  reason: "No read paths declared for this async run",
                };
              }
              // 检查路径是否落在任一 declared read_paths 内
              // 注意比较前先 resolve 到 projectRoot 下。
              // 直接做字符串前缀比较容易被 "../"、相对路径和同名前缀目录绕过。
              for (const allowedPath of readPaths) {
                const resolvedAllowed = resolve(
                  projectContext.projectRoot,
                  allowedPath,
                );
                if (
                  resolvedPath === resolvedAllowed ||
                  resolvedPath.startsWith(resolvedAllowed + sep)
                ) {
                  return { allowed: true };
                }
              }
              return {
                allowed: false,
                reason: `Path "${path}" is outside declared read_paths: ${readPaths.join(", ")}`,
              };
            },
          },
        },
      ),
    getStableSystemPrompt: () =>
      systemPromptProvider.getSnapshot().systemPrompt,
    sessionManager,
    transcriptStore,
    parentSessionId: mainSession.id,
    hookRunner,
    permissionManager,
  });

  const scheduleManager = createScheduleManager({
    // ScheduleManager 只负责发现 due occurrence 和触发 Async Run。
    // Async Run 完成后通过 setOnFinish 回调再写回 occurrence 终态。
    store: scheduleStore,
    asyncRunManager,
    projectRoot: projectContext.projectRoot,
    logger,
    executionPolicy,
    commandPolicy: readonlyCommandPolicy,
  });

  // 20.6. 创建 Schedule 工具提供者
  const scheduleProvider = createScheduleToolProvider(scheduleManager);

  // 20.7. 创建 Async Run 工具提供者
  const asyncRunProvider = createAsyncRunToolProvider(
    asyncRunManager,
    readonlyCommandPolicy,
  );

  // 20.8. 创建 Output 工具提供者
  //       只按 output_id 读取 OutputStore 登记过的大输出，不开放任意路径读取。
  const outputProvider = createOutputToolProvider(outputStore);

  // 21. 创建子智能体工具提供者
  //     注入 permissionManager 和 commandPolicy，内部构建 scoped permission manager
  //     scoped manager 不给子智能体 default 模式的 ask 行为，而是固定只读诊断能力范围
  //     注入 hookRunner（子智能体继承父级 Hook，工具执行前后可观察）
  //     复用父级的稳定 system prompt 快照，保证 cache 前缀一致
  const subagentProvider = createSubagentToolProvider({
    llm,
    logger,
    createFilteredRegistry: () =>
      // 前台 run_subagent 的过滤策略和 async subagent 略有不同：
      // 它允许 memoryProvider（只读/按权限），但仍不传 task/async/schedule 写类能力。
      // 这里展示一个常见模式：同一个 createToolRegistry，根据不同 provider 参数
      // 组装出不同“角色”的工具集。
      createToolRegistry(
        undefined,
        undefined,
        skillProvider,
        memoryProvider,
        undefined,
        undefined,
        {
          projectRoot: projectContext.projectRoot,
        },
      ),
    createAgentFn: createAgent,
    createCompressorFn: () =>
      createContextCompressor({
        ...config.compression,
        outputDir: projectContext.taskOutputsDir,
      }),
    permissionManager,
    commandPolicy: readonlyCommandPolicy,
    hookRunner,
    getStableSystemPrompt: () =>
      systemPromptProvider.getSnapshot().systemPrompt,
    sessionManager,
    transcriptStore,
    parentSessionId: mainSession.id,
  });

  // 22. 创建工具注册表
  // 主 Agent 的 registry 是能力最完整的一份；子 Agent / async Agent 会创建过滤后的 registry。
  // 这样“谁能用什么工具”在组装根里一眼可见。
  // 常见坑：在工具内部临时 import 并调用其他工具。
  // 那会绕过 registry、permission、hook、transcript 等横切逻辑。
  // 本项目要求工具能力都通过 registry 暴露，Agent 主循环统一调度。
  const tools = createToolRegistry(
    todoManager,
    subagentProvider,
    skillProvider,
    memoryProvider,
    taskProvider,
    asyncRunProvider,
    { projectRoot: projectContext.projectRoot },
    scheduleProvider,
    outputProvider,
  );

  // 23. 创建上下文压缩器
  // 主 Agent 的 compressor 注入 outputStore，表示大输出统一进入 OutputStore。
  // 子 Agent/async Agent 会创建自己的 compressor 状态，避免 recentFiles/lastSummary
  // 在父子上下文之间串味；但输出目录仍由 projectContext 统一派生。
  const compressor = createContextCompressor({
    ...config.compression,
    outputDir: projectContext.taskOutputsDir,
    outputStore,
  });

  // 24. 创建 Agent（注入权限管理器、确认回调、Hook Runner、System Prompt Provider 和 SessionEventBuffer）
  const agent = createAgent({
    llm,
    history,
    tools,
    logger,
    todoManager,
    compressor,
    maxContextTokens: () =>
      runtimePolicyStore.getPolicy().context.effectiveBudgetTokens,
    permissionManager,
    askUserFn: terminal.askUser.bind(terminal),
    hookRunner,
    systemPromptProvider,
    sessionEventBuffer,
    transcriptStore,
    sessionId: mainSession.id,
    asyncRunManager,
    scheduleManager,
    stableContextManager,
  });

  // 25. 注册 CLI 命令（接入 sessionEventBuffer）
  const commandRegistry = createCliCommandRegistry();
  commandRegistry.register(
    createSkillCliCommand(skillManager, logger, sessionEventBuffer),
  );
  commandRegistry.register(
    createModeCliCommand(permissionManager, logger, sessionEventBuffer),
  );
  commandRegistry.register(
    createMemoryCliCommand(memoryManager, logger, sessionEventBuffer),
  );
  commandRegistry.register(createTaskCliCommand(taskManager, logger));
  commandRegistry.register(createScheduleCliCommand(scheduleManager, logger));
  commandRegistry.register(
    createModelPolicyCliCommand(runtimePolicyStore, logger),
  );
  commandRegistry.register(
    createThinkingCliCommand(runtimePolicyStore, logger),
  );
  commandRegistry.register(
    createStableContextCliCommand(stableContextManager, logger),
  );

  // 26. 创建并启动 REPL
  const repl = createRepl({
    agent,
    logger,
    commands: commandRegistry,
    terminal,
  });

  // 启动 Schedule Manager（定时检查器）
  // scheduleManager.start() 只启动进程内 timer，不会新建额外进程。
  // 所以退出时也只需要 stop() 清掉 interval。
  scheduleManager.start();

  // 进程退出时停止 Schedule Manager，避免遗留 timer
  process.on("SIGINT", () => {
    scheduleManager.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    scheduleManager.stop();
    process.exit(0);
  });

  // 27. 启动日志：显示模型策略摘要
  logger.info(
    "Agent started (provider: %s, model: %s, profile: %s, protocol: %s, contextBudget: %d, thinking: %s)",
    config.provider,
    config.model,
    config.runtimePolicy.modelProfileId,
    config.runtimePolicy.protocol.selected,
    config.runtimePolicy.context.effectiveBudgetTokens,
    config.runtimePolicy.request.thinkingMode,
  );
  repl.start();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
