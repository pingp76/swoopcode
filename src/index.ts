/**
 * index.ts — 组装根（Composition Root）
 *
 * 职责：初始化所有组件并将它们连接在一起，然后启动 REPL。
 *
 * 组件初始化顺序（每步只依赖前面已创建的组件，无循环依赖）：
 * config → logger → terminal → llm → history → todoManager → skillManager →
 * permissionManager → memoryManager → sessionEventBuffer → systemPromptProvider →
 * tool providers → tool registry → subagent provider → compressor → agent →
 * cli commands → repl
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
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
} from "./cli-commands.js";
import { createTerminal } from "./terminal.js";
import { createPermissionManager } from "./permission.js";
import { createHookRunner } from "./hooks.js";
import { createMemoryManager } from "./memory.js";
import { createMemoryToolProvider } from "./tools/memory.js";
import { createSystemPromptProvider } from "./system-prompt.js";
import { createSessionEventBuffer } from "./session-events.js";

/**
 * main — 主函数
 *
 * 纯组装逻辑：创建组件 → 注入依赖 → 启动 REPL。
 */
async function main() {
  // 1. 加载配置（从 .env 文件）
  const config = loadConfig();

  // 2. 创建日志器
  const logger = createLogger(config.logLevel);

  // 3. 创建终端（统一 readline，供 REPL 和权限确认共享）
  const terminal = createTerminal();

  // 4. 创建 LLM 客户端
  const llmLogger = createLLMLogger();
  const llm = createLLMClient(config, llmLogger);

  // 5. 创建对话历史管理器
  const history = createHistory();

  // 6. 创建 todo 管理器
  const todoManager = createTodoManager();

  // 7. 创建 Skill 管理器并扫描 skills/ 目录
  const skillsDir = resolve(process.cwd(), "skills");
  const skillManager = createSkillManager(skillsDir);
  if (existsSync(skillsDir)) {
    skillManager.scan();
    logger.info("Loaded %d skills", skillManager.listMeta().length);
  } else {
    logger.info("No skills/ directory found, skills disabled");
  }

  // 8. 创建权限管理器
  const permissionManager = createPermissionManager(process.cwd());

  // 9. 创建 skill 工具提供者
  const skillProvider = createSkillToolProvider(skillManager);

  // 10. 创建 Memory 管理器并扫描 memory/ 目录
  const memoryDir = resolve(process.cwd(), process.env["MEMORY_DIR"] ?? "memory");
  const memoryManager = createMemoryManager({ memoryDir, logger });
  if (existsSync(memoryDir)) {
    memoryManager.scan();
    logger.info("Loaded %d memories", memoryManager.list().length);
  } else {
    logger.info("No memory/ directory found, memory system initialized empty");
  }

  // 11. 创建会话事件缓冲区（用于收集 out-of-band 状态变化）
  const sessionEventBuffer = createSessionEventBuffer();

  // 12. 创建 System Prompt Provider（组合 Skill hint 和 Memory hint）
  //     创建时立即生成一次稳定快照，会话内不再自动刷新
  const systemPromptProvider = createSystemPromptProvider({
    getSkillHint: () =>
      skillManager.listMeta().length > 0 ? SKILL_SYSTEM_PROMPT_HINT : null,
    getMemoryHint: () => memoryManager.buildPromptSection(),
  });

  // 13. 设置稳定的 system prompt（只设置一次，不再每轮更新）
  const snapshot = systemPromptProvider.getSnapshot();
  if (snapshot.systemPrompt) {
    history.setSystemPrompt(snapshot.systemPrompt);
  }

  // 14. 创建 memory 工具提供者（接入 sessionEventBuffer）
  const memoryProvider = createMemoryToolProvider(memoryManager, {
    sessionEventBuffer,
  });

  // 15. 创建 Hook Runner（注册三个教学演示 handler，仅打印日志不修改对话）
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

  // 16. 创建子智能体工具提供者
  //     注入 permissionManager（子智能体继承同一权限模式）
  //     注入 hookRunner（子智能体继承父级 Hook，工具执行前后可观察）
  //     复用父级的稳定 system prompt 快照，保证 cache 前缀一致
  const subagentProvider = createSubagentToolProvider({
    llm,
    logger,
    createFilteredRegistry: () =>
      createToolRegistry(undefined, undefined, skillProvider, memoryProvider),
    createAgentFn: createAgent,
    createCompressorFn: () => createContextCompressor(config.compression),
    permissionManager,
    hookRunner,
    getStableSystemPrompt: () => systemPromptProvider.getSnapshot().systemPrompt,
  });

  // 17. 创建工具注册表
  const tools = createToolRegistry(
    todoManager,
    subagentProvider,
    skillProvider,
    memoryProvider,
  );

  // 18. 创建上下文压缩器
  const compressor = createContextCompressor(config.compression);

  // 19. 创建 Agent（注入权限管理器、确认回调、Hook Runner、System Prompt Provider 和 SessionEventBuffer）
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
  });

  // 20. 注册 CLI 命令（接入 sessionEventBuffer）
  const commandRegistry = createCliCommandRegistry();
  commandRegistry.register(createSkillCliCommand(skillManager, logger, sessionEventBuffer));
  commandRegistry.register(createModeCliCommand(permissionManager, logger, sessionEventBuffer));
  commandRegistry.register(createMemoryCliCommand(memoryManager, logger, sessionEventBuffer));

  // 21. 创建并启动 REPL
  const repl = createRepl({ agent, logger, commands: commandRegistry, terminal });
  logger.info("Agent started (model: %s)", config.model);
  repl.start();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
