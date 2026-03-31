import type { DashboardStatus, ServerEvent, SpaceCard, SwitchHint } from "../../../packages/shared/src/index.ts";
import { SWITCH_CANDIDATES } from "./config.ts";
import { loadCodexSession } from "./codex-session-provider.ts";
import { inspectCodexRuntime, isCodexBusy, startCodexApp, stopCodexApp } from "./codex-runtime-inspector.ts";
import { callInternalApi } from "./internal-api-client.ts";
import { log } from "./logger.ts";
import { createIdleSwitchJob, savePersistedState } from "./state-store.ts";
import { createId, formatError, sleep } from "./utils.ts";

type EventListener = (event: ServerEvent<unknown>) => void;

interface SwitchContext {
  getSpaces: () => Promise<SpaceCard[]>;
  getStatus: () => Promise<DashboardStatus>;
  setStatus: (updater: (status: DashboardStatus) => DashboardStatus) => Promise<void>;
  reloadSpaces: () => Promise<SpaceCard[]>;
}

/**
 * 本文件实现空间切换队列与编排流程。
 * 设计重点是把“切换中”“等待空闲”“自动重启”“切换后校验”都纳入一条串行流程中，避免多个点击并发冲突。
 */

export class SpaceSwitchService {
  private readonly listeners = new Set<EventListener>();

  private queue: string[] = [];

  private processing = false;

  constructor(private readonly context: SwitchContext) {}

  /**
   * 订阅切换与状态相关的 SSE 事件。
   *
   * @param listener 事件监听器。
   * @returns 取消订阅函数。
   */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 提交一个空间切换请求。
   *
   * @param targetSpaceId 目标空间 ID。
   * @returns 队列结果：排队、立即执行或拒绝。
   */
  async enqueue(targetSpaceId: string): Promise<"queued" | "switching" | "rejected"> {
    const spaces = await this.context.getSpaces();
    const targetSpace = spaces.find((space) => space.id === targetSpaceId);
    const activeSpace = spaces.find((space) => space.isActive);

    if (!targetSpace) {
      return "rejected";
    }

    if (activeSpace?.id === targetSpaceId) {
      return "rejected";
    }

    if (!this.queue.includes(targetSpaceId)) {
      this.queue.push(targetSpaceId);
    }

    const now = new Date().toISOString();
    await this.context.setStatus((status) => ({
      ...status,
      switchJob: {
        id: createId(),
        targetSpaceId,
        targetSpaceName: targetSpace.name,
        stage: this.processing ? "queued" : "preparing",
        message: this.processing
          ? "Codex 当前仍在忙碌，切换任务已进入等待队列。"
          : "切换任务已创建，准备开始执行。",
        createdAt: now,
        updatedAt: now,
        error: null,
      },
    }));

    this.emit({
      type: "switch.queued",
      payload: {
        targetSpaceId,
        targetSpaceName: targetSpace.name,
      },
    });

    void this.processQueue();
    return this.processing ? "queued" : "switching";
  }

