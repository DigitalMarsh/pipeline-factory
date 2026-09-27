/**
 * 模块职责：Project 目录与配置的输入 schema（创建 / 更新 / 校验 / 选择 Explorer）。
 *
 * 维护提示：**这里只做形状校验，不做业务规则。** 与版本号、路径、归档状态有关的判断一律
 *   在 `ProjectService` 里（`expectedConfigVersion` 就是典型：schema 只管它是个正整数，
 *   "版本不匹配要 409"是 Service 的决定）。把业务规则写进 schema 会让同一条规则出现两处。
 */
import { z } from "zod";

export const projectCreateBody = z.object({
  id: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(200),
  shortName: z.string().trim().max(100).optional(),
  repoRoot: z.string().trim().min(1),
  defaultBranch: z.string().trim().min(1).optional(),
  worktreeRoot: z.string().trim().min(1).optional(),
  settings: z.record(z.unknown()).optional(),
});

export const projectUpdateBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  shortName: z.string().trim().max(100).optional(),
  repoRoot: z.string().trim().min(1).optional(),
  defaultBranch: z.string().trim().min(1).optional(),
  worktreeRoot: z.string().trim().min(1).optional(),
  settings: z.record(z.unknown()).optional(),
  expectedConfigVersion: z.number().int().positive().optional(),
});

export const projectValidateBody = z.object({ repoRoot: z.string().trim().min(1).optional() });

export const projectSelectExplorerBody = z.object({ explorerId: z.string().trim().min(1) });
