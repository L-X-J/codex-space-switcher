import type { CodexRuntimePlatform } from "../../../packages/shared/src/index.ts";

/**
 * 本文件定义 Codex App 平台控制层的内部接口。
 * 各平台实现共享这些最小类型，避免互相导入具体实现造成循环依赖。
 */

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
) => Promise<CommandResult>;

export type FileExists = (filePath: string) => Promise<boolean>;

export interface CodexAppControllerOptions {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  commandRunner?: CommandRunner;
  fileExists?: FileExists;
}

export interface CodexAppCapabilities {
  platform: CodexRuntimePlatform;
  canRestart: boolean;
  restartHint: string | null;
}
