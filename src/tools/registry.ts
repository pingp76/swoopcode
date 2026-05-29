/**
 * registry.ts — 工具注册表
 *
 * 职责：统一管理所有可用工具（注册、查询、获取定义列表）。
 *
 * 为什么需要注册表？
 * - Agent 在调用 LLM 时，需要传入所有工具的定义（让模型知道能调用哪些工具）
 * - Agent 收到模型的 tool_call 后，需要根据工具名找到对应的执行函数
 * - 注册表把"工具定义"和"工具执行"绑定在一起，管理起来更清晰
 *
 * 扩展性设计：
 * - 要添加新工具，只需要调用 register() 注册一个新的 ToolEntry
 * - 不需要修改 agent.ts 或其他模块的代码
 * - 这就是"开放-封闭原则"：对扩展开放，对修改封闭
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { bashToolDefinition, executeBash } from "./bash.js";
import {
  runReadToolDefinition,
  executeRead,
  runWriteToolDefinition,
  executeWrite,
  runEditToolDefinition,
  executeEdit,
  runEditExactToolDefinition,
  executeEditExact,
} from "./files.js";
import type { ToolResult } from "./types.js";
import type { TodoToolProvider } from "../todo.js";
import type { SubagentToolProvider } from "./subagent.js";
import type { SkillToolProvider } from "../skills.js";
import type { MemoryToolProvider } from "./memory.js";
import type { TaskToolProvider } from "./tasks.js";
import type { AsyncRunToolProvider } from "./async-runs.js";
import type { ScheduleToolProvider } from "./schedules.js";
import type { OutputToolProvider } from "./output.js";
import type { AsyncCommandPolicy } from "../execution-policy.js";

/**
 * ToolExecutor — 工具执行函数的类型
 *
 * 每个工具都需要提供一个执行函数：
 * - 接收一个参数字典（来自 LLM 的 JSON 解析结果）
 * - 返回 Promise<ToolResult>（因为工具执行通常是异步的）
 *
 * 参数类型为 Record<string, unknown> 而非 Record<string, string>，
 * 因为 LLM 返回的 JSON 经 JSON.parse 后值可以是 string、number、array。
 * 工具实现时需用 String() / Number() 等做类型转换。
 */
export type ToolExecutor = (
  args: Record<string, unknown>,
) => Promise<ToolResult>;

/**
 * ToolRegistryOptions — 工具注册表的可选配置
 *
 * 用于创建过滤后的注册表（如 async subagent 的只读工具集）。
 */
export interface ToolRegistryOptions {
  projectRoot?: string;
  includeFileWrite?: boolean;
  includeFileEdit?: boolean;
  commandPolicy?: AsyncCommandPolicy;
  readPolicy?: {
    validate(path: string): { allowed: boolean; reason?: string };
  };
}

/**
 * ToolEntry — 工具注册项
 *
 * 把"定义"和"执行"绑定在一起：
 * - definition：告诉 LLM 这个工具的接口（名称、参数、描述）
 * - execute：实际执行工具逻辑的函数
 */
interface ToolEntry {
  definition: ChatCompletionTool;
  execute: ToolExecutor;
}

/**
 * ToolRegistry — 工具注册表的接口
 *
 * 只暴露两个方法：
 * - getToolDefinitions：获取所有工具的定义（用于传给 LLM）
 * - getExecutor：根据工具名获取执行函数（用于处理 tool_call）
 */
export interface ToolRegistry {
  getToolDefinitions(): ChatCompletionTool[];
  getExecutor(name: string): ToolExecutor | undefined;
}

/**
 * createToolRegistry — 创建工具注册表
 *
 * @param todoProvider - 可选的 TodoToolProvider，提供 todo 管理工具
 * @param subagentProvider - 可选的 SubagentToolProvider，提供子智能体工具
 * @param skillProvider - 可选的 SkillToolProvider，提供 run_skill 技能调用工具
 *
 * 使用 Map 存储已注册的工具，以工具名为 key，ToolEntry 为 value。
 * Map 查找是 O(1) 的，比遍历数组更高效。
 *
 * 【稳定性要求】同一个进程内，多次 getToolDefinitions() 返回相同顺序。
 * 重复注册同名工具会抛错。CLI 命令不得在会话中途修改已注册工具定义。
 */
