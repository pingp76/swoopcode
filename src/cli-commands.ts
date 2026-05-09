/**
 * cli-commands.ts — CLI 命令注册与分发
 *
 * 职责：管理 REPL 中的斜杠命令（如 /skill），提供统一的注册和分发机制。
 *
 * 为什么需要独立的命令系统？
 * - REPL 中有些操作不需要经过 LLM（如列出 skill、查看状态）
 * - 这些命令需要直接操作内部组件（SkillManager、TodoManager 等）
 * - 独立出来后，index.ts（组装根）不需要关心命令的具体实现
 *
 * 设计模式：命令注册表
 * - 每个命令用 registerCommand() 注册
 * - REPL 收到 "/" 开头的输入时，通过 dispatchCommand() 分发
 * - 未来添加新命令（如 /todo、/history）只需注册，不修改 REPL 代码
 */

import type { Logger } from "./logger.js";
import type { createSkillManager } from "./skills.js";
import type { PermissionManager, PermissionMode } from "./permission.js";
import type { MemoryManager } from "./memory.js";
import type { SessionEventBuffer } from "./session-events.js";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * CliCommand — CLI 命令接口
 *
 * 每个命令需要提供：
 * - name：命令名（如 "skill"）
 * - handler：命令执行函数
 */
export interface CliCommand {
  /** 命令名（不含前缀 "/"） */
  name: string;
  /** 命令执行函数 */
  handler: (args: string[]) => void;
}

/**
 * CliCommandRegistry — CLI 命令注册表接口
 */
export interface CliCommandRegistry {
  /** 注册一个命令 */
  register(command: CliCommand): void;
  /** 分发命令：如果匹配已注册命令则执行并返回 true，否则返回 false */
  dispatch(input: string): boolean;
}

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

/**
 * createCliCommandRegistry — 创建 CLI 命令注册表
 */
