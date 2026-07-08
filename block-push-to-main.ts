/**
 * Block Push to Main Extension
 *
 * GitHub の main ブランチ（および master ブランチ）への直接 push を禁止します。
 * `git push` コマンドをインターセプトし、対象が main/master の場合にブロックします。
 * git push --force, --force-with-lease も検出対象です。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // git push <remote> <branch> で main または master を push しようとしているか検出
  const pushToProtectedBranchPattern =
    /\bgit\s+push\b(?:(?!\bmain\b|\bmaster\b).)*\b(main|master)\b/;

  // git push --force / --force-with-lease を検出（force push 全般）
  const forcePushPattern = /\bgit\s+push\b.*(--force|--force-with-lease|-f)\b/;

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command as string;
    if (!command) return undefined;

    const protectedMatch = command.match(pushToProtectedBranchPattern);

    if (protectedMatch) {
      const blockedBranch = protectedMatch[1];
      const message = `🚫 GitHub の「${blockedBranch}」ブランチへの直接 push は禁止されています。別のブランチに push するか、PR を作成してください。`;

      if (ctx.hasUI) {
        ctx.ui.notify(message, "error");
      }

      return {
        block: true,
        reason: `Blocked push to protected branch: ${blockedBranch}`,
      };
    }

    // force push の警告（main/master でなくても force push は危険）
    if (forcePushPattern.test(command)) {
      if (ctx.hasUI) {
        const choice = await ctx.ui.select(
          `⚠️ Force push が検出されました:\n\n  ${command}\n\n実行しますか？`,
          ["いいえ（ブロック）", "はい（許可）"],
        );

        if (choice !== "はい（許可）") {
          return { block: true, reason: "Force push blocked by user" };
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