export function createToolRegistry(
  todoProvider?: TodoToolProvider,
  subagentProvider?: SubagentToolProvider,
  skillProvider?: SkillToolProvider,
  memoryProvider?: MemoryToolProvider,
  taskProvider?: TaskToolProvider,
  asyncRunProvider?: AsyncRunToolProvider,
  options?: ToolRegistryOptions,
  scheduleProvider?: ScheduleToolProvider,
  outputProvider?: OutputToolProvider,
): ToolRegistry {
  // 教学导读：
  // ToolRegistry 是“工具定义”和“工具执行函数”的总线。
  // LLM API 只需要 tool definitions；Agent 执行 tool_call 时需要 executor。
  // registry 把这两部分放在同一个注册项里，确保“模型看到的工具”和
  // “运行时能执行的工具”来自同一份来源。
  //
  // options 让同一个 registry 工厂可以创建不同能力版本：
  // - 主 Agent：完整工具集
  // - subagent / async subagent：过滤掉写文件、嵌套 subagent、嵌套 async 等能力
  // 这样教学上能清楚展示“依赖注入决定能力边界”。

  // 工具映射表：工具名 → 工具注册项
  // 使用 Map 保证 O(1) 查找效率，key 为工具名，value 为完整 ToolEntry
  const tools = new Map<string, ToolEntry>();
  // 按注册顺序维护的数组，保证 getToolDefinitions() 输出顺序稳定
  // Map 的遍历顺序虽为插入顺序，但用数组显式维护更可靠，避免依赖 Map 内部实现细节
  const orderedEntries: ToolEntry[] = [];

  /**
   * register — 注册一个工具
   *
   * 从工具定义中提取函数名作为 Map 的 key，
   * 将定义和执行函数一起存储。
   *
   * 同名工具重复注册会抛错，防止意外覆盖导致行为不一致。
   */
  function register(entry: ToolEntry): void {
    // 从 OpenAI 工具定义中提取函数名，作为 Map 的 key
    const name = entry.definition.function?.name;
    // 如果定义中缺少函数名，立即抛错，避免注册无名的工具
    if (!name) throw new Error("Tool definition must have a function name");
    // 检查是否已存在同名工具，防止重复注册导致行为不一致
    if (tools.has(name)) {
      // 重复注册通常意味着组装根把同一个 provider 传了两次，
      // 或者两个工具意外使用了相同 name。启动时直接报错比运行时覆盖更安全。
      throw new Error(`Tool "${name}" is already registered`);
    }
    // 将工具存入 Map，用于后续按名查找执行函数
    tools.set(name, entry);
    // 同时推入数组，保持注册顺序，确保 getToolDefinitions() 返回顺序稳定
    orderedEntries.push(entry);
  }

  // 注册 bash 工具
  // 如果提供了 commandPolicy，在执行前先做策略验证
  register({
    definition: bashToolDefinition,
    execute: async (args) => {
      // 从 LLM 传入的参数中提取 command 字段，缺省时转为空字符串
      const command = String(args["command"] ?? "");
      // 如果创建注册表时传入了命令策略，执行前先做安全/权限验证
      if (options?.commandPolicy) {
        // commandPolicy 常用于 async/subagent 的只读 registry。
        // 普通主 Agent 的权限检查在 agent.ts + PermissionManager 中完成；
        // 这里的 policy 是额外收窄，不是替代权限系统。
        const validation = options.commandPolicy.validate(command);
        // 策略拒绝时直接返回错误信息，不真正执行命令
        if (!validation.allowed) {
          return {
            output: `Command blocked by policy: ${validation.reason}`,
            error: true,
          };
        }
      }
      // 策略通过或无需策略时，调用真正的 bash 执行函数
      return executeBash(command, options?.projectRoot);
    },
  });

  // 注册文件读取工具
  // 如果提供了 readPolicy，在执行前先做路径验证
  register({
    definition: runReadToolDefinition,
    execute: async (args) => {
      // 从 LLM 传入的参数中提取 path 字段，缺省时转为空字符串
      const path = String(args["path"] ?? "");
      // 如果创建注册表时传入了读取策略，执行前先做路径权限验证
      if (options?.readPolicy) {
        // readPolicy 允许调用方把 run_read 限制到 declared read_paths。
        // 这对 async subagent 很重要：即使它拿到了 run_read 工具，
        // 也只能读启动 async run 时声明过的路径。
        const validation = options.readPolicy.validate(path);
        // 策略拒绝时直接返回错误信息，不读取文件
        if (!validation.allowed) {
          return {
            output: `Read blocked by policy: ${validation.reason}`,
            error: true,
          };
        }
      }
      // 策略通过或无需策略时，调用真正的文件读取函数
      return executeRead(path, options?.projectRoot);
    },
  });

  // 注册文件写入工具（可选，通过 includeFileWrite 控制）
  // 只有当显式设置为 false 时才跳过注册，默认开启写入能力
  if (options?.includeFileWrite !== false) {
    register({
      definition: runWriteToolDefinition,
      execute: async (args) =>
        // 将 path 和 content 参数强制转为字符串后传入写入函数
        executeWrite(
          String(args["path"] ?? ""),
          String(args["content"] ?? ""),
          options?.projectRoot,
        ),
    });
  }

  // 注册文件编辑工具（可选，通过 includeFileEdit 控制）
  // 只有当显式设置为 false 时才跳过注册，默认开启编辑能力
  if (options?.includeFileEdit !== false) {
    register({
      definition: runEditToolDefinition,
      execute: async (args) =>
        // 将 path、old_string、new_string 参数强制转为字符串后传入编辑函数
        executeEdit(
          String(args["path"] ?? ""),
          String(args["old_string"] ?? ""),
          String(args["new_string"] ?? ""),
          options?.projectRoot,
        ),
    });
    register({
      definition: runEditExactToolDefinition,
      execute: async (args) =>
        // expected_occurrences 需要数字类型，因此用 Number() 转换，缺省为 0
        executeEditExact(
          String(args["path"] ?? ""),
          String(args["old_string"] ?? ""),
          String(args["new_string"] ?? ""),
          Number(args["expected_occurrences"] ?? 0),
          options?.projectRoot,
        ),
    });
  }

  // 注册 todo 管理工具（6 个工具）
  // 通过 TodoToolProvider 获取定义和执行函数，与 bash/files 工具完全一致的模式
  if (todoProvider) {
    // 遍历 provider 提供的所有工具项，逐个注册到注册表
    for (const entry of todoProvider.toolEntries) {
      register(entry);
    }
  }

  // 注册子智能体工具（1 个工具）
  // 通过 SubagentToolProvider 获取定义和执行函数
  // 子智能体本身的注册表中不会传入此 provider，从而防止递归
  if (subagentProvider) {
    // 遍历 provider 提供的所有工具项，逐个注册到注册表
    for (const entry of subagentProvider.toolEntries) {
      register(entry);
    }
  }

  // 注册 skill 工具（1 个工具）
  // 通过 SkillToolProvider 获取定义和执行函数
  // 子智能体的注册表中不会传入此 provider，自然排除 skill 工具
  if (skillProvider) {
    // 遍历 provider 提供的所有工具项，逐个注册到注册表
    for (const entry of skillProvider.toolEntries) {
      register(entry);
    }
  }

  // 注册 memory 工具（4 个工具）
  // 通过 MemoryToolProvider 获取定义和执行函数
  // 子智能体的注册表中不会传入此 provider，子智能体不能直接操作 memory
  if (memoryProvider) {
    // 遍历 provider 提供的所有工具项，逐个注册到注册表
    for (const entry of memoryProvider.toolEntries) {
      register(entry);
    }
  }

  // 注册持久化 task 工具（6 个工具）
  // Task 属于 Agent 全局运行数据，通过 TaskToolProvider 接入注册表。
  if (taskProvider) {
    // 遍历 provider 提供的所有工具项，逐个注册到注册表
    for (const entry of taskProvider.toolEntries) {
      register(entry);
    }
  }

  // 注册 async run 工具（4 个工具）
  // Async Run 是 session-local 的非阻塞运行层，通过 AsyncRunToolProvider 接入注册表。
  if (asyncRunProvider) {
    // 遍历 provider 提供的所有工具项，逐个注册到注册表
    for (const entry of asyncRunProvider.toolEntries) {
      register(entry);
    }
  }

  // 注册 output 工具（1 个工具）
  // OutputStore 属于 Agent 全局运行数据，只能按 output_id 读取登记过的大输出。
  if (outputProvider) {
    // 遍历 provider 提供的所有工具项，逐个注册到注册表
    for (const entry of outputProvider.toolEntries) {
      register(entry);
    }
  }

  // 注册 schedule 工具（6 个工具）
  // Schedule 是持久化定时规则，通过 ScheduleToolProvider 接入注册表。
  if (scheduleProvider) {
    // 遍历 provider 提供的所有工具项，逐个注册到注册表
    for (const entry of scheduleProvider.toolEntries) {
      register(entry);
    }
  }

  return {
    // 返回所有工具的定义列表，用于传给 LLM API
    // 使用 orderedEntries 保证顺序稳定，不因 Map 内部实现而变化
    getToolDefinitions() {
      // 从有序数组中提取每个工具的定义部分，转为纯定义数组返回
      return orderedEntries.map((t) => t.definition);
    },

    // 根据工具名查找执行函数，找不到返回 undefined
    getExecutor(name) {
      // 先用 Map.get 按名查找 ToolEntry，再用可选链提取 execute 函数
      return tools.get(name)?.execute;
    },
  };
}
