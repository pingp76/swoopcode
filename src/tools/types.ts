/**
 * types.ts — 工具共享类型定义
 *
 * 职责：定义所有工具共用的类型，避免循环依赖。
 *
 * 为什么单独放在一个文件里？
 * - 之前 ToolResult 定义在 bash.ts 中，其他工具文件如果要复用就需要 import bash.ts
 * - bash.ts 又可能依赖其他工具的类型，导致循环引用
 * - 把共享类型提取到独立文件，是解决这个问题的标准做法
 */

/**
 * ToolResult — 所有工具的统一返回类型
 *
 * 每个工具执行后都返回这个结构：
 * - output：执行结果（成功时为输出内容，失败时为错误信息）
 * - error：是否发生了错误
 *
 * 统一返回类型的好处：
 * - Agent 循环不需要为每个工具写不同的处理逻辑
 * - 工具注册表的 executor 类型签名统一
 *
 * 设计注意点：
 * - 普通参数错误、业务拒绝、找不到资源，应该返回 { error: true }
 *   让 LLM 在下一轮看到错误并修正参数。
 * - 真正的程序 bug、不可恢复初始化错误，才应该抛异常。
 *
 * 常见坑：工具里随手 throw 参数错误。
 * 这样会跳出 tool_result 协议，Agent 可能无法给对应 tool_call 写回结果，
 * 进而破坏下一次 LLM 请求的 tool_call/tool_result 配对。
 */
export interface ToolResult {
  /** 工具执行的输出内容或错误信息 */
  output: string;
  /** 是否发生了错误 */
  error: boolean;
}
