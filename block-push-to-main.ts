/**
 * Block Push to Main Extension
 *
 * GitHub の main ブランチ（および master ブランチ）への直接 push を禁止します。
 * `git push` コマンドをインターセプトし、対象が main/master の場合にブロックします。
 * git push --force, --force-with-lease も検出対象です。
 *
 * 対応パターン:
 * - git push origin main          → ブロック
 * - git push                      → カレントブランチが main/master ならブロック
 * - git push --force origin main  → ブロック
 * - git push --force              → 確認ダイアログ
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";

const PROTECTED_BRANCHES = ["main", "master"];

export default function (pi: ExtensionAPI) {
  // git push <remote> <branch> で main または master を明示的に push しようとしているか検出
  // 注意: ブランチ名の一部として含まれる main/master は除外（例: feature/block-push-to-main）
  const explicitProtectedPushPattern =
    /\bgit\s+push\b.*(?:\s|:)(main|master)(?:\s|$)/;

  // git push --force / --force-with-lease / -f を検出（force push 全般）
  const forcePushPattern =
    /\bgit\s+push\b.*(--force\b(?!-)|--force-with-lease\b|-f\b)/;

  // ブランチ指定のない git push（暗黙的な push）かどうか
  const implicitPushPattern = /\bgit\s+push\b(?!.*\b\w+\/\w+\b)/;

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    // null チェック: input が存在しない場合のガード
    const input = event.input as { command?: string } | undefined;
    const command = input?.command;
    if (!command) return undefined;

    // 1. 明示的に main/master への push をチェック
    const protectedMatch = command.match(explicitProtectedPushPattern);
    if (protectedMatch) {
      const blockedBranch = protectedMatch[1];
      if (ctx.hasUI) {
        ctx.ui.notify(
          `🚫 GitHub の「${blockedBranch}」ブランチへの直接 push は禁止されています。別のブランチに push するか、PR を作成してください。`,
          "error",
        );
      }
      return {
        block: true,
        reason: `Blocked push to protected branch: ${blockedBranch}`,
      };
    }

    // 2. 暗黙的な git push（ブランチ指定なし）の場合、カレントブランチを確認
    if (implicitPushPattern.test(command)) {
      try {
        const currentBranch = execSync("git branch --show-current", {
          encoding: "utf-8",
          cwd: ctx.cwd,
        }).trim();

        if (PROTECTED_BRANCHES.includes(currentBranch)) {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `🚫 現在のブランチ「${currentBranch}」への暗黙的な push は禁止されています。別のブランチに切り替えるか、PR を作成してください。`,
              "error",
            );
          }
          return {
            block: true,
            reason: `Blocked implicit push to protected branch: ${currentBranch}`,
          };
        }
      } catch {
        // git コマンドが失敗した場合は安全側に倒してブロックしない
      }
    }

    // 3. force push の警告（main/master でなくても force push は危険）
    if (forcePushPattern.test(command)) {
      if (ctx.hasUI) {
        try {
          const choice = await ctx.ui.select(
            `⚠️ Force push が検出されました:\n\n  ${command}\n\n実行しますか？`,
            ["いいえ（ブロック）", "はい（許可）"],
          );

          if (choice !== "はい（許可）") {
            return { block: true, reason: "Force push blocked by user" };
          }
        } catch {
          // UI エラー時は安全側に倒してブロック
          return {
            block: true,
            reason: "Force push blocked due to UI error",
          };
        }
      } else {
        // 非インタラクティブモードでは force push をブロック
        return {
          block: true,
          reason: "Force push blocked in non-interactive mode",
        };
      }
    }

    return undefined;
  });
}
