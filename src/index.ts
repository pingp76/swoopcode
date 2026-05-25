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
import { createDefaultAsyncCommandPolicy } from "./tools/bash.js";

/**
 * main — 主函数
 *
 * 纯组装逻辑：创建组件 → 注入依赖 → 启动 REPL。
 */
async function main() {
  // 1. 加载配置（从 .env 文件）
  const config = loadConfig();

  // 2. 创建项目上下文：集中管理 projectRoot 和 Agent 全局运行目录
  const projectContext = createProjectContext();

  // 3. 创建日志器（同时写入 logs/agent.log，保留 console 输出便于实时观察）
  const logger = createLogger(
    config.logLevel,
    resolve(projectContext.logsDir, "agent.log"),
  );

  // 4. 创建终端（统一 readline，供 REPL 和权限确认共享）
  const terminal = createTerminal();

  // 5. 创建 LLM 客户端
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
  );

  // 6. 创建会话管理器和原始 transcript 存储
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
  const skillManager = createSkillManager(projectContext.skillsDir);
  if (existsSync(projectContext.skillsDir)) {
    skillManager.scan();
    logger.info("Loaded %d skills", skillManager.listMeta().length);
  } else {
    logger.info("No global skills/ directory found, skills disabled");
  }

  // 10. 创建权限管理器
  const permissionManager = createPermissionManager(projectContext.projectRoot);

  // 11. 创建 skill 工具提供者
  const skillProvider = createSkillToolProvider(skillManager);

  // 12. 创建 Memory 管理器并扫描 Agent 全局 memory/ 目录
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
  const sessionEventBuffer = createSessionEventBuffer();

  // 14. 创建持久化 Task 系统
  //     Task 是 Agent 全局运行数据，默认放在 agentHome/tasks，不写入被操作项目目录。
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

  // 20.5. 创建 Async Run 管理器
  //       输出目录放在 taskOutputsDir/async-runs/
  const asyncRunManager = createAsyncRunManager({
    projectRoot: projectContext.projectRoot,
    taskOutputsDir: projectContext.taskOutputsDir,
    llm,
    logger,
    commandPolicy: createDefaultAsyncCommandPolicy(),
    createAgentFn: createAgent,
    createCompressorFn: () =>
      createContextCompressor({
        ...config.compression,
        outputDir: projectContext.taskOutputsDir,
      }),
    createReadonlyRegistryFn: (readPaths: string[]) =>
      createToolRegistry(
        undefined, // no todo
        undefined, // no subagent (prevent nesting)
        skillProvider, // allow skills
        undefined, // no memory
        undefined, // no task
        undefined, // no async-run (prevent nesting)
        {
          projectRoot: projectContext.projectRoot,
          commandPolicy: createDefaultAsyncCommandPolicy(),
          includeFileWrite: false,
          includeFileEdit: false,
          readPolicy: {
            validate(path: string) {
              const resolvedPath = resolve(projectContext.projectRoot, path);
              // read_paths 为空数组时禁止读取任何项目文件
              if (readPaths.length === 0) {
                return {
                  allowed: false,
                  reason: "No read paths declared for this async run",
                };
              }
              // 检查路径是否落在任一 declared read_paths 内
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

  // 20.6. 创建 Async Run 工具提供者
  const asyncRunProvider = createAsyncRunToolProvider(
    asyncRunManager,
    createDefaultAsyncCommandPolicy(),
  );

  // 21. 创建子智能体工具提供者
  //     注入 permissionManager 和 commandPolicy，内部构建 scoped permission manager
  //     scoped manager 不给子智能体 default 模式的 ask 行为，而是固定只读诊断能力范围
  //     注入 hookRunner（子智能体继承父级 Hook，工具执行前后可观察）
  //     复用父级的稳定 system prompt 快照，保证 cache 前缀一致
  const subagentProvider = createSubagentToolProvider({
    llm,
    logger,
    createFilteredRegistry: () =>
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
    commandPolicy: createDefaultAsyncCommandPolicy(),
    hookRunner,
    getStableSystemPrompt: () =>
      systemPromptProvider.getSnapshot().systemPrompt,
    sessionManager,
    transcriptStore,
    parentSessionId: mainSession.id,
  });

  // 22. 创建工具注册表
  const tools = createToolRegistry(
    todoManager,
    subagentProvider,
    skillProvider,
    memoryProvider,
    taskProvider,
    asyncRunProvider,
    { projectRoot: projectContext.projectRoot },
  );

  // 23. 创建上下文压缩器
  const compressor = createContextCompressor({
    ...config.compression,
    outputDir: projectContext.taskOutputsDir,
  });

  // 24. 创建 Agent（注入权限管理器、确认回调、Hook Runner、System Prompt Provider 和 SessionEventBuffer）
  const agent = createAgent({
    llm,
    history,
    tools,
    logger,
    todoManager,
    compressor,
    maxContextTokens: config.compression.maxContextTokens,
    permissionManager,
    askUserFn: terminal.askUser.bind(terminal),
    hookRunner,
    systemPromptProvider,
    sessionEventBuffer,
    transcriptStore,
    sessionId: mainSession.id,
    asyncRunManager,
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

  // 26. 创建并启动 REPL
  const repl = createRepl({
    agent,
    logger,
    commands: commandRegistry,
    terminal,
  });
  logger.info(
    "Agent started (provider: %s, model: %s, project: %s)",
    config.provider,
    config.model,
    projectContext.projectRoot,
  );
  repl.start();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