export function createCliCommandRegistry(): CliCommandRegistry {
  const commands = new Map<string, CliCommand>();

  return {
    register(command: CliCommand): void {
      commands.set(command.name, command);
    },

    dispatch(input: string): boolean {
      // 只处理 "/" 开头的输入
      if (!input.startsWith("/")) return false;

      const parts = input.trim().split(/\s+/);
      const commandName = parts[0]!.slice(1); // 去掉前缀 "/"

      const command = commands.get(commandName);
      if (!command) return false;

      // 传入参数部分（不含命令名本身）
      command.handler(parts.slice(1));
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// 具体命令实现
// ---------------------------------------------------------------------------

/**
 * createSkillCliCommand — 创建 /skill CLI 命令
 *
 * 这些命令直接操作 SkillManager，不经过 LLM：
 * - /skill list         显示已安装的 skill 列表（本地缓存）
 * - /skill load         重新扫描 skills/ 目录，更新本地缓存
 * - /skill remove <name> 删除指定 skill
 *
 * 【静态快照语义】
 * run_skill 的 tool description 是启动时的静态快照。
 * /skill load 和 /skill remove 只影响本地缓存，不更新 LLM 可见的工具定义。
 * 要让 LLM 看到新的 skill 列表，需要重启 agent。
 */
export function createSkillCliCommand(
  manager: ReturnType<typeof createSkillManager>,
  logger: Logger,
  sessionEventBuffer?: SessionEventBuffer,
): CliCommand {
  return {
    name: "skill",
    handler(args: string[]): void {
      const subcommand = args[0];

      switch (subcommand) {
        case "list": {
          const metas = manager.listMeta();
          if (metas.length === 0) {
            console.log("No skills loaded.");
          } else {
            console.log("Available skills:");
            for (const m of metas) {
              console.log(`  - ${m.name}: ${m.description}`);
            }
          }
          break;
        }
        case "load": {
          // 重新扫描 skills/ 目录
          // 注意：这只是更新本地缓存，不会更新 run_skill 的 tool description
          // LLM 看到的 skill 列表仍然是启动时的快照
          manager.scan();
          const count = manager.listMeta().length;
          logger.info("Re-scanned skills: %d loaded", count);
          console.log(`Scanned skills: ${count} skill(s) in local cache.`);
          console.log(
            "Note: the LLM's tool definition is a static snapshot from startup.",
          );
          console.log(
            "Restart the agent to update which skills the LLM can see.",
          );
          if (sessionEventBuffer) {
            sessionEventBuffer.push({
              source: "skill",
              message:
                "Skills were re-scanned. Tool definitions remain the startup snapshot. Restart or explicitly refresh the prompt snapshot if the model must see new skill metadata.",
            });
          }
          break;
        }
        case "remove": {
          const skillName = args[1];
          if (!skillName) {
            console.log("Usage: /skill remove <name>");
            break;
          }
          const removed = manager.remove(skillName);
          if (removed) {
            logger.info("Skill removed: %s", skillName);
            console.log(`Skill "${skillName}" removed.`);
          } else {
            console.log(`Skill "${skillName}" not found.`);
          }
          break;
        }
        default:
          console.log("Usage: /skill <list|load|remove <name>>");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// /mode 命令
// ---------------------------------------------------------------------------

/**
 * createModeCliCommand — 创建 /mode CLI 命令
 *
 * 切换 Agent 的运行模式：
 * - /mode        显示当前模式和用法
 * - /mode plan    切换到规划模式（只读）
 * - /mode auto    切换到自动模式（可自主执行）
 * - /mode default 切换到默认模式（敏感操作需确认）
 */
export function createModeCliCommand(
  permissionManager: PermissionManager,
  logger: Logger,
  sessionEventBuffer?: SessionEventBuffer,
): CliCommand {
  const validModes: PermissionMode[] = ["plan", "auto", "default"];

  return {
    name: "mode",
    handler(args: string[]): void {
      const subcommand = args[0];

      if (!subcommand) {
        console.log(`Current mode: ${permissionManager.getMode()}`);
        console.log("Usage: /mode <plan|auto|default>");
        return;
      }

      if (!validModes.includes(subcommand as PermissionMode)) {
        console.log(`Invalid mode: ${subcommand}`);
        console.log("Usage: /mode <plan|auto|default>");
        return;
      }

      permissionManager.setMode(subcommand as PermissionMode);
      logger.info("Mode switched to %s", subcommand);
      console.log(`Mode switched to ${subcommand}.`);

      // 向 sessionEventBuffer 推送 reminder，让下一轮 LLM 知道 mode 变化
      if (sessionEventBuffer) {
        sessionEventBuffer.push({
          source: "mode",
          message: `Mode changed to ${subcommand}. Keep all tool definitions stable; local permission checks enforce read-only behavior.`,
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// /memory 命令
// ---------------------------------------------------------------------------

/**
 * createMemoryCliCommand — 创建 /memory CLI 命令
 *
 * 直接操作 MemoryManager，不经过 LLM：
 * - /memory list          显示所有 memory 摘要
 * - /memory show <name>   显示单条 memory 完整内容
 * - /memory remove <name> 删除一条 memory
 * - /memory reload        重新扫描 memory/ 目录并重建索引
 */
export function createMemoryCliCommand(
  manager: MemoryManager,
  logger: Logger,
  sessionEventBuffer?: SessionEventBuffer,
): CliCommand {
  return {
    name: "memory",
    handler(args: string[]): void {
      const subcommand = args[0];

      switch (subcommand) {
        case "list": {
          const metas = manager.list();
          if (metas.length === 0) {
            console.log("No memories stored.");
          } else {
            console.log("Memory:");
            for (const m of metas) {
              console.log(`  - ${m.name}: ${m.description} [${m.type}]`);
            }
          }
          break;
        }
        case "show": {
          const name = args[1];
          if (!name) {
            console.log("Usage: /memory show <name>");
            break;
          }
          const entry = manager.read(name);
          if (!entry) {
            console.log(`Memory "${name}" not found.`);
          } else {
            console.log(`[${entry.meta.type}] ${entry.meta.name}`);
            console.log(`Description: ${entry.meta.description}`);
            console.log(`Created: ${entry.meta.createdAt}`);
            console.log(`Updated: ${entry.meta.updatedAt}`);
            console.log("---");
            console.log(entry.body);
          }
          break;
        }
        case "remove": {
          const name = args[1];
          if (!name) {
            console.log("Usage: /memory remove <name>");
            break;
          }
          const removed = manager.delete(name);
          if (removed) {
            logger.info("Memory removed: %s", name);
            console.log(`Memory "${name}" removed.`);
            if (sessionEventBuffer) {
              sessionEventBuffer.push({
                source: "memory",
                message: `Memory entry "${name}" was removed. The stable system prompt memory snapshot may still mention it until snapshot refresh.`,
              });
            }
          } else {
            console.log(`Memory "${name}" not found.`);
          }
          break;
        }
        case "reload": {
          manager.scan();
          manager.rebuildIndex();
          const count = manager.list().length;
          logger.info("Memory reloaded: %d entries", count);
          console.log(`Reloaded memory: ${count} entry(s).`);
          if (sessionEventBuffer) {
            sessionEventBuffer.push({
              source: "memory",
              message:
                "Memory was reloaded. The stable system prompt memory snapshot was not automatically changed. Use run_memory_list/read if latest memory matters.",
            });
          }
          break;
        }
        default:
          console.log(
            "Usage: /memory <list|show <name>|remove <name>|reload>",
          );
      }
    },
  };
}