  /**
   * 串行处理队列中的切换任务。
   *
   * @returns 无返回值。
   */
  async processQueue(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const nextTargetId = this.queue[0]!;
        try {
          await this.performSwitch(nextTargetId);
        } catch (error) {
          const spaces = await this.context.getSpaces();
          const target =
            spaces.find((space) => space.id === nextTargetId) ?? null;
          const message = `切换执行失败：${formatError(error)}`;

          if (target) {
            await this.failSwitch(target, message);
          }

          log("error", "空间切换任务失败", {
            targetSpaceId: nextTargetId,
            error: formatError(error),
          });
        }
        this.queue = this.queue.filter((item) => item !== nextTargetId);
      }
    } finally {
      this.processing = false;
      const status = await this.context.getStatus();
      if (
        status.switchJob.stage === "completed" ||
        status.switchJob.stage === "failed"
      ) {
        await this.context.setStatus((current) => ({
          ...current,
          switchJob: createIdleSwitchJob(),
        }));
      }
    }
  }

  /**
   * 执行一次完整的切换流程。
   *
   * @param targetSpaceId 目标空间 ID。
   * @returns 无返回值。
   */
  private async performSwitch(targetSpaceId: string): Promise<void> {
    const spaces = await this.context.getSpaces();
    const target = spaces.find((space) => space.id === targetSpaceId);

    if (!target) {
      throw new Error(`找不到目标空间：${targetSpaceId}`);
    }

    await this.waitUntilIdle(target);
    await this.updateSwitchJob("switching", target, "开始调用空间切换适配器。");
    this.emit({
      type: "switch.started",
      payload: {
        targetSpaceId: target.id,
        targetSpaceName: target.name,
      },
    });

    await this.trySwitchTarget(target);
    await this.updateSwitchJob("restart_started", target, "切换请求已发出，准备重启 Codex Desktop。");
    this.emit({
      type: "switch.restart_started",
      payload: {
        targetSpaceId: target.id,
        targetSpaceName: target.name,
      },
    });

    await stopCodexApp();
    await sleep(1200);
    await startCodexApp();
    await sleep(2000);

    await this.updateSwitchJob("verifying", target, "Codex Desktop 已重启，正在校验新空间是否生效。");
    const refreshedSpaces = await this.context.reloadSpaces();
    const verified = refreshedSpaces.find((space) => space.id === target.id)?.isActive;

    if (!verified) {
      const message = "切换后校验失败：重启后未发现目标空间成为当前激活空间。";
      await this.failSwitch(target, message);
      return;
    }

    await this.context.setStatus((status) => ({
      ...status,
      activeSpaceId: target.id,
      activeSpaceName: target.name,
      lastSwitchResult: `已切换到 ${target.name}，并完成 Codex Desktop 自动重启。`,
      switchJob: {
        ...status.switchJob,
        stage: "completed",
        message: `已完成切换：${target.name}`,
        updatedAt: new Date().toISOString(),
        error: null,
      },
    }));

    const status = await this.context.getStatus();
    await savePersistedState(status);
    this.emit({
      type: "switch.verified",
      payload: {
        targetSpaceId: target.id,
        targetSpaceName: target.name,
      },
    });
  }

  /**
   * 等待 Codex 进入空闲状态。
   *
   * @param target 目标空间。
   * @returns 无返回值。
   */
  private async waitUntilIdle(target: SpaceCard): Promise<void> {
    while (await isCodexBusy()) {
      await this.updateSwitchJob(
        "queued",
        target,
        "Codex 当前仍有活跃任务，切换请求已排队，等待空闲后继续。",
      );
      await sleep(2500);
    }
  }

  /**
   * 尝试使用显式提示或默认候选接口切换空间。
   *
   * @param target 目标空间。
   * @returns 无返回值。
   * @throws 当所有切换候选都失败时抛出异常。
   */
  private async trySwitchTarget(target: SpaceCard): Promise<void> {
    const session = await loadCodexSession();
    const explicitHints = this.collectSwitchHints(target);

    for (const hint of explicitHints) {
      const response = await callInternalApi(session, hint.path, {
        method: hint.method,
        body: JSON.stringify(hint.body),
      });

      if (response.ok) {
        log("info", "空间切换命中显式提示", {
          targetSpaceId: target.id,
          path: hint.path,
        });
        return;
      }
    }

    for (const candidate of SWITCH_CANDIDATES) {
      const response = await callInternalApi(session, candidate.path, {
        method: candidate.method,
        body: JSON.stringify({
          [candidate.bodyKey]: target.id,
        }),
      });

      if (response.ok) {
        log("info", "空间切换命中默认候选", {
          targetSpaceId: target.id,
          path: candidate.path,
          status: response.status,
        });
        return;
      }
    }

    throw new Error(
      `所有切换候选均失败，目标空间 ${target.name} (${target.id}) 当前无法自动切换。`,
    );
  }

  /**
   * 汇总一个空间的切换提示。
   *
   * @param target 目标空间。
   * @returns 显式提示数组。
   */
  private collectSwitchHints(target: SpaceCard): SwitchHint[] {
    const diagnostics = target.rawDiagnostics.join("\n");
    const hints: SwitchHint[] = [];

    if (
      "switchHints" in target &&
      Array.isArray(
        (target as SpaceCard & { switchHints?: SwitchHint[] }).switchHints,
      )
    ) {
      hints.push(
        ...(
          (target as SpaceCard & { switchHints?: SwitchHint[] }).switchHints ??
          []
        ),
      );
    }

    if (diagnostics.includes("/backend-api/accounts/switch")) {
      hints.push({
        method: "POST",
        path: "/backend-api/accounts/switch",
        body: { account_id: target.id },
      });
    }

    return hints;
  }

  /**
   * 把当前切换任务更新到指定阶段。
   *
   * @param stage 目标阶段。
   * @param target 目标空间。
   * @param message 状态文案。
   * @returns 无返回值。
   */
  private async updateSwitchJob(
    stage: DashboardStatus["switchJob"]["stage"],
    target: SpaceCard,
    message: string,
  ): Promise<void> {
    await this.context.setStatus((status) => ({
      ...status,
      switchJob: {
        ...status.switchJob,
        targetSpaceId: target.id,
        targetSpaceName: target.name,
        stage,
        message,
        updatedAt: new Date().toISOString(),
      },
    }));
  }

  /**
   * 将一次切换标记为失败，并广播失败事件。
   *
   * @param target 目标空间。
   * @param message 失败说明。
   * @returns 无返回值。
   */
  private async failSwitch(target: SpaceCard, message: string): Promise<void> {
    await this.context.setStatus((status) => ({
      ...status,
      lastSwitchResult: message,
      switchJob: {
        ...status.switchJob,
        targetSpaceId: target.id,
        targetSpaceName: target.name,
        stage: "failed",
        message,
        updatedAt: new Date().toISOString(),
        error: message,
      },
    }));

    const status = await this.context.getStatus();
    await savePersistedState(status);
    this.emit({
      type: "switch.failed",
      payload: {
        targetSpaceId: target.id,
        targetSpaceName: target.name,
        message,
      },
    });
  }

  /**
   * 对外广播一个服务端事件。
   *
   * @param event 事件对象。
   * @returns 无返回值。
   */
  private emit(event: ServerEvent<unknown>): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
